const path = require('path');
const crypto = require('crypto');
const { abrirBanco } = require('./db');
const { criarServico } = require('./pedidos');
const { criarApp } = require('./app');

const producao = process.env.NODE_ENV === 'production';
const porta = Number(process.env.PORT) || 3000;
const arquivoBanco = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'papelaria.db');

const usuario = process.env.APP_USUARIO || 'balcao';
let senha = process.env.APP_SENHA;
let segredo = process.env.SESSION_SECRET;

if (producao && (!senha || !segredo)) {
  console.error('Em produção, defina as variáveis APP_SENHA e SESSION_SECRET.');
  process.exit(1);
}
if (!senha) {
  senha = 'papelaria123';
  console.warn('Usando a senha de desenvolvimento "papelaria123". Defina APP_SENHA fora do seu computador.');
}
if (!segredo) segredo = crypto.randomBytes(32).toString('hex');

const db = abrirBanco(arquivoBanco);
const servico = criarServico(db, { nomeLoja: process.env.PAPELARIA_NOME || 'Papelaria X' });

if (process.env.DADOS_EXEMPLO !== 'false') {
  const n = servico.criarExemplos();
  if (n) console.log(`Banco vazio: ${n} pedidos de exemplo criados.`);
}

const app = criarApp({ servico, usuario, senha, segredo, producao });
const servidor = app.listen(porta, '0.0.0.0', () => {
  console.log(`Papelaria rodando na porta ${porta} (banco: ${arquivoBanco})`);
});

// Fecha o banco direitinho quando o Railway reinicia o serviço
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    servidor.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
