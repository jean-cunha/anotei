# Anotei: balcão de pedidos da papelaria

Este sistema substitui o processo antigo da papelaria: anotar o pedido no papel, passar para uma planilha e depois avisar o cliente pelo WhatsApp.

Agora o pedido é registrado direto no balcão e acompanha as etapas **Recebido → Em produção → Pronto p/ retirada → Entregue**. A cada mudança de etapa, o sistema monta a mensagem para o cliente e indica que o aviso está pendente até alguém enviá-la. A planilha ainda existe, mas agora é gerada a partir do sistema.

- **Back e front no mesmo serviço**: um único processo Node.js serve a API (`/api/...`) e as telas.
- **Banco dentro do back**: SQLite, gravado em um arquivo (`data/papelaria.db`). Não precisa de servidor de banco.
- **Login** com usuário e senha definidos por variável de ambiente.

## Tecnologias

| Camada | Escolha |
|---|---|
| Servidor | Node.js 22 + Express 4 |
| Banco | SQLite (better-sqlite3), arquivo local |
| Sessão | Cookie assinado (cookie-session), HttpOnly, SameSite=Lax |
| Front | HTML + CSS + JavaScript puro, servido pelo próprio Express |
| Testes | `node:test` (nativo do Node) |

## Rodar no computador

```bash
npm install
npm start          # http://localhost:3000  (usuário: balcao  senha: papelaria123)
npm test           # 9 testes da API
```

Na primeira execução o banco é criado com 7 pedidos de exemplo. Eles podem ser apagados em **Mensagens e dados → Apagar pedidos de exemplo**.

## Variáveis de ambiente

| Variável | Para que serve | Padrão |
|---|---|---|
| `PORT` | Porta HTTP (o Railway define sozinho) | `3000` |
| `NODE_ENV` | Use `production` no servidor. Nesse modo, `APP_SENHA` e `SESSION_SECRET` são obrigatórias | – |
| `APP_USUARIO` | Usuário do login | `balcao` |
| `APP_SENHA` | Senha do login | `papelaria123` (só fora de produção) |
| `SESSION_SECRET` | Chave que assina o cookie de sessão | aleatória a cada início (fora de produção) |
| `DB_PATH` | Caminho do arquivo do banco | `./data/papelaria.db` |
| `PAPELARIA_NOME` | Nome da loja nas mensagens | `Papelaria X` |
| `DADOS_EXEMPLO` | `false` para não criar pedidos de exemplo | `true` |

## Publicar no Railway

1. Envie este projeto para um repositório no GitHub e crie um serviço no Railway a partir dele. O Railpack detecta o Node e roda `npm start`.
2. **Crie um volume** montado em `/app/data`. Sem o volume, o banco é apagado a cada deploy.
3. Defina as variáveis: `NODE_ENV=production`, `DB_PATH=/app/data/papelaria.db`, `APP_SENHA`, `SESSION_SECRET` (um texto longo e aleatório) e `PAPELARIA_NOME`.
4. Gere um domínio público e, se quiser, configure o healthcheck em `/saude`.

## Como o aviso pelo WhatsApp funciona

O botão **Avisar no WhatsApp** abre `https://wa.me/<número>?text=<mensagem>`, com a mensagem já preenchida. O atendente só precisa apertar enviar, e o sistema registra que o aviso foi feito.

Esse envio é semiautomático por escolha: não tem custo, não depende de aprovação da Meta e não coloca o número da loja em risco de bloqueio. O envio 100% automático exigiria a WhatsApp Cloud API oficial, com modelos de mensagem aprovados e cobrança por mensagem. Essa seria uma evolução natural do projeto.

As datas são gravadas no horário de Brasília, como texto. Assim, o prazo digitado no balcão não muda quando o servidor roda em UTC.

## API

Todas as rotas exigem login, exceto `/api/login`. As rotas que alteram dados exigem o cabeçalho `X-Requested-With: fetch`, que serve de proteção contra CSRF.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/login` | Entra (`{usuario, senha}`) |
| POST | `/api/logout` | Sai |
| GET | `/api/resumo` | Números do painel |
| GET | `/api/pedidos?busca=` | Lista e busca por nome, telefone ou nº do pedido |
| POST | `/api/pedidos` | Cria um pedido |
| GET / PUT / DELETE | `/api/pedidos/:id` | Consulta, edita ou exclui |
| POST | `/api/pedidos/:id/avancar` | Passa para a próxima etapa |
| PATCH | `/api/pedidos/:id/status` | Define a etapa (`{status}`) |
| POST | `/api/pedidos/:id/quitar` | Registra o pagamento do restante |
| POST | `/api/pedidos/:id/avisos` | Registra o aviso enviado (`{mensagem}`) |
| DELETE | `/api/pedidos/exemplos` | Apaga os pedidos de exemplo |
| GET / PUT | `/api/modelos` | Lê ou edita as mensagens de cada etapa |
| GET | `/api/exportar/pedidos.csv` | Baixa a planilha (separada por `;`, abre no Excel) |

Exemplo de corpo para criar um pedido:

```json
{
  "cliente": "Maria Souza",
  "whatsapp": "(31) 98888-7777",
  "prazo": "2026-11-26T14:00",
  "valorPago": 5,
  "observacao": "Frente e verso",
  "itens": [
    { "descricao": "Xerox", "quantidade": 10, "precoUnitario": 0.3 },
    { "descricao": "Encadernação espiral", "quantidade": 1, "precoUnitario": 8 }
  ]
}
```

## Banco de dados

```
pedidos           (id, cliente, whatsapp, prazo, valor_pago_centavos, observacao, status, criado_em, exemplo)
itens_pedido      (id, pedido_id → pedidos, descricao, quantidade, preco_centavos)
avisos_whatsapp   (id, pedido_id → pedidos, status, mensagem, enviado_em)
modelos_mensagem  (status PK, texto)
```

Os valores são guardados em **centavos (inteiro)** para evitar os erros de arredondamento de números com casas decimais. Ao excluir um pedido, os itens e os avisos dele são apagados juntos (`ON DELETE CASCADE`).

## Estrutura

```
src/
  server.js      inicia tudo (variáveis, banco, servidor)
  app.js         Express: segurança, login, rotas da API, páginas
  pedidos.js     regras de negócio, validação e mensagens
  db.js          criação das tabelas
  tempo.js       datas no horário de Brasília
  paginas/index.html   tela do sistema (só com login)
public/          login, CSS, JavaScript do front, ícone
test/            testes da API
```

## Limitações conhecidas

- Há um único usuário de login, compartilhado pelo balcão.
- O SQLite funciona bem com um servidor só. Para usar várias réplicas, seria preciso migrar para PostgreSQL.
