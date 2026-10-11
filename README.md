# MoneyFlow

Sistema multiusuário de finanças por **caixa**: contas a pagar e a receber, contas financeiras com conciliação de extrato (OFX/CSV), cartões de crédito com faturas, várias casas e empresas no mesmo lugar, o canvas do fluxo de dinheiro entre caixas e entidades, relatórios, avisos pelo Telegram e **agentes de IA** que consultam e operam o sistema com as permissões de quem os aciona.

- **Caixa**: o livro financeiro de um titular (pessoa ou empresa), unidade de permissão.
- **Título**: a pagar ou a receber, liquidado por baixas; quando a contraparte também tem caixa, o lado oposto é espelhado nela.
- **Cartão de crédito**: uma caixa própria; a fatura vira um título em cada caixa pagadora.
- **Agentes**: janelas de conversa com tools de leitura e escrita (escritas pedem "Aplicar?" com o diff), MCP client e um servidor MCP próprio em `/mcp`.

Stack: monorepo pnpm, Node/TypeScript (Fastify, Drizzle), React 19 + Vite, PostgreSQL 18 com pgvector, imagem Docker única `tmsoftbrasil/moneyflow`.

## Subir com Docker

Requisitos: Docker com Compose v2.

```bash
cp .env.example .env          # ajuste senhas e o admin inicial (ADMIN_*)
docker compose up --build -d  # Postgres (porta 5433), migrations, API + console e worker
```

O console fica em <http://localhost:3000> (porta em `APP_PORT`). A pilha tem quatro serviços: `postgres`, `migrate` (aplica as migrations e sai), `api` (serve a API e o SPA) e `worker` (séries recorrentes, faturas, mensagens e a execução dos agentes de IA). Para parar: `docker compose down` (os dados ficam no volume; `down -v` apaga).

## Primeiro acesso

No primeiro boot, se não houver usuários, a API cria o administrador com `ADMIN_USERNAME`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`. Entre com esse usuário e:

1. troque a senha em **Minha conta**;
2. cadastre as entidades titulares (pessoas e empresas) em **Entidades**;
3. crie as caixas e as contas financeiras em **Caixas**;
4. crie os demais usuários em **Usuários** e dê acesso às caixas (editor ou leitor).

## Configurar um provedor de IA e um agente

Em **Administração → IA e agentes** (só admin):

1. **Provedores**: escolha *Anthropic* (Claude API) ou *OpenAI-compatível*, informe a chave de API (fica guardada no banco e nunca é mostrada de novo) e, para servidores compatíveis (Azure, OpenRouter, Ollama…), a URL base terminando em `/v1`. Use **Testar conexão** para conferir a chave e listar os modelos.
2. **Preços** (opcional): preço por milhão de tokens por modelo, para o custo estimado no painel de uso.
3. **Agentes**: nome, prompt de sistema, provedor e modelo (sugestões: `claude-sonnet-5-5` para o dia a dia, `claude-opus-5-5` para análises pesadas), tools habilitadas, se as escritas pedem confirmação, cor e servidores MCP. Ative o agente.
4. **Servidores MCP** (opcional): URL Streamable HTTP, cabeçalhos secretos (ex.: `Authorization`) e visibilidade (`global`, `public`, `private`); **Atualizar tools** lê a lista de tools do servidor.

Depois disso, o ícone **Agentes** na barra superior abre as conversas. O primeiro agente ativo (ou o definido em `AI_FLOW_AGENT`) também lê PDFs e imagens de boletos e notas na criação de títulos e sugere a classificação das linhas de extrato importadas.

Para usar as tools do MoneyFlow num cliente MCP externo, gere um token em **Minha conta → Tokens de API** e configure o cliente com `https://<seu-host>/mcp` e o cabeçalho `Authorization: Bearer <token>`.

## Configurar um destino do Telegram

1. Crie um bot com o [@BotFather](https://t.me/BotFather) e copie o token.
2. Mande uma mensagem ao bot (ou adicione-o ao grupo) e descubra o `chat_id` (por exemplo, pela API `getUpdates` do bot).
3. Em **Mensagens → Novo destino**, informe nome, token e chat id (pessoal ou de uma caixa) e use **Enviar teste**.
4. Na gaveta do destino, escolha os eventos: vencimentos, atrasados, resumos, fatura fechada, limite do cartão, divergência de conciliação e os avisos dos agentes.

O token do bot também é write-only. Para os links das mensagens apontarem para o console, defina `APP_URL`.

## Desenvolvimento

Os comandos (instalação, banco de desenvolvimento, `pnpm dev`, testes unitários, de integração e e2e, build e release) estão em [AGENTS.md](AGENTS.md). O banco (`database/`) tem regras e comandos próprios em [database/AGENTS.md](database/AGENTS.md).

## Especificações

As especificações do produto, fonte da verdade de cada decisão, estão em [`docs/`](docs/INDEX.md), começando pelo índice [docs/INDEX.md](docs/INDEX.md): stack e entrega, usuários e permissões, entidades, caixas e contas, títulos e baixas, espelhamento, cartão, categorias e auditoria, extratos e conciliação, entrada de títulos, agentes de IA, calendário, mensagens, visualização e relatórios, fases e banco de dados.
