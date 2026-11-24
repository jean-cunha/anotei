const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const STATUS = ['RECEBIDO', 'EM_PRODUCAO', 'PRONTO', 'ENTREGUE'];

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new Database(arquivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente             TEXT    NOT NULL,
      whatsapp            TEXT    NOT NULL,
      prazo               TEXT    NOT NULL,
      valor_pago_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_pago_centavos >= 0),
      observacao          TEXT,
      status              TEXT    NOT NULL DEFAULT 'RECEBIDO'
                          CHECK (status IN ('${STATUS.join("','")}')),
      criado_em           TEXT    NOT NULL,
      exemplo             INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS itens_pedido (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      descricao       TEXT    NOT NULL,
      quantidade      INTEGER NOT NULL CHECK (quantidade > 0),
      preco_centavos  INTEGER NOT NULL CHECK (preco_centavos >= 0)
    );

    CREATE TABLE IF NOT EXISTS avisos_whatsapp (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id   INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      status      TEXT    NOT NULL,
      mensagem    TEXT    NOT NULL,
      enviado_em  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modelos_mensagem (
      status  TEXT PRIMARY KEY,
      texto   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
    CREATE INDEX IF NOT EXISTS idx_itens_pedido ON itens_pedido(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_avisos_pedido ON avisos_whatsapp(pedido_id);
  `);

  return db;
}

module.exports = { abrirBanco, STATUS };
