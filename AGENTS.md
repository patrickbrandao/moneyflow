# AGENTS.md

Guia para agentes de código (Claude Code, Codex e outros) neste repositório: comandos, verificação, regras e onde fica cada área. O mapa de cada pacote, arquivo a arquivo e com os testes, fica no `AGENTS.md` da pasta (veja Estrutura): leia-o antes de mexer nela. O Claude Code o carrega pelo `CLAUDE.md` da pasta quando o trabalho chega ali.

## Especificações

As especificações em `docs/nnn-titulo.md` são a fonte da verdade do produto. Antes de implementar ou alterar algo, leia o [docs/INDEX.md](docs/INDEX.md) (os conceitos centrais e uma frase por spec) e as specs do assunto. Quando uma decisão mudar, atualize a spec e o `docs/INDEX.md` na mesma mudança; spec nova leva o próximo `nnn`.

## Banco de dados

Tudo o que é banco (PostgreSQL 18 + pgvector) fica em `database/` e é responsabilidade exclusiva do subagente **dba** (`.claude/agents/dba.md`, regras em [database/AGENTS.md](database/AGENTS.md)). Não edite `database/`: descreva a necessidade e delegue ao dba. Detalhes em [docs/016-banco-de-dados.md](docs/016-banco-de-dados.md).

## Tarefas entre agentes (`tasks/`)

Achados do usuário e pedidos de revisão/correção entre agentes viram arquivos `tasks/nnn-titulo.md` com status no cabeçalho, listados em [tasks/INDEX.md](tasks/INDEX.md). O subagente **triage** analisa, reproduz e designa o executor — **dba** para `database/`, **app** para o resto —, que corrige com testes e fecha a tarefa. Se você encontrar algo fora do seu escopo, abra uma tarefa em vez de contornar. Detalhes em [docs/017-tarefas-entre-agentes.md](docs/017-tarefas-entre-agentes.md). Versões e publicação: [docs/018-versoes-e-publicacao.md](docs/018-versoes-e-publicacao.md).

## Verificação (dois níveis)

- **Rápida, o padrão** enquanto se desenvolve e ao concluir uma tarefa: `pnpm verify:quick`. Olha só o que mudou desde que o branch saiu do `main` (commits, alterações e arquivos novos; `--base <ref>` troca o ponto), sem build, e2e nem a suíte inteira:
  - Biome nos arquivos alterados (no repositório inteiro, se o `biome.json` mudou) e o typecheck dos pacotes afetados, inclusive por arquivo apagado, e dos que dependem deles;
  - os testes do shared relacionados e os dos scripts da raiz, quando um script ou uma versão conferida muda;
  - a integração dos arquivos tocados, no Postgres local: o `test/x.test.ts` alterado, os do mapa `apps/server/test/related.json` e o de mesmo nome de `src/.../x.ts`. Arquivo de `apps/server/src` sem teste mapeado faz a verificação falhar com a lista: o novo entra no mapa no mesmo commit;
  - o pgTAP dos testes de `database/tests/` alterados.
- Se a heurística não achar o teste certo, passe-o: `pnpm verify:quick -- test/contracts.test.ts -t "renovação"` (`--sem-integracao` pula a integração de propósito). Toda mudança continua vindo com o teste que a cobre; o que muda é quanto da suíte roda.
- **Completa, só quando o usuário pedir** ("verificação completa", "rode tudo"), antes de abrir PR e de release: `pnpm verify:full` (lint, typecheck, todos os testes com Testcontainers, os dos scripts, build e todo o pgTAP; `--e2e` soma o Playwright com a pilha no ar, `--local` usa o Postgres local). O CI roda sempre o completo.
- Modo local da integração (`MONEYFLOW_TEST_DB=local`, `pnpm test:local`): o Postgres de desenvolvimento (`make -C database up`, 5432), num banco limpo copiado de um modelo migrado (nunca o `moneyflow_test` do pgTAP). Execuções em paralelo (worktrees) disputam o banco: dê a cada uma um nome em `MONEYFLOW_TEST_LOCAL_DB`. Detalhes em [apps/server/AGENTS.md](apps/server/AGENTS.md).

## Comandos

Node 26 (o `.nvmrc`, o mesmo do CI e da imagem; o `engine-strict` do `.npmrc` recusa outra major) e pnpm 9.12 (o `packageManager` do `package.json`; `npm i -g pnpm@9.12.0` ou o gerenciador do sistema, porque o Node 25+ não traz o corepack). Copie `.env.example` para `.env` na raiz: ele lista toda variável que a API, o worker, o Vite e o compose leem.

```bash
pnpm install
make -C database migrate seed   # banco de desenvolvimento (Postgres 18 na 5432), migrations e seeds
pnpm dev                        # API (http://localhost:3001, a PORT) + Vite (http://localhost:5174, encaminha /api e /mcp)
pnpm dev:worker                 # worker (séries, faturas, sessões, mensagens, lembretes, agentes) em modo watch
pnpm lint                       # Biome (lint + formato); `pnpm format` corrige
pnpm typecheck                  # tsc em todos os pacotes
pnpm test                       # unitários (shared) + integração da API
pnpm test:unit                  # só packages/shared
pnpm test:integration           # integração da API no Postgres 18 do Testcontainers (builda database/docker e migra)
pnpm test:local                 # a mesma integração no Postgres local (5432), sem container
pnpm --filter @moneyflow/server test:coverage   # cobertura do v8 (também no shared; o CI publica o resumo)
pnpm test:scripts               # testes dos scripts da raiz (node --test)
pnpm verify:quick               # verificação rápida do que mudou no branch (o padrão; veja Verificação)
pnpm verify:full                # verificação completa (só quando pedido, antes de PR e release; --e2e, --local)
pnpm build                      # SPA (apps/web/dist) + bundle da API/worker (apps/server/dist/main.mjs)
pnpm db:pull                    # regenera packages/db/src/generated depois de uma migration nova (nunca edite à mão)
docker compose up --build -d    # pilha: Postgres (5433), migrations, api (http://localhost:3000, com o SPA) e worker
pnpm e2e                        # Playwright contra a pilha no ar (E2E_BASE_URL, padrão http://localhost:3000); os falsos e as portas em e2e/AGENTS.md
make release                    # release-check (árvore limpa, HEAD na tag, verify:full), build multi-arch do commit e push (docs/018)
```

Teste isolado:

```bash
pnpm --filter @moneyflow/server test:local test/titles.test.ts -t "estorno"       # integração, um caso, no Postgres local
pnpm --filter @moneyflow/shared exec vitest run test/documents.test.ts           # unitário, um arquivo
MONEYFLOW_TEST_DATABASE_URL=postgres://moneyflow_app:moneyflow_app@localhost:5432/moneyflow_test pnpm test:integration  # banco já migrado, sem Testcontainers
pnpm --filter @moneyflow/e2e exec playwright test -g "baixa"                     # um e2e
```

Os comandos do banco (`make -C database test`, pgTAP) estão em [database/AGENTS.md](database/AGENTS.md).

## Estrutura

- `apps/server` (`@moneyflow/server`, Fastify): a API em `/api`, o MCP em `/mcp` e o worker, num artefato (`node dist/main.mjs api|worker`). Mapa: [apps/server/AGENTS.md](apps/server/AGENTS.md).
- `apps/web` (`@moneyflow/web`): o console em React 19 + Vite + Tailwind 4. Mapa: [apps/web/AGENTS.md](apps/web/AGENTS.md).
- `packages/shared` (`@moneyflow/shared`): tipos, schemas Zod, regras puras, o registro das tools e os textos pt-BR (`t`), da API e do console. Mapa: [packages/shared/AGENTS.md](packages/shared/AGENTS.md).
- `packages/db` (`@moneyflow/db`): o client Drizzle, o pool e o schema gerado. Mapa: [packages/db/AGENTS.md](packages/db/AGENTS.md).
- `e2e` (`@moneyflow/e2e`): Playwright e os falsos (provedor de IA, Bot API). Mapa: [e2e/AGENTS.md](e2e/AGENTS.md).
- `database/`: o banco, do dba ([database/AGENTS.md](database/AGENTS.md)).
- `scripts/`: `verify.mjs`/`verify-plan.mjs` (a verificação), `check-versions.mjs` (Node, imagens e actions fixos) e `coverage-summary.mjs`, com os `*.test.mjs`.
- `Dockerfile` (imagem única `tmsoftbrasil/moneyflow`), `docker-compose.yml` (inclui `database/docker-compose.yml` + `docker/database.override.yml`; `migrate` com dbmate, `api` e `worker`), `.github/workflows` (`ci.yml`, `release.yml`) e `Makefile` (`release-check`, `release`, atalhos).
- `docs/` (as specs) e `tasks/` (as tarefas).

## Regras da aplicação

- A aplicação conecta como `moneyflow_app` e nunca seleciona `users.password` (use `userColumns`); login só por `auth_login()`, revelar só por `admin_reveal_password()`. Nunca devolva senha pela API nem a inclua em logs, exports ou tools de agente. Única exceção: o backup do admin (spec 019), que lê os segredos pelas funções `admin_*` e os grava no arquivo exportado.
- Fluxos que tocam várias tabelas (espelho, baixa com duas pernas, transferência, estorno, compra e parcelas, fechamento de fatura) rodam numa transação só: as checagens do banco são deferidas para o COMMIT (docs/016).
- Toda escrita usa `withTx(ctx, …)` (nunca `ctx.db.insert/update/delete` direto): a transação começa com `set_config('app.user_id', …, true)` e `app.actor_kind` (`agent` + `app.agent_run_id` nas execuções de agente). Um teste de integração confere que nada escrito pela API sai como ator `system`.
- Séries e contratos (spec 034): todo INSERT em `recurrence_rules` leva `caixa_id` (a caixa da conta ou a do cartão); a série de cartão ganha a `card_recurring_charges` na mesma transação e nunca tem títulos (crie obrigações por `insertObligation`); os títulos e as compras ligadas carregam o `contract_id` da série (ligar ou desligar só por `setSeriesContract`); a conta prevista é sempre da caixa do título; a baixa feita a partir da linha do extrato nunca cria transferência. Contrato não gera títulos próprios: aditivo, renovação e rescisão operam sobre as séries.
- Toda permissão passa por `Access` (`assertRead`/`assertWrite`/`assertAdmin`); serviços nunca consultam `caixa_members` por conta própria. As tools dos agentes reaproveitam os mesmos serviços, com o mesmo `Access`.
- UI: só tokens (nenhum hex em componente), um único acento azul (nenhuma cor da interface na faixa roxa), sem sombra em superfície fixa; cor de categoria = `var(--port-N)` com N = `color_slot` (1–12). Valores sempre pelo `Money` ou `formatAccounting` (formato contábil: negativo entre parênteses, sem sinal, em vermelho escuro `--negative`; spec 014); filtros de data das listagens pelo `DateRangeFilter`/`useStoredPeriod` (spec 004). Textos em pt-BR vindos de `@moneyflow/shared` (`t`).
- Dinheiro em BRL, em centavos inteiros; datas de negócio como `YYYY-MM-DD` no fuso `America/Sao_Paulo`.
- Uploads (anexos, extratos, NF-e, chat) mandam o arquivo cru no corpo, com o Content-Type dele e os parâmetros na query (limite 20 MB).
- Relatórios e canvas: as funções do banco recebem a lista de caixas; passe sempre `scopeCaixas(ctx, pedidas)` (só caixas legíveis, 404 se pedir outra).
- `message_destinations`: NUNCA `SELECT *` nem `RETURNING` sem colunas (o papel da aplicação não lê `bot_token`; 42501). O token é write-only como a senha: nunca devolvido pela API, nem em logs, auditoria, exportações (fora o backup do admin) ou tools de agente.
- Segredos da IA (`ai_providers.api_key`, `mcp_servers.secret_headers`, `user_api_tokens.token_hash`): NUNCA `SELECT *` nessas tabelas (42501); liste colunas. Grave e nunca devolva; leia só pelas funções do banco (`ai_run_provider_credentials`, `ai_capability_credentials`, `ai_run_mcp_headers`, `ai_embedding_credentials(provedor)`, `admin_*`, `api_token_authenticate`). Fora de logs, auditoria, eventos de SSE e resultados de tools; só o backup do admin (spec 019) os exporta.
- Chamadas ao provedor de IA: sempre por `createLlmClient(credenciais, log)`/`embed`/`transcribe`/`speak(…, log)` com o `RequestLogBase` (provedor, execução ou usuário, `log_bodies`, tentativas da configuração), nunca um SDK solto; o uso gravado em `ai_usage` leva o `request_id` devolvido. `ai_requests`/`ai_request_attempts` não têm DELETE para a aplicação (só `ai_requests_purge`).
- Provedor por inferência (spec 024): o texto é `ai_agents.provider_id/model`; visão, embeddings, áudio→texto e texto→áudio vêm de `ai_agent_inferences`, sempre resolvidos por `agents/inferences.ts` (modelo nulo = padrão do provedor). Ao gravar um provedor, `default_models` só com as chaves das flags ligadas; o Anthropic com `base_url` exige `default_models.text`. Gravar em `ai_embeddings` exige o par registrado (`ai_embedding_indexes_touch()`) e o `provider_id`.
- Agentes, as tools:
  - tool nova entra em `AGENT_TOOLS` (shared, com `category` e, quando for o caso, `adminOnly`/`secrets`/`producesFile`/`external` — esta para a que chama serviço externo ou gasta IA) e no `TOOL_HANDLERS` (server), sempre sobre os serviços (com `Access`), com `preview` nas escritas (as leituras sem prévia própria mostram os argumentos no cartão em `ask`);
  - lista que pode crescer pagina por `offset`/`limit` (`listPage` em `tool-helpers.ts`), e o resultado passa por `fitResult` (shared), que corta por item sem quebrar o JSON;
  - quem decide allow/ask é o kit do agente (spec 021); tool nova não entra sozinha em kit nenhum;
  - segredos (spec 027): o campo fica FORA do schema da tool; a prévia declara `secretFields`, o valor chega em `meta.secrets` pela requisição de decisão e a API executa a tool ali (`executeSecretTool`), entregando o resultado ao worker pelo evento `tool_result` com `prepared`; o worker nunca executa tool de segredo, e o valor nunca vai a resultado, evento, confirmação, auditoria ou log;
  - arquivo gerado (`producesFile`): o handler devolve `{ file }` e o runtime grava o anexo e o liga à mensagem `tool` da sessão.
- Agentes, a execução e as sessões: o loop grava em transações curtas e nunca segura transação durante a chamada ao modelo. Em `ai_messages`, nunca selecione `search_tsv` (use `MESSAGE_COLUMNS`). Sessões (spec 026): no máximo uma `chat` ativa por (usuário, agente), garantida no banco; quem fala com o fio (console, Telegram, tarefas) usa `ensureActiveSession`/`sendToAgent`; mensagem e execução só na ativa (a finalizada é somente leitura e não volta: bifurque); finalizar e bifurcar pedem o parar da execução ativa na mesma transação.
- Toda execução nova de agente passa por `assertCanStartRun` (spec 028: limite por minuto e orçamento do mês; `429` com `retry-after` ou `budget_exceeded`); o runner confere o orçamento antes de cada chamada. Os testes de integração sobem com `AI_RUNS_PER_MINUTE=1000`.
- Chave do CNPJ Aberto (`CNPJ_ABERTO_API_KEY`, spec 003): segredo local em `.local/cnpjaberto.env` (fora do git e da imagem; o compose da raiz e o `pnpm dev` o carregam). Nunca a versione, devolva pela API nem a registre em logs.
- Telegram de entrada (spec 029): o token do bot fora da outbox só por `telegram_inbound_bot_token(destino)` (`inboundToken` em `services/messages.ts`), nunca devolvido nem registrado; o segredo do webhook fica só como hash (`webhook_secret_hash`, conferido por `telegram_webhook_authenticate`). Ligar a entrada chama `setWebhook` na mesma transação; desligar, desativar ou arquivar desliga no mesmo UPDATE e chama `deleteWebhook`. As respostas aos chats privados vão direto pela Bot API (nunca pela outbox, que é do chat do destino). A URL pública vem de `telegram.public_base_url` (vence `PUBLIC_BASE_URL`) e só vale com HTTPS.
- Enfileirar mensagem sempre com `dedup_key` e `ON CONFLICT (destination_id, dedup_key) DO NOTHING`; notificação com `ON CONFLICT (user_id, dedup_key) DO NOTHING`.

## Configuração

- `.mcp.json` define um servidor MCP do projeto, `purple-skills-public`: um catálogo remoto de skills em `skills-mcp.langwizard.net` (`search_skills`, `get_skill`, `get_skill_file`, `download_skill`).
