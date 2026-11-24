const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { ErroHttp } = require('./pedidos');
const { agora } = require('./tempo');

const PUBLICO = path.join(__dirname, '..', 'public');
const PAGINA_SISTEMA = path.join(__dirname, 'paginas', 'index.html');

/** Compara senhas em tempo constante. */
function senhaConfere(digitada, correta) {
  const a = crypto.createHash('sha256').update(String(digitada)).digest();
  const b = crypto.createHash('sha256').update(String(correta)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Limita tentativas de login por IP: 8 erros em 15 minutos. */
function limitadorDeLogin() {
  const tentativas = new Map();
  const JANELA = 15 * 60 * 1000;
  return {
    bloqueado(ip) {
      const t = tentativas.get(ip);
      if (!t || Date.now() - t.inicio > JANELA) return false;
      return t.erros >= 8;
    },
    errou(ip) {
      const t = tentativas.get(ip);
      if (!t || Date.now() - t.inicio > JANELA) tentativas.set(ip, { inicio: Date.now(), erros: 1 });
      else t.erros += 1;
    },
    acertou: (ip) => tentativas.delete(ip),
  };
}

function criarApp({ servico, usuario, senha, segredo, producao }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway fica atrás de um proxy HTTPS

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  app.use(cookieSession({
    name: 'sessao',
    keys: [segredo],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: producao,
  }));
  app.use(express.json({ limit: '100kb' }));

  const logado = (req) => Boolean(req.session && req.session.usuario);

  app.get('/saude', (req, res) => res.json({ ok: true, horario: agora() }));

  // Página do sistema só para quem fez login
  app.get(['/', '/index.html'], (req, res) => {
    if (!logado(req)) return res.redirect('/login.html');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(PAGINA_SISTEMA);
  });
  app.get('/login.html', (req, res, next) => (logado(req) ? res.redirect('/') : next()));
  app.use(express.static(PUBLICO, { index: false, maxAge: producao ? '1h' : 0 }));

  // ------------------------------------------------------------------ API
  const api = express.Router();

  // Proteção contra CSRF: toda alteração precisa do cabeçalho que só o nosso front envia
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
      return res.status(403).json({ erro: 'Requisição recusada.' });
    }
    return next();
  });

  const limitador = limitadorDeLogin();
  api.post('/login', (req, res) => {
    const ip = req.ip;
    if (limitador.bloqueado(ip)) {
      return res.status(429).json({ erro: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
    }
    const { usuario: u, senha: s } = req.body || {};
    if (u === usuario && senhaConfere(s || '', senha)) {
      limitador.acertou(ip);
      req.session = { usuario: u, desde: Date.now() };
      return res.json({ ok: true });
    }
    limitador.errou(ip);
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  });

  api.post('/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  api.use((req, res, next) => (logado(req) ? next() : res.status(401).json({ erro: 'Faça login para continuar.' })));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const id = (req) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n < 1) throw new ErroHttp(404, 'Pedido não encontrado.');
    return n;
  };

  api.get('/sessao', (req, res) => res.json({ usuario: req.session.usuario }));
  api.get('/resumo', (req, res) => res.json(servico.resumo()));
  api.get('/modelos', (req, res) => res.json(servico.modelos()));
  api.put('/modelos', (req, res) => res.json(servico.salvarModelos(req.body)));

  api.get('/exportar/pedidos.csv', (req, res) => {
    const nome = `pedidos-${agora().slice(0, 10).replace(/-/g, '')}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(servico.csv());
  });

  api.get('/pedidos', (req, res) => res.json(servico.listar(req.query.busca)));
  api.post('/pedidos', (req, res) => res.status(201).json(servico.criar(req.body)));
  api.delete('/pedidos/exemplos', (req, res) => res.json({ apagados: servico.excluirExemplos() }));
  api.get('/pedidos/:id', (req, res) => res.json(servico.buscar(id(req))));
  api.put('/pedidos/:id', (req, res) => res.json(servico.atualizar(id(req), req.body)));
  api.delete('/pedidos/:id', (req, res) => { servico.excluir(id(req)); res.status(204).end(); });
  api.post('/pedidos/:id/avancar', (req, res) => res.json(servico.avancar(id(req))));
  api.patch('/pedidos/:id/status', (req, res) => res.json(servico.alterarStatus(id(req), req.body?.status)));
  api.post('/pedidos/:id/quitar', (req, res) => res.json(servico.quitar(id(req))));
  api.post('/pedidos/:id/avisos', (req, res) => res.json(servico.registrarAviso(id(req), req.body?.mensagem)));

  api.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  app.use('/api', api);

  // ------------------------------------------------------------- Erros
  // eslint-disable-next-line no-unused-vars
  app.use((erro, req, res, next) => {
    if (erro instanceof ErroHttp) return res.status(erro.status).json({ erro: erro.message });
    if (erro.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Dados grandes demais.' });
    console.error(erro);
    return res.status(500).json({ erro: 'Erro interno. Tente de novo.' });
  });

  return app;
}

module.exports = { criarApp };
