# AGENTS.md

Guia para agentes de código (Claude Code, Codex e outros) neste repositório.

## Especificações

@docs/INDEX.md

As especificações em `docs/nnn-titulo.md` são a fonte da verdade do produto. Antes de implementar ou alterar algo, leia as que tratam do assunto, a partir do índice acima. Quando uma decisão mudar, atualize a especificação correspondente e o `docs/INDEX.md` na mesma mudança. Uma especificação nova segue a numeração `nnn` com zeros à esquerda.

## Banco de dados

Tudo o que é banco (PostgreSQL 18 + pgvector) fica em `database/` e é responsabilidade exclusiva do subagente **dba** (`.claude/agents/dba.md`, regras em [database/AGENTS.md](database/AGENTS.md)). Não edite `database/`: descreva a necessidade e delegue ao dba. Detalhes em [docs/016-banco-de-dados.md](docs/016-banco-de-dados.md).

## Comandos

Node 22.12+ e pnpm 9 (`corepack enable`). Copie `.env.example` para `.env` na raiz.

```bash
pnpm install
make -C database migrate seed   # banco de desenvolvimento (Postgres 18 na 5432), migrations e seeds
pnpm dev                        # API (http://localhost:3001) + Vite (http://localhost:5174, encaminha /api)
pnpm dev:worker                 # worker (séries, faturas de cartão, sessões) em modo watch
pnpm lint                       # Biome (lint + formato); `pnpm format` corrige
pnpm typecheck                  # tsc em todos os pacotes
pnpm test                       # unitários (shared) + integração da API
pnpm test:unit                  # só packages/shared
pnpm test:integration           # API contra Postgres 18 real: o Testcontainers builda database/docker e aplica as migrations
pnpm build                      # SPA (apps/web/dist) + bundle da API/worker (apps/server/dist/main.mjs)
pnpm db:pull                    # regenera packages/db/src/generated depois de uma migration nova (nunca edite à mão)
docker compose up --build -d    # pilha completa: Postgres (5433), migrations, api (http://localhost:3000, serve o SPA) e worker
pnpm e2e                        # Playwright contra a pilha no ar (E2E_BASE_URL, padrão http://localhost:3000)
make release                    # build multi-arch e push de tmsoftbrasil/moneyflow:<versão> e :latest
```

Teste isolado:

```bash
pnpm --filter @moneyflow/server exec vitest run test/titles.test.ts -t "estorno"   # integração, um caso
pnpm --filter @moneyflow/shared exec vitest run test/documents.test.ts           # unitário, um arquivo
MONEYFLOW_TEST_DATABASE_URL=postgres://moneyflow_app:moneyflow_app@localhost:5432/moneyflow_test pnpm test:integration  # banco já migrado, sem Testcontainers
pnpm --filter @moneyflow/e2e exec playwright test -g "baixa"                     # um e2e
```

O banco tem comandos próprios (`make -C database test`, pgTAP) em [database/AGENTS.md](database/AGENTS.md).

## Estrutura

- `apps/server` (Fastify, `@moneyflow/server`): um único artefato, `node dist/main.mjs api|worker` (ou `MODE`). `src/routes` (REST em `/api`), `src/services` (regras e transações; recebem um `ServiceContext`), `src/services/tx.ts` (`withTx`: TODA escrita roda numa transação que define o ator da auditoria; `deleteOrArchive` com savepoint), `src/authz/access.ts` (autorização central: admin global vê tudo; os demais por `caixa_members` editor/viewer), `src/auth` (sessão em cookie httpOnly, `sessions.id` = sha256 do token, admin inicial por `ADMIN_*`), `src/errors.ts` (erros do banco 23514/23505/23503/42501 traduzidos para pt-BR), `src/worker.ts` (séries até 12 meses à frente, com advisory lock; faturas de cartão do horizonte e, com `CARD_AUTO_CLOSE=true`, o fechamento automático). Fase 2: `card-core.ts`/`cards.ts` (cartão), `statements.ts`/`reconciliation.ts` (extratos e conciliação), `attachments.ts`, `audit.ts` (histórico e fechamento de mês), `title-entry.ts` (PIX, NF-e, ponto de extensão da leitura por IA), `calendar.ts`. Uploads (anexos, extratos, NF-e) mandam o arquivo cru no corpo, com o Content-Type dele e os parâmetros na query (limite 20 MB). Testes de integração em `test/`, fixtures fictícias em `test/fixtures`.
- `apps/web` (`@moneyflow/web`): console React 19 + Vite + Tailwind 4 a partir do template da skill `web-interface-admin-with-canva`. `src/pages` (telas), `src/components/{titles,caixa,entity}` (formulários e gavetas do domínio), `src/components/shell` e `ui.tsx` (do template), `src/components/canvas` (React Flow, reservado para a F3), `src/lib/api.ts` (cliente da API), `src/config/navigation.tsx` (menu, trilha e "Ir para" da paleta).
- `packages/shared`: schemas Zod de entrada (`schemas/operation.ts` na fase 2), DTOs, documentos (CPF/CNPJ alfanumérico), PIX, datas, dinheiro, recorrência, boleto (`boleto.ts`), BR Code (`brcode.ts`), parsers de OFX/CSV/NF-e (`parsers/`), o casamento assistido (`reconcile.ts`) e os textos pt-BR (`t`; as áreas da fase 2 em `i18n/areas/`). Usado pela API e pelo front.
- `packages/db`: client Drizzle e o schema gerado (`src/generated`, por `pnpm db:pull`; o `scripts/postpull.mjs` trata `citext`, `bytea` e FKs em ciclo).
- `e2e`: Playwright (login → entidade → título → baixa; importar OFX e conciliar; fechar fatura do cartão e pagar).
- `Dockerfile` (imagem única `tmsoftbrasil/moneyflow`), `docker-compose.yml` (inclui `database/docker-compose.yml` + `docker/database.override.yml`, one-shot `migrate` com dbmate, `api` e `worker`), `.github/workflows` (`ci.yml` e `release.yml`), `Makefile` (`release`).

## Regras da aplicação

- A aplicação conecta como `moneyflow_app` e nunca seleciona `users.password` (use `userColumns`); login só por `auth_login()`, revelar só por `admin_reveal_password()`. Nunca devolva senha pela API nem a inclua em logs, exports ou tools de agente.
- Fluxos que tocam várias tabelas (espelho, baixa com duas pernas, transferência, estorno, compra e parcelas, fechamento de fatura) rodam numa transação só: as checagens do banco são deferidas para o COMMIT (docs/016).
- Toda escrita usa `withTx(ctx, …)` (nunca `ctx.db.insert/update/delete` direto): a transação começa com `set_config('app.user_id', …, true)` e `app.actor_kind` (`agent` + `app.agent_run_id` na F4). Um teste de integração confere que nada escrito pela API sai como ator `system`.
- Toda permissão passa por `Access` (`assertRead`/`assertWrite`/`assertAdmin`); serviços nunca consultam `caixa_members` por conta própria. As tools dos agentes (F4) reaproveitarão os mesmos serviços.
- UI: só tokens (nenhum hex em componente), um único acento roxo, sem sombra em superfície fixa; cor de categoria = `var(--port-N)` com N = `color_slot` (1–12). Textos em pt-BR vindos de `@moneyflow/shared` (`t`).
- Dinheiro em BRL, em centavos inteiros; datas de negócio como `YYYY-MM-DD` no fuso `America/Sao_Paulo`.

## Configuração

- `.mcp.json` define um servidor MCP do projeto, `purple-skills-public`: um catálogo remoto de skills em `skills-mcp.langwizard.net` (`search_skills`, `get_skill`, `get_skill_file`, `download_skill`).
