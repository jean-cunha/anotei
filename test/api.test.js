const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { criarServico, normalizarWhatsapp } = require('../src/pedidos');
const { criarApp } = require('../src/app');
const { agora, HORA } = require('../src/tempo');

let servidor;
let base;
let cookie = '';

async function chamar(caminho, { method = 'GET', body, semCabecalho = false, semCookie = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && !semCabecalho) headers['X-Requested-With'] = 'fetch';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie && !semCookie) headers.Cookie = cookie;
  const r = await fetch(base + caminho, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const set = r.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : await r.text();
  return { status: r.status, dados, r };
}

const pedidoValido = () => ({
  cliente: 'Maria Souza',
  whatsapp: '(31) 98888-7777',
  prazo: agora(48 * HORA).slice(0, 16),
  valorPago: 5,
  observacao: 'Frente e verso',
  itens: [
    { descricao: 'Xerox', quantidade: 10, precoUnitario: 0.3 },
    { descricao: 'Encadernação espiral', quantidade: 1, precoUnitario: 8 },
  ],
});

before(async () => {
  const db = abrirBanco(':memory:');
  const servico = criarServico(db, { nomeLoja: 'Papelaria Teste' });
  const app = criarApp({ servico, usuario: 'balcao', senha: 'segredo-teste', segredo: 'chave-teste', producao: false });
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

test('normaliza WhatsApp em vários formatos', () => {
  assert.equal(normalizarWhatsapp('(31) 98888-7777'), '5531988887777');
  assert.equal(normalizarWhatsapp('+55 31 3592-1100'), '553135921100');
  assert.throws(() => normalizarWhatsapp('9999-0000'));
});

test('sem login: API responde 401 e a página manda para o login', async () => {
  assert.equal((await chamar('/api/pedidos')).status, 401);
  const pagina = await chamar('/');
  assert.equal(pagina.status, 302);
  assert.equal(pagina.r.headers.get('location'), '/login.html');
  assert.equal((await chamar('/login.html')).status, 200);
});

test('login recusa senha errada e aceita a certa', async () => {
  assert.equal((await chamar('/api/login', { method: 'POST', body: { usuario: 'balcao', senha: 'x' } })).status, 401);
  const ok = await chamar('/api/login', { method: 'POST', body: { usuario: 'balcao', senha: 'segredo-teste' } });
  assert.equal(ok.status, 200);
  assert.ok(cookie.includes('sessao='));
  assert.equal((await chamar('/')).status, 200);
});

test('alteração sem o cabeçalho do front é recusada (CSRF)', async () => {
  const r = await chamar('/api/pedidos', { method: 'POST', body: pedidoValido(), semCabecalho: true });
  assert.equal(r.status, 403);
});

test('fluxo completo do pedido', async () => {
  const criado = await chamar('/api/pedidos', { method: 'POST', body: pedidoValido() });
  assert.equal(criado.status, 201, JSON.stringify(criado.dados));
  const p = criado.dados;
  assert.equal(p.total, 11);
  assert.equal(p.restante, 6);
  assert.equal(p.whatsapp, '5531988887777');
  assert.equal(p.status, 'RECEBIDO');
  assert.equal(p.avisado, false);
  assert.match(p.mensagemAtual, /^Olá, Maria! Recebemos seu pedido nº \d{4} na Papelaria Teste/);
  assert.ok(p.linkWhatsapp.startsWith('https://wa.me/5531988887777?text=Ol%C3%A1'));

  const avisado = await chamar(`/api/pedidos/${p.id}/avisos`, { method: 'POST', body: {} });
  assert.equal(avisado.dados.avisado, true);

  const prod = await chamar(`/api/pedidos/${p.id}/avancar`, { method: 'POST' });
  assert.equal(prod.dados.status, 'EM_PRODUCAO');
  assert.equal(prod.dados.avisado, false, 'nova etapa pede novo aviso');

  const pronto = await chamar(`/api/pedidos/${p.id}/avancar`, { method: 'POST' });
  assert.match(pronto.dados.mensagemAtual, /Valor a pagar na retirada: R\$ 6,00\./);

  const quitado = await chamar(`/api/pedidos/${p.id}/quitar`, { method: 'POST' });
  assert.equal(quitado.dados.restante, 0);
  assert.doesNotMatch(quitado.dados.mensagemAtual, /Valor a pagar/);

  const entregue = await chamar(`/api/pedidos/${p.id}/avancar`, { method: 'POST' });
  assert.equal(entregue.dados.status, 'ENTREGUE');
  const depois = await chamar(`/api/pedidos/${p.id}/avancar`, { method: 'POST' });
  assert.equal(depois.status, 422);

  const voltar = await chamar(`/api/pedidos/${p.id}/status`, { method: 'PATCH', body: { status: 'PRONTO' } });
  assert.equal(voltar.dados.status, 'PRONTO');
  assert.equal(voltar.dados.avisado, false, 'o único aviso foi da etapa Recebido');
});

test('validações devolvem mensagem clara', async () => {
  const semItens = await chamar('/api/pedidos', { method: 'POST', body: { ...pedidoValido(), itens: [] } });
  assert.equal(semItens.status, 400);
  assert.equal(semItens.dados.erro, 'Adicione pelo menos um item.');

  const pagoDemais = await chamar('/api/pedidos', { method: 'POST', body: { ...pedidoValido(), valorPago: 50 } });
  assert.equal(pagoDemais.dados.erro, 'O valor pago não pode ser maior que o total do pedido.');

  const prazoRuim = await chamar('/api/pedidos', { method: 'POST', body: { ...pedidoValido(), prazo: '2026-02-30T10:00' } });
  assert.equal(prazoRuim.status, 400);

  const naoExiste = await chamar('/api/pedidos/99999');
  assert.equal(naoExiste.status, 404);
});

test('editar, buscar, resumo, planilha e exclusão', async () => {
  const { dados: p } = await chamar('/api/pedidos', { method: 'POST', body: { ...pedidoValido(), cliente: 'João Pedro "Jota"' } });
  const editado = await chamar(`/api/pedidos/${p.id}`, {
    method: 'PUT',
    body: { ...pedidoValido(), cliente: '=João Pedro', itens: [{ descricao: 'Plastificação A4', quantidade: 2, precoUnitario: 5 }] },
  });
  assert.equal(editado.dados.total, 10);
  assert.equal(editado.dados.itens.length, 1);

  assert.ok((await chamar('/api/pedidos?busca=joão')).dados.some((x) => x.id === p.id));
  assert.ok((await chamar(`/api/pedidos?busca=${p.numero}`)).dados.some((x) => x.id === p.id));
  assert.ok((await chamar('/api/pedidos?busca=98888')).dados.length >= 1);

  const resumo = await chamar('/api/resumo');
  assert.equal(resumo.dados.nomeLoja, 'Papelaria Teste');
  assert.ok(resumo.dados.emAberto >= 1);

  const csv = await chamar('/api/exportar/pedidos.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.dados.includes('"\'=João Pedro"'), 'célula que parece fórmula ganha apóstrofo');

  assert.equal((await chamar(`/api/pedidos/${p.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await chamar(`/api/pedidos/${p.id}`)).status, 404);
});

test('modelos de mensagem podem ser editados', async () => {
  const lista = (await chamar('/api/modelos')).dados;
  assert.equal(lista.length, 4);
  const salvo = await chamar('/api/modelos', { method: 'PUT', body: [{ status: 'PRONTO', texto: 'Oi {nome}, pedido {num} pronto!' }] });
  assert.equal(salvo.dados.find((m) => m.status === 'PRONTO').texto, 'Oi {nome}, pedido {num} pronto!');
  const vazio = await chamar('/api/modelos', { method: 'PUT', body: [{ status: 'PRONTO', texto: '  ' }] });
  assert.equal(vazio.status, 400);
});

test('logout encerra a sessão', async () => {
  await chamar('/api/logout', { method: 'POST' });
  assert.equal((await chamar('/api/pedidos')).status, 401);
});
