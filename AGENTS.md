# AGENTS.md

Guia para agentes de código (Claude Code, Codex e outros) neste repositório.

## Especificações

@docs/INDEX.md

As especificações em `docs/nnn-titulo.md` são a fonte da verdade do produto. Antes de implementar ou alterar algo, leia as que tratam do assunto, a partir do índice acima. Quando uma decisão mudar, atualize a especificação correspondente e o `docs/INDEX.md` na mesma mudança. Uma especificação nova segue a numeração `nnn` com zeros à esquerda.

## Banco de dados

Tudo o que é banco (PostgreSQL 18 + pgvector) fica em `database/` e é responsabilidade exclusiva do subagente **dba** (`.claude/agents/dba.md`, regras em [database/AGENTS.md](database/AGENTS.md)). Não edite `database/`: descreva a necessidade e delegue ao dba. Detalhes em [docs/016-banco-de-dados.md](docs/016-banco-de-dados.md).

## Tarefas entre agentes (`tasks/`)

Achados do usuário e pedidos de revisão/correção entre agentes viram arquivos `tasks/nnn-titulo.md` com status no cabeçalho, listados em [tasks/INDEX.md](tasks/INDEX.md). Toda tarefa tem um agente designado: o subagente **triage** analisa, reproduz e designa o executor — **dba** para `database/`, **app** para o resto —, que corrige com testes e fecha a tarefa. Se você encontrar algo fora do seu escopo, abra uma tarefa em vez de contornar. Detalhes em [docs/017-tarefas-entre-agentes.md](docs/017-tarefas-entre-agentes.md). Versões e publicação: [docs/018-versoes-e-publicacao.md](docs/018-versoes-e-publicacao.md).

## Comandos

Node 22.12+ e pnpm 9 (`corepack enable`). Copie `.env.example` para `.env` na raiz.

```bash
pnpm install
make -C database migrate seed   # banco de desenvolvimento (Postgres 18 na 5432), migrations e seeds
pnpm dev                        # API (http://localhost:3001) + Vite (http://localhost:5174, encaminha /api)
pnpm dev:worker                 # worker (séries, faturas de cartão, sessões, mensagens, agentes de IA) em modo watch
pnpm lint                       # Biome (lint + formato); `pnpm format` corrige
pnpm typecheck                  # tsc em todos os pacotes
pnpm test                       # unitários (shared) + integração da API
pnpm test:unit                  # só packages/shared
pnpm test:integration           # API contra Postgres 18 real: o Testcontainers builda database/docker e aplica as migrations
pnpm build                      # SPA (apps/web/dist) + bundle da API/worker (apps/server/dist/main.mjs)
pnpm db:pull                    # regenera packages/db/src/generated depois de uma migration nova (nunca edite à mão)
docker compose up --build -d    # pilha completa: Postgres (5433), migrations, api (http://localhost:3000, serve o SPA) e worker
pnpm e2e                        # Playwright contra a pilha no ar (E2E_BASE_URL, padrão http://localhost:3000)
# Os e2e de mensagens sobem uma Bot API falsa na porta 18081 (E2E_TELEGRAM_PORT): suba a pilha apontando para ela
TELEGRAM_API_BASE=http://host.docker.internal:18081 docker compose up --build -d
# Os e2e de agentes sobem um provedor de IA falso na porta 18082 (E2E_LLM_PORT) e o cadastram com
# base_url http://host.docker.internal:18082 (E2E_LLM_BASE); nada chama uma API de IA real.
node e2e/fakes/fake-llm.ts 18082   # o mesmo provedor falso, à mão, para testar o console (Anthropic: base_url http://host.docker.internal:18082)
make release                    # build multi-arch e push de tmsoftbrasil/moneyflow:<versão> e :latest
```

Teste isolado:

```bash
pnpm --filter @moneyflow/server exec vitest run test/titles.test.ts -t "estorno"   # integração, um caso
pnpm --filter @moneyflow/shared exec vitest run test/documents.test.ts           # unitário, um arquivo
MONEYFLOW_TEST_DATABASE_URL=postgres://moneyflow_app:moneyflow_app@localhost:5432/moneyflow_test pnpm test:integration  # banco já migrado, sem Testcontainers
pnpm --filter @moneyflow/e2e exec playwright test -g "baixa"                     # um e2e
pnpm --filter @moneyflow/server exec vitest run test/agents.test.ts -t "retomada"  # agentes (provedor e MCP falsos)
```

O banco tem comandos próprios (`make -C database test`, pgTAP) em [database/AGENTS.md](database/AGENTS.md).

## Estrutura

- `apps/server` (Fastify, `@moneyflow/server`): um único artefato, `node dist/main.mjs api|worker` (ou `MODE`). `src/routes` (REST em `/api`), `src/services` (regras e transações; recebem um `ServiceContext`), `src/services/tx.ts` (`withTx`: TODA escrita roda numa transação que define o ator da auditoria; `deleteOrArchive` com savepoint), `src/authz/access.ts` (autorização central: admin global vê tudo; os demais por `caixa_members` editor/viewer), `src/auth` (sessão em cookie httpOnly, `sessions.id` = sha256 do token, admin inicial por `ADMIN_*`), `src/errors.ts` (erros do banco 23514/23505/23503/42501 traduzidos para pt-BR), `src/worker.ts` (séries até 12 meses à frente, com advisory lock; faturas de cartão do horizonte e, com `CARD_AUTO_CLOSE=true`, o fechamento automático; num segundo laço, a cada `MESSAGE_INTERVAL_MS`, as mensagens do Telegram e o sino). Fase 2: `card-core.ts`/`cards.ts` (cartão), `statements.ts`/`reconciliation.ts` (extratos e conciliação), `attachments.ts`, `audit.ts` (histórico e fechamento de mês), `title-entry.ts` (PIX, NF-e, ponto de extensão da leitura por IA), `calendar.ts`. Fase 3: `reports.ts` (relatórios e `scopeCaixas`: caixas legíveis + cartões das pagadoras escolhidas), `flow.ts` (canvas e posições), `messages.ts` (destinos, assinaturas, outbox, enviar teste e `deliver`), `message-worker.ts` (laço de mensagens: produtor de eventos com dedup, notificações do sino, consumidor da outbox, `emitAgentEvent` para a F4), `notifications.ts` (sino), `integrations/telegram.ts` (Bot API em `TELEGRAM_API_BASE`). Fase 4 (agentes, spec 011): `src/agents/` — `llm/` (adaptadores Anthropic e OpenAI-compatível normalizando para os blocos neutros; `embedTexts`), `mcp-client.ts` (Streamable HTTP), `tool-handlers.ts` (execução e prévia de cada tool sobre os serviços), `tools-runtime.ts` (tools do agente: internas + MCP prefixadas), `runner.ts` (loop: claim, heartbeat, eventos, confirmações, cancelamento, retomada, título, uso), `worker.ts` (fila e manutenção), `events-hub.ts` (LISTEN ai_run_events → SSE e aviso de conclusão no sino), `store.ts` (SQL das tabelas de IA; nunca `search_tsv` nem segredos), `flows.ts` e `embeddings.ts`/`search.ts`; serviços `conversations.ts`, `ai-admin.ts`, `ai-flows.ts` (leitura de documento e sugestões da conciliação), `api-tokens.ts`; rotas `routes/agents.ts` e `routes/mcp.ts` (servidor MCP próprio em `/mcp`, token pessoal). Testes em `test/agents.test.ts` com o provedor falso (`e2e/fakes/fake-llm.ts`) e o MCP falso (`test/fakes/fake-mcp.ts`). Uploads (anexos, extratos, NF-e) mandam o arquivo cru no corpo, com o Content-Type dele e os parâmetros na query (limite 20 MB). Testes de integração em `test/`, fixtures fictícias em `test/fixtures`.
- `apps/web` (`@moneyflow/web`): fase 4 em `src/agents/` (ícone Agentes, janelas flutuantes e doca, painel lateral direito, conversa com SSE, markdown seguro, contexto da tela `useAgentScreenContext` e arrastar registros `recordDragProps`), `pages/AdminAiPage.tsx` + `components/admin-ai/` (provedores, preços, agentes, MCP, uso) e `components/account/ApiTokensPanel.tsx`. Console React 19 + Vite + Tailwind 4 a partir do template da skill `web-interface-admin-with-canva`. `src/pages` (telas), `src/components/{titles,caixa,entity}` (formulários e gavetas do domínio), `src/components/shell` e `ui.tsx` (do template), `src/components/canvas` (canvas de fluxo em React Flow: `graph.ts` é o adaptador API → nós/arestas, layout e agrupamento), `src/components/reports` e `messages` (fase 3), `ExportMenu`/`lib/export.ts` (CSV e PDF no navegador; jsPDF sob demanda) e `lib/export-tables.ts` (listagens exportáveis), `src/lib/api.ts` (cliente da API), `src/config/navigation.tsx` (menu, trilha e "Ir para" da paleta).
- `packages/shared`: `agents/` (fase 4: registro único das tools `AGENT_TOOLS` com schema Zod → JSON Schema, blocos neutros das mensagens, prévia/diff `ToolPreview`, parser/formatador SSE, entradas e DTOs da API dos agentes; textos em `i18n/areas/agents.ts` e `agents-ui.ts`), schemas Zod de entrada (`schemas/operation.ts` na fase 2, `schemas/vision.ts` na fase 3), mensagens do Telegram e agendamento no fuso de SP (`messages.ts`), CSV (`export.ts`), pivô dos relatórios (`reports.ts`), rotas do console (`links.ts`), DTOs, documentos (CPF/CNPJ alfanumérico), PIX, datas, dinheiro, recorrência, boleto (`boleto.ts`), BR Code (`brcode.ts`), parsers de OFX/CSV/NF-e (`parsers/`), o casamento assistido (`reconcile.ts`) e os textos pt-BR (`t`; as áreas da fase 2 em `i18n/areas/`). Usado pela API e pelo front.
- `packages/db`: client Drizzle e o schema gerado (`src/generated`, por `pnpm db:pull`; o `scripts/postpull.mjs` trata `citext`, `bytea` e FKs em ciclo).
- `e2e`: Playwright (login → entidade → título → baixa; importar OFX e conciliar; fechar fatura do cartão e pagar; canvas e gaveta; relatório e CSV; destino do Telegram e "enviar teste" com Bot API falsa; agente: conversa, aprovar escrita, ancorar e minimizar com o provedor falso de `e2e/fakes/fake-llm.ts`; cores do tema: acento azul, nada roxo, AA e as 12 `--port-N` distintas).
- `Dockerfile` (imagem única `tmsoftbrasil/moneyflow`), `docker-compose.yml` (inclui `database/docker-compose.yml` + `docker/database.override.yml`, one-shot `migrate` com dbmate, `api` e `worker`), `.github/workflows` (`ci.yml` e `release.yml`), `Makefile` (`release`).

## Regras da aplicação

- A aplicação conecta como `moneyflow_app` e nunca seleciona `users.password` (use `userColumns`); login só por `auth_login()`, revelar só por `admin_reveal_password()`. Nunca devolva senha pela API nem a inclua em logs, exports ou tools de agente.
- Fluxos que tocam várias tabelas (espelho, baixa com duas pernas, transferência, estorno, compra e parcelas, fechamento de fatura) rodam numa transação só: as checagens do banco são deferidas para o COMMIT (docs/016).
- Toda escrita usa `withTx(ctx, …)` (nunca `ctx.db.insert/update/delete` direto): a transação começa com `set_config('app.user_id', …, true)` e `app.actor_kind` (`agent` + `app.agent_run_id` na F4). Um teste de integração confere que nada escrito pela API sai como ator `system`.
- Toda permissão passa por `Access` (`assertRead`/`assertWrite`/`assertAdmin`); serviços nunca consultam `caixa_members` por conta própria. As tools dos agentes (F4) reaproveitarão os mesmos serviços.
- UI: só tokens (nenhum hex em componente), um único acento azul (o roxo do template foi trocado; nenhuma cor da interface fica na faixa roxa), sem sombra em superfície fixa; cor de categoria = `var(--port-N)` com N = `color_slot` (1–12). Textos em pt-BR vindos de `@moneyflow/shared` (`t`).
- Dinheiro em BRL, em centavos inteiros; datas de negócio como `YYYY-MM-DD` no fuso `America/Sao_Paulo`.
- Relatórios e canvas: as funções do banco recebem a lista de caixas; passe sempre `scopeCaixas(ctx, pedidas)` (só caixas legíveis, 404 se pedir outra).
- `message_destinations`: NUNCA `SELECT *` nem `RETURNING` sem colunas (o papel da aplicação não lê `bot_token`; 42501). O token é write-only como a senha: nunca devolvido pela API, nem em logs, auditoria, exportações ou tools de agente.
- Segredos da IA (`ai_providers.api_key`, `mcp_servers.secret_headers`, `user_api_tokens.token_hash`): NUNCA `SELECT *` nessas tabelas (42501); liste colunas. Grave e nunca devolva; leia só pelas funções do banco (`ai_run_provider_credentials`, `ai_run_mcp_headers`, `ai_embedding_credentials`, `admin_*`, `api_token_authenticate`). Fora de logs, auditoria, eventos de SSE e resultados de tools.
- Agentes: tools novas entram em `AGENT_TOOLS` (shared) e no `TOOL_HANDLERS` (server), sempre sobre os serviços (com `Access`), com `preview` nas escritas. O loop grava em transações curtas e nunca segura transação durante a chamada ao modelo. Em `ai_messages`, nunca selecione `search_tsv` (use `MESSAGE_COLUMNS`).
- Enfileirar mensagem sempre com `dedup_key` e `ON CONFLICT (destination_id, dedup_key) DO NOTHING`; notificação com `ON CONFLICT (user_id, dedup_key) DO NOTHING`.

## Configuração

- `.mcp.json` define um servidor MCP do projeto, `purple-skills-public`: um catálogo remoto de skills em `skills-mcp.langwizard.net` (`search_skills`, `get_skill`, `get_skill_file`, `download_skill`).
