'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const ETAPAS = [
    { k: 'RECEBIDO', t: 'Recebido' },
    { k: 'EM_PRODUCAO', t: 'Em produção' },
    { k: 'PRONTO', t: 'Pronto p/ retirada' },
    { k: 'ENTREGUE', t: 'Entregue' },
  ];
  // Preços de exemplo: ajuste para a tabela da loja
  const SERVICOS = [['Impressão P&B', 0.5], ['Impressão colorida', 2], ['Xerox', 0.3], ['Encadernação espiral', 8], ['Plastificação A4', 5], ['Lista de material escolar', 0]];

  /** "2026-11-25T14:00:00" -> "qua 25/11 14:00" (o horário já vem no fuso da loja) */
  function fmt(s) {
    if (!s) return '';
    const [d, h] = s.split('T');
    const [a, m, dd] = d.split('-');
    return `${DIAS[new Date(Date.UTC(+a, +m - 1, +dd)).getUTCDay()]} ${dd}/${m} ${h.slice(0, 5)}`;
  }
  function fone(d) {
    const n = String(d).replace(/^55/, '');
    return n.length === 11 ? `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}` : `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  }
  const waLink = (tel, txt) => `https://wa.me/${tel}?text=${encodeURIComponent(txt)}`;

  async function api(url, { method = 'GET', body } = {}) {
    const o = { method, headers: { Accept: 'application/json' } };
    if (method !== 'GET') o.headers['X-Requested-With'] = 'fetch';
    if (body !== undefined) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(body);
    }
    const r = await fetch(url, o);
    if (r.status === 401) {
      location.href = '/login.html';
      throw new Error('Sessão expirada. Entre de novo.');
    }
    if (r.status === 204) return null;
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error((d && d.erro) || `Erro ${r.status}`);
    return d;
  }

  function toast(t, mal = false) {
    const e = $('#toast');
    e.textContent = t;
    e.classList.toggle('mal', mal);
    e.classList.add('on');
    clearTimeout(e.tempo);
    e.tempo = setTimeout(() => e.classList.remove('on'), mal ? 4000 : 2400);
  }
  const falhou = (e) => toast(e.message || 'Algo deu errado.', true);

  let pedidos = [];
  let editando = null;
  let detalheId = null;

  // ------------------------------------------------------------ Quadro
  async function carregar() {
    const q = $('#busca').value.trim();
    const [lista, resumo] = await Promise.all([
      api(`/api/pedidos${q ? `?busca=${encodeURIComponent(q)}` : ''}`),
      api('/api/resumo'),
    ]);
    pedidos = lista;
    desenhar(resumo);
  }
  const recarregar = () => carregar().catch(falhou);

  function cartao(p) {
    const pend = !p.avisado && p.status !== 'ENTREGUE';
    return `<article class="card${p.atrasado ? ' late' : ''}" data-id="${p.id}">
      ${pend ? '<span class="pend">aviso pendente</span>' : ''}
      <div class="top"><span class="num">nº ${esc(p.numero)}</span><span class="prazo">${p.atrasado ? 'Atrasado · ' : ''}${esc(fmt(p.prazo))}</span></div>
      <p class="nome">${esc(p.cliente)}</p>
      <p class="itens">${esc(p.itens.map((i) => `${i.quantidade}× ${i.descricao}`).join(', '))}</p>
      <span class="val">${brl(p.total)} · ${p.restante > 0 ? `falta ${brl(p.restante)}` : 'pago'}</span>
      <div class="acts">
        ${pend ? `<a class="btn wa" href="${esc(p.linkWhatsapp)}" target="_blank" rel="noopener" data-avisa="${p.id}">Avisar no WhatsApp</a>` : (p.status !== 'ENTREGUE' ? '<span class="ok">Cliente avisado ✓</span>' : '')}
        ${p.proximoStatus ? `<button class="btn" type="button" data-next="${p.id}">${esc(p.proximoRotulo)} →</button>` : ''}
      </div>
    </article>`;
  }

  function desenhar(r) {
    $('#board').innerHTML = ETAPAS.map((s) => {
      const todos = pedidos.filter((p) => p.status === s.k);
      let lista = todos;
      if (s.k === 'ENTREGUE') lista = [...todos].sort((a, b) => (a.prazo < b.prazo ? 1 : -1)).slice(0, 10);
      return `<section class="col"><h2>${s.t}<span>${todos.length}</span></h2>${lista.map(cartao).join('') || '<p class="vazio">Nenhum pedido aqui.</p>'}</section>`;
    }).join('');
    const F = [
      ['Em aberto', r.emAberto], ['Prontos p/ retirar', r.prontos], ['Atrasados', r.atrasados, 1],
      ['Avisos pendentes', r.avisosPendentes, 1], ['A receber', brl(r.aReceber)],
    ];
    $('#figs').innerHTML = F.map(([t, v, al]) => `<div class="fg${al && v ? ' al' : ''}"><b>${esc(v)}</b><span>${t}</span></div>`).join('');
    $('#lojaNome').textContent = r.nomeLoja;
    document.title = `Balcão · ${r.nomeLoja}`;
    $('#amostra').hidden = !pedidos.some((p) => p.exemplo);
  }

  // ------------------------------------------------------------ Painéis
  const abrir = (id) => $(id).classList.add('on');
  function fecharTudo() {
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('on'));
    detalheId = null;
  }

  // ------------------------------------------------------------ Formulário
  function linhaItem(i = { descricao: '', quantidade: 1, precoUnitario: 0 }) {
    const r = document.createElement('div');
    r.className = 'it';
    r.innerHTML = '<input aria-label="Item" placeholder="Item" class="iD" maxlength="120">'
      + '<input aria-label="Quantidade" type="number" min="1" step="1" inputmode="numeric" class="iQ">'
      + '<input aria-label="Preço unitário em reais" type="number" min="0" step="0.01" inputmode="decimal" class="iP">'
      + '<button type="button" aria-label="Remover item">✕</button>';
    r.querySelector('.iD').value = i.descricao;
    r.querySelector('.iQ').value = i.quantidade;
    r.querySelector('.iP').value = i.precoUnitario;
    r.querySelector('button').addEventListener('click', () => { r.remove(); totais(); });
    $('#itens').appendChild(r);
    totais();
  }
  function lerItens() {
    return [...document.querySelectorAll('#itens .it')].map((r) => ({
      descricao: r.querySelector('.iD').value.trim(),
      quantidade: Number(r.querySelector('.iQ').value),
      precoUnitario: Number(r.querySelector('.iP').value || 0),
    })).filter((i) => i.descricao);
  }
  function totais() {
    const total = lerItens().reduce((s, i) => s + (i.quantidade || 0) * (i.precoUnitario || 0), 0);
    const pago = Number($('#fPago').value) || 0;
    $('#fTot').innerHTML = `<span>Total</span><b>${brl(total)}</b><span>Já pago</span><b>${brl(pago)}</b><span>Falta pagar</span><b>${brl(Math.max(0, total - pago))}</b>`;
  }
  function prazoPadrao() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(14, 0, 0, 0);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  function abrirForm(p) {
    editando = p || null;
    $('#fTit').textContent = p ? `Editar pedido nº ${p.numero}` : 'Novo pedido';
    $('#fErr').textContent = '';
    $('#fNome').value = p ? p.cliente : '';
    $('#fFone').value = p ? fone(p.whatsapp) : '';
    $('#fPago').value = p ? p.valorPago : 0;
    $('#fObs').value = p ? (p.observacao || '') : '';
    $('#fPrazo').value = p ? p.prazo.slice(0, 16) : prazoPadrao();
    $('#itens').innerHTML = '';
    if (p) p.itens.forEach(linhaItem);
    totais();
    fecharTudo();
    abrir('#sForm');
    setTimeout(() => $('#fNome').focus(), 50);
  }

  $('#presets').innerHTML = SERVICOS.map((s, i) => `<button type="button" class="chip" data-p="${i}">${esc(s[0])}${s[1] ? ` · ${brl(s[1])}` : ''}</button>`).join('');
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (b) {
      const [descricao, precoUnitario] = SERVICOS[b.dataset.p];
      linhaItem({ descricao, quantidade: 1, precoUnitario });
    }
  });
  $('#addIt').addEventListener('click', () => {
    linhaItem();
    const linhas = document.querySelectorAll('#itens .iD');
    linhas[linhas.length - 1].focus();
  });
  $('#form').addEventListener('input', totais);
  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const corpo = {
      cliente: $('#fNome').value,
      whatsapp: $('#fFone').value,
      prazo: $('#fPrazo').value,
      valorPago: Number($('#fPago').value) || 0,
      observacao: $('#fObs').value,
      itens: lerItens(),
    };
    const botao = $('#fSalvar');
    botao.disabled = true;
    try {
      const p = editando
        ? await api(`/api/pedidos/${editando.id}`, { method: 'PUT', body: corpo })
        : await api('/api/pedidos', { method: 'POST', body: corpo });
      fecharTudo();
      toast(editando ? 'Pedido atualizado.' : `Pedido nº ${p.numero} criado. Envie a confirmação ao cliente.`);
      await carregar();
    } catch (erro) {
      $('#fErr').textContent = erro.message;
    } finally {
      botao.disabled = false;
    }
  });

  // ------------------------------------------------------------ Detalhe
  async function abrirDetalhe(id) {
    let p;
    try { p = await api(`/api/pedidos/${id}`); } catch (e) { falhou(e); return; }
    detalheId = id;
    const jaAvisado = p.avisado;
    $('#det').innerHTML = `
      <div class="ph"><div><span class="num">nº ${esc(p.numero)}</span>
        <h3 class="nome-det">${esc(p.cliente)}</h3>
        <p class="hint">${esc(fone(p.whatsapp))} · prazo ${esc(fmt(p.prazo))}${p.atrasado ? ' · <span class="atraso">atrasado</span>' : ''}</p></div>
        <button class="btn" type="button" data-close>Fechar</button></div>
      <table>${p.itens.map((i) => `<tr><td>${esc(i.quantidade)}× ${esc(i.descricao)}</td><td>${brl(i.subtotal)}</td></tr>`).join('')}</table>
      ${p.observacao ? `<p><b>Obs.:</b> ${esc(p.observacao)}</p>` : ''}
      <div class="tot"><span>Total</span><b>${brl(p.total)}</b><span>Pago</span><b>${brl(p.valorPago)}</b><span>Falta</span><b>${brl(p.restante)}</b></div>
      ${p.restante > 0 ? '<button class="btn" type="button" id="dPago">Registrar pagamento do restante</button>' : ''}
      <div><p class="hint">Situação</p><div class="chips">${ETAPAS.map((s) => `<button type="button" class="chip${s.k === p.status ? ' on' : ''}" data-st="${s.k}">${s.t}</button>`).join('')}</div></div>
      <label>Mensagem para o cliente (${esc(p.statusRotulo.toLowerCase())})<textarea id="dMsg" maxlength="1000"></textarea></label>
      <div class="acts"><a class="btn wa" id="dWa" target="_blank" rel="noopener">${jaAvisado ? 'Enviar de novo no WhatsApp' : 'Enviar no WhatsApp'}</a>
        <button class="btn" type="button" id="dCopy">Copiar mensagem</button></div>
      ${p.avisos.length ? `<div><p class="hint">Avisos enviados</p><ul class="hist">${p.avisos.map((a) => `<li>${esc(a.statusRotulo)} · ${esc(fmt(a.enviadoEm))}</li>`).join('')}</ul></div>` : ''}
      <div class="acts"><button class="btn" type="button" id="dEdit">Editar pedido</button><button class="btn danger" type="button" id="dDel">Excluir</button></div>`;

    const msg = $('#dMsg');
    const link = $('#dWa');
    msg.value = p.mensagemAtual;
    const atualizarLink = () => { link.href = waLink(p.whatsapp, msg.value); };
    atualizarLink();
    msg.addEventListener('input', atualizarLink);

    link.addEventListener('click', () => {
      api(`/api/pedidos/${p.id}/avisos`, { method: 'POST', body: { mensagem: msg.value } })
        .then(() => { toast('Aviso registrado.'); recarregar(); setTimeout(() => detalheId === p.id && abrirDetalhe(p.id), 400); })
        .catch(falhou);
    });
    $('#dCopy').addEventListener('click', () => {
      navigator.clipboard.writeText(msg.value).then(() => toast('Mensagem copiada.'), () => { msg.select(); toast('Selecione e copie o texto.'); });
    });
    const pago = $('#dPago');
    if (pago) {
      pago.addEventListener('click', async () => {
        try { await api(`/api/pedidos/${p.id}/quitar`, { method: 'POST' }); toast('Pagamento registrado.'); recarregar(); abrirDetalhe(p.id); } catch (e) { falhou(e); }
      });
    }
    $('#det').querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.st === p.status) return;
      try {
        await api(`/api/pedidos/${p.id}/status`, { method: 'PATCH', body: { status: b.dataset.st } });
        toast('Situação alterada. Avise o cliente.');
        recarregar();
        abrirDetalhe(p.id);
      } catch (e) { falhou(e); }
    }));
    $('#dEdit').addEventListener('click', () => abrirForm(p));
    const del = $('#dDel');
    del.addEventListener('click', async () => {
      if (!del.dataset.confirma) {
        del.dataset.confirma = '1';
        del.textContent = 'Toque de novo para excluir';
        return;
      }
      try { await api(`/api/pedidos/${p.id}`, { method: 'DELETE' }); fecharTudo(); toast('Pedido excluído.'); recarregar(); } catch (e) { falhou(e); }
    });
    abrir('#sDet');
  }

  // ------------------------------------------------------------ Configurações
  async function abrirConfig() {
    $('#cErr').textContent = '';
    try {
      const modelos = await api('/api/modelos');
      $('#tpls').innerHTML = modelos.map((m) => `<label>Ao marcar "${esc(m.rotulo)}"<textarea data-t="${esc(m.status)}" maxlength="1000">${esc(m.texto)}</textarea></label>`).join('');
      fecharTudo();
      abrir('#sCfg');
    } catch (e) { falhou(e); }
  }
  $('#cSalvar').addEventListener('click', async () => {
    const lista = [...document.querySelectorAll('[data-t]')].map((t) => ({ status: t.dataset.t, texto: t.value }));
    try {
      await api('/api/modelos', { method: 'PUT', body: lista });
      $('#cErr').textContent = '';
      toast('Mensagens salvas.');
      recarregar();
    } catch (e) { $('#cErr').textContent = e.message; }
  });
  $('#cEx').addEventListener('click', async () => {
    try {
      const r = await api('/api/pedidos/exemplos', { method: 'DELETE' });
      toast(`${r.apagados} pedido(s) de exemplo apagado(s).`);
      recarregar();
    } catch (e) { falhou(e); }
  });

  // ------------------------------------------------------------ Eventos gerais
  $('#novo').addEventListener('click', () => abrirForm());
  $('#cfg').addEventListener('click', abrirConfig);
  $('#sair').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* segue para o login */ }
    location.href = '/login.html';
  });
  let espera;
  $('#busca').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(recarregar, 250); });

  $('#board').addEventListener('click', async (e) => {
    const aviso = e.target.closest('[data-avisa]');
    if (aviso) {
      // O link abre o WhatsApp; aqui só registramos que o aviso foi enviado
      const p = pedidos.find((x) => x.id === Number(aviso.dataset.avisa));
      api(`/api/pedidos/${aviso.dataset.avisa}/avisos`, { method: 'POST', body: { mensagem: p ? p.mensagemAtual : '' } })
        .then(recarregar).catch(falhou);
      return;
    }
    const prox = e.target.closest('[data-next]');
    if (prox) {
      prox.disabled = true;
      try {
        const p = await api(`/api/pedidos/${prox.dataset.next}/avancar`, { method: 'POST' });
        toast(`Pedido nº ${p.numero}: ${p.statusRotulo}. Avise o cliente.`);
        await carregar();
      } catch (erro) { falhou(erro); prox.disabled = false; }
      return;
    }
    const c = e.target.closest('.card');
    if (c) abrirDetalhe(Number(c.dataset.id));
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.classList.contains('sheet')) fecharTudo();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharTudo(); });

  // Atualiza sozinho para quem usa em mais de um aparelho (balcão e produção)
  setInterval(() => { if (!document.hidden) recarregar(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recarregar(); });

  recarregar();
})();
