const { STATUS } = require('./db');
const { agora, normalizarDataHora, formatarPrazo, formatarDataHora, HORA } = require('./tempo');

const ROTULOS = {
  RECEBIDO: 'Recebido',
  EM_PRODUCAO: 'Em produção',
  PRONTO: 'Pronto p/ retirada',
  ENTREGUE: 'Entregue',
};

const MODELOS_PADRAO = {
  RECEBIDO:
    'Olá, {nome}! Recebemos seu pedido nº {num} na {loja}: {itens}. Total {total}. '
    + 'Previsão de entrega: {prazo}. Avisamos por aqui quando ficar pronto.',
  EM_PRODUCAO: '{nome}, seu pedido nº {num} já está em produção. Previsão: {prazo}.',
  PRONTO:
    '{nome}, seu pedido nº {num} está pronto para retirada na {loja}! {restante}'
    + 'Funcionamos de seg a sex, 8h às 18h, e sáb, 8h às 12h.',
  ENTREGUE: 'Obrigado, {nome}! Pedido nº {num} entregue. Precisando de algo, é só chamar aqui.',
};

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const centavos = (reais) => Math.round(Number(reais) * 100);
const reais = (c) => c / 100;
const moeda = (c) => reais(c).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
const numero = (id) => String(id).padStart(4, '0');
const proximo = (status) => STATUS[STATUS.indexOf(status) + 1] || null;

/** Aceita "(31) 98888-7777", "31988887777" ou "+55 31 98888-7777" e devolve "5531988887777". */
function normalizarWhatsapp(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!d.startsWith('55') || d.length < 12 || d.length > 13) {
    throw new ErroHttp(400, 'WhatsApp inválido. Use DDD + número, ex.: (31) 98888-7777.');
  }
  return d;
}

function texto(valor, campo, max, obrigatorio = true) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (obrigatorio && !v) throw new ErroHttp(400, `Informe ${campo}.`);
  if (v.length > max) throw new ErroHttp(400, `${campo[0].toUpperCase()}${campo.slice(1)} muito longo (máx. ${max} caracteres).`);
  return v;
}

function valorEmCentavos(valor, campo) {
  const n = Number(valor);
  if (valor === '' || valor === null || valor === undefined || !Number.isFinite(n)) {
    throw new ErroHttp(400, `Valor inválido em ${campo}.`);
  }
  if (n < 0) throw new ErroHttp(400, `${campo} não pode ser negativo.`);
  if (n > 1e7) throw new ErroHttp(400, `${campo} alto demais.`);
  return centavos(n);
}

/** Valida e normaliza o corpo de criação/edição de pedido. */
function validarPedido(corpo) {
  if (!corpo || typeof corpo !== 'object') throw new ErroHttp(400, 'Dados do pedido ausentes.');
  const cliente = texto(corpo.cliente, 'o nome do cliente', 120);
  const whatsapp = normalizarWhatsapp(corpo.whatsapp);
  const prazo = normalizarDataHora(corpo.prazo);
  if (!prazo) throw new ErroHttp(400, 'Informe um prazo de entrega válido.');
  const observacao = texto(corpo.observacao, 'a observação', 500, false) || null;
  const pago = corpo.valorPago === undefined || corpo.valorPago === '' ? 0 : valorEmCentavos(corpo.valorPago, 'O valor pago');

  if (!Array.isArray(corpo.itens) || corpo.itens.length === 0) throw new ErroHttp(400, 'Adicione pelo menos um item.');
  if (corpo.itens.length > 100) throw new ErroHttp(400, 'Pedido com itens demais.');
  const itens = corpo.itens.map((i) => {
    const quantidade = Number(i?.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000) {
      throw new ErroHttp(400, 'A quantidade de cada item deve ser um número inteiro a partir de 1.');
    }
    return {
      descricao: texto(i?.descricao, 'a descrição do item', 120),
      quantidade,
      preco: valorEmCentavos(i?.precoUnitario, 'O preço do item'),
    };
  });
  const total = itens.reduce((s, i) => s + i.quantidade * i.preco, 0);
  if (pago > total) throw new ErroHttp(400, 'O valor pago não pode ser maior que o total do pedido.');
  return { cliente, whatsapp, prazo, observacao, pago, itens };
}

function criarServico(db, { nomeLoja }) {
  const sql = {
    pedido: db.prepare('SELECT * FROM pedidos WHERE id = ?'),
    todos: db.prepare('SELECT * FROM pedidos ORDER BY prazo'),
    buscar: db.prepare(`
      SELECT * FROM pedidos
      WHERE lower(cliente) LIKE '%' || lower(@texto) || '%'
         OR (@digitos <> '' AND whatsapp LIKE '%' || @digitos || '%')
         OR (@numero <> '' AND CAST(id AS TEXT) = @numero)
      ORDER BY prazo`),
    itens: db.prepare('SELECT * FROM itens_pedido WHERE pedido_id = ? ORDER BY id'),
    avisos: db.prepare('SELECT * FROM avisos_whatsapp WHERE pedido_id = ? ORDER BY enviado_em, id'),
    inserir: db.prepare(`INSERT INTO pedidos (cliente, whatsapp, prazo, valor_pago_centavos, observacao, status, criado_em, exemplo)
                         VALUES (@cliente, @whatsapp, @prazo, @pago, @observacao, @status, @criadoEm, @exemplo)`),
    atualizar: db.prepare(`UPDATE pedidos SET cliente=@cliente, whatsapp=@whatsapp, prazo=@prazo,
                           valor_pago_centavos=@pago, observacao=@observacao, exemplo=0 WHERE id=@id`),
    apagarItens: db.prepare('DELETE FROM itens_pedido WHERE pedido_id = ?'),
    inserirItem: db.prepare('INSERT INTO itens_pedido (pedido_id, descricao, quantidade, preco_centavos) VALUES (?, ?, ?, ?)'),
    status: db.prepare('UPDATE pedidos SET status = ? WHERE id = ?'),
    pago: db.prepare('UPDATE pedidos SET valor_pago_centavos = ? WHERE id = ?'),
    aviso: db.prepare('INSERT INTO avisos_whatsapp (pedido_id, status, mensagem, enviado_em) VALUES (?, ?, ?, ?)'),
    excluir: db.prepare('DELETE FROM pedidos WHERE id = ?'),
    excluirExemplos: db.prepare('DELETE FROM pedidos WHERE exemplo = 1'),
    modelo: db.prepare('SELECT texto FROM modelos_mensagem WHERE status = ?'),
    salvarModelo: db.prepare(`INSERT INTO modelos_mensagem (status, texto) VALUES (?, ?)
                              ON CONFLICT(status) DO UPDATE SET texto = excluded.texto`),
    contar: db.prepare('SELECT COUNT(*) AS n FROM pedidos'),
  };

  // Modelos padrão na primeira execução
  for (const s of STATUS) {
    if (!sql.modelo.get(s)) sql.salvarModelo.run(s, MODELOS_PADRAO[s]);
  }

  function carregar(id) {
    const p = sql.pedido.get(id);
    if (!p) throw new ErroHttp(404, `Pedido ${id} não encontrado.`);
    p.itens = sql.itens.all(id);
    p.avisos = sql.avisos.all(id);
    return p;
  }

  const totalDe = (p) => p.itens.reduce((s, i) => s + i.quantidade * i.preco_centavos, 0);
  const restanteDe = (p) => Math.max(0, totalDe(p) - p.valor_pago_centavos);
  const atrasado = (p, ag) => (p.status === 'RECEBIDO' || p.status === 'EM_PRODUCAO') && p.prazo < ag;
  const avisoAtual = (p) => p.avisos.filter((a) => a.status === p.status).pop() || null;
  const descreverItens = (p) => p.itens.map((i) => `${i.quantidade}× ${i.descricao}`).join(', ');

  function montarMensagem(p, status = p.status) {
    const modelo = sql.modelo.get(status)?.texto || MODELOS_PADRAO[status];
    const falta = restanteDe(p);
    const valores = {
      nome: p.cliente.trim().split(/\s+/)[0],
      num: numero(p.id),
      itens: descreverItens(p),
      total: moeda(totalDe(p)),
      restante: falta > 0 ? `Valor a pagar na retirada: ${moeda(falta)}. ` : '',
      prazo: formatarPrazo(p.prazo),
      loja: nomeLoja,
    };
    return modelo.replace(/\{(\w+)\}/g, (m, chave) => (chave in valores ? valores[chave] : m)).trim();
  }

  const linkWhatsapp = (telefone, msg) => `https://wa.me/${telefone}?text=${encodeURIComponent(msg)}`;

  function resposta(p, ag = agora()) {
    const total = totalDe(p);
    const aviso = avisoAtual(p);
    const mensagem = montarMensagem(p);
    const prox = proximo(p.status);
    return {
      id: p.id,
      numero: numero(p.id),
      cliente: p.cliente,
      whatsapp: p.whatsapp,
      prazo: p.prazo,
      criadoEm: p.criado_em,
      observacao: p.observacao,
      status: p.status,
      statusRotulo: ROTULOS[p.status],
      proximoStatus: prox,
      proximoRotulo: prox ? ROTULOS[prox] : null,
      total: reais(total),
      valorPago: reais(Math.min(p.valor_pago_centavos, total)),
      restante: reais(restanteDe(p)),
      atrasado: atrasado(p, ag),
      avisado: Boolean(aviso),
      avisadoEm: aviso ? aviso.enviado_em : null,
      mensagemAtual: mensagem,
      linkWhatsapp: linkWhatsapp(p.whatsapp, mensagem),
      exemplo: Boolean(p.exemplo),
      itens: p.itens.map((i) => ({
        descricao: i.descricao,
        quantidade: i.quantidade,
        precoUnitario: reais(i.preco_centavos),
        subtotal: reais(i.quantidade * i.preco_centavos),
      })),
      avisos: p.avisos.map((a) => ({ status: a.status, statusRotulo: ROTULOS[a.status], enviadoEm: a.enviado_em })),
    };
  }

  const gravarItens = (id, itens) => {
    sql.apagarItens.run(id);
    for (const i of itens) sql.inserirItem.run(id, i.descricao, i.quantidade, i.preco);
  };

  const criarTx = db.transaction((d, extras = {}) => {
    const { lastInsertRowid } = sql.inserir.run({
      ...d, status: extras.status || 'RECEBIDO', criadoEm: extras.criadoEm || agora(), exemplo: extras.exemplo ? 1 : 0,
    });
    gravarItens(lastInsertRowid, d.itens);
    return Number(lastInsertRowid);
  });

  const atualizarTx = db.transaction((id, d) => {
    sql.atualizar.run({ ...d, id });
    gravarItens(id, d.itens);
  });

  function validarStatus(status) {
    if (!STATUS.includes(status)) throw new ErroHttp(400, 'Situação inválida.');
    return status;
  }

  return {
    listar(busca) {
      const ag = agora();
      const t = typeof busca === 'string' ? busca.trim().slice(0, 100) : '';
      let linhas;
      if (!t) linhas = sql.todos.all();
      else {
        const digitos = t.replace(/\D/g, '');
        linhas = sql.buscar.all({ texto: t, digitos, numero: digitos.replace(/^0+(?=\d)/, '') });
      }
      return linhas.map((l) => resposta(carregar(l.id), ag));
    },

    buscar: (id) => resposta(carregar(id)),

    criar(corpo) {
      const id = criarTx(validarPedido(corpo));
      return resposta(carregar(id));
    },

    atualizar(id, corpo) {
      carregar(id);
      atualizarTx(id, validarPedido(corpo));
      return resposta(carregar(id));
    },

    excluir(id) {
      carregar(id);
      sql.excluir.run(id);
    },

    excluirExemplos: () => sql.excluirExemplos.run().changes,

    avancar(id) {
      const p = carregar(id);
      const prox = proximo(p.status);
      if (!prox) throw new ErroHttp(422, 'Este pedido já foi entregue.');
      sql.status.run(prox, id);
      return resposta(carregar(id));
    },

    alterarStatus(id, status) {
      carregar(id);
      sql.status.run(validarStatus(status), id);
      return resposta(carregar(id));
    },

    quitar(id) {
      const p = carregar(id);
      sql.pago.run(totalDe(p), id);
      return resposta(carregar(id));
    },

    /** Registra que o cliente foi avisado na etapa atual. Sem texto, usa a mensagem do modelo. */
    registrarAviso(id, mensagem) {
      const p = carregar(id);
      const t = typeof mensagem === 'string' && mensagem.trim()
        ? texto(mensagem, 'a mensagem', 1000)
        : montarMensagem(p);
      sql.aviso.run(id, p.status, t, agora());
      return resposta(carregar(id));
    },

    resumo() {
      const ag = agora();
      const abertos = sql.todos.all().filter((p) => p.status !== 'ENTREGUE').map((p) => carregar(p.id));
      return {
        nomeLoja,
        emAberto: abertos.length,
        prontos: abertos.filter((p) => p.status === 'PRONTO').length,
        atrasados: abertos.filter((p) => atrasado(p, ag)).length,
        avisosPendentes: abertos.filter((p) => !avisoAtual(p)).length,
        aReceber: reais(abertos.reduce((s, p) => s + restanteDe(p), 0)),
      };
    },

    modelos: () => STATUS.map((s) => ({ status: s, rotulo: ROTULOS[s], texto: sql.modelo.get(s)?.texto || MODELOS_PADRAO[s] })),

    salvarModelos(lista) {
      if (!Array.isArray(lista)) throw new ErroHttp(400, 'Envie a lista de mensagens.');
      const validos = lista.map((m) => ({ status: validarStatus(m?.status), texto: texto(m?.texto, 'a mensagem', 1000) }));
      db.transaction(() => validos.forEach((m) => sql.salvarModelo.run(m.status, m.texto)))();
      return this.modelos();
    },

    /** Planilha CSV separada por ponto e vírgula, como o Excel em português espera. */
    csv() {
      const celula = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita virar fórmula no Excel
        return `"${s.replace(/"/g, '""')}"`;
      };
      const dec = (c) => (c / 100).toFixed(2).replace('.', ',');
      const linhas = sql.todos.all().map((l) => {
        const p = carregar(l.id);
        const total = totalDe(p);
        return [numero(p.id), p.cliente, p.whatsapp, descreverItens(p), dec(total),
          dec(Math.min(p.valor_pago_centavos, total)), dec(restanteDe(p)), formatarDataHora(p.prazo),
          ROTULOS[p.status], p.observacao || '', formatarDataHora(p.criado_em)].map(celula).join(';');
      });
      return `﻿Numero;Cliente;WhatsApp;Itens;Total;Pago;Falta;Prazo;Situacao;Observacao;Criado em\n${linhas.join('\n')}\n`;
    },

    /** Pedidos de demonstração, só quando o banco está vazio. */
    criarExemplos() {
      if (sql.contar.get().n > 0) return 0;
      const ex = (cliente, whatsapp, horas, pago, status, avisado, observacao, itens) => {
        const prazo = agora(horas * HORA).slice(0, 16) + ':00';
        const id = criarTx({
          cliente, whatsapp, prazo, observacao, pago: centavos(pago),
          itens: itens.map(([descricao, quantidade, preco]) => ({ descricao, quantidade, preco: centavos(preco) })),
        }, { status, exemplo: true, criadoEm: agora(-30 * HORA) });
        if (avisado) sql.aviso.run(id, status, '(aviso de exemplo)', agora(-HORA));
      };
      db.transaction(() => {
        ex('Ana Paula Moreira', '5531988112034', 5, 30, 'RECEBIDO', false, 'TCC, capa transparente',
          [['Impressão colorida', 40, 2], ['Encadernação espiral', 1, 8]]);
        ex('Escola Pequeno Saber', '553135921100', 24, 0, 'RECEBIDO', true, 'Provas do 3º ano, grampear por turma',
          [['Xerox', 600, 0.3]]);
        ex('Marcos Vinícius', '5531997025518', -2, 20, 'EM_PRODUCAO', true, 'Apostila do concurso',
          [['Impressão P&B', 120, 0.5], ['Encadernação espiral', 2, 8]]);
        ex('Júlia Ramos', '5531984559071', 20, 100, 'EM_PRODUCAO', true, 'Lista do 5º ano',
          [['Lista de material escolar', 1, 286.9]]);
        ex('Carlos Henrique', '5531991304482', -1, 0, 'PRONTO', false, 'Certificados', [['Plastificação A4', 6, 5]]);
        ex('Fernanda Lopes', '5531982607715', -4, 24, 'PRONTO', true, null, [['Impressão colorida', 12, 2]]);
        ex('Roberto Dias', '5531999143320', -24, 15, 'ENTREGUE', true, null, [['Xerox', 50, 0.3]]);
      })();
      return 7;
    },
  };
}

module.exports = { criarServico, ErroHttp, normalizarWhatsapp, validarPedido, MODELOS_PADRAO, ROTULOS };
