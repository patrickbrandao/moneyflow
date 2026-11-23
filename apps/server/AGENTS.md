# apps/server — API, servidor MCP e worker

Guia da pasta `apps/server` (`@moneyflow/server`, Fastify). As regras que valem para todo o repositório (`withTx`, `Access`, segredos, agentes, séries) estão no [AGENTS.md da raiz](../../AGENTS.md); aqui fica o mapa por pasta e arquivo, com os testes de integração (`test/`) que cobrem cada um. O `pnpm verify:quick` escolhe esses testes pelo [test/related.json](test/related.json) e pelo teste de mesmo nome: arquivo novo em `src` entra no mapa no mesmo commit.

Um artefato, dois modos: `node dist/main.mjs api|worker` (ou `MODE`). O build (`build.mjs`) gera `dist/main.mjs` e `dist/healthcheck.mjs`.

## Convenções

- `src/routes` expõe o REST em `/api` e só valida e chama os serviços; `src/services` tem as regras e as transações, sempre recebendo um `ServiceContext` (`context.ts`).
- Uploads (anexos, extratos, NF-e, chat) mandam o arquivo cru no corpo, com o Content-Type dele e os parâmetros na query (limite 20 MB; `rawUpload` em `http.ts`, `lib/upload.ts` no console).
- Erros de negócio são `AppError` com status e mensagem pt-BR; os do banco passam por `translateDbError` (`errors.ts`).

## Processo (`src/`)

- `main.ts`: escolhe o modo (primeiro argumento ou `MODE`, padrão `api`, por `resolveMode` de `health.ts`), abre o pool com os prazos `DB_*_MS` e ouve SIGTERM/SIGINT desde o início; a parada roda uma vez só, dentro de `SHUTDOWN_GRACE_MS`, e passada a folga o processo sai mesmo assim (tarefa 107).
- `app.ts`: monta o Fastify (cookie, rate limit do login `LOGIN_RATE_LIMIT`, o IP do cliente e o id de requisição do proxy só com `TRUSTED_PROXIES`, tarefa 186), registra as rotas, o `RunEventsHub` e serve o SPA de `WEB_DIST` com a CSP. Testes: `security-headers`, `auth`.
- `config.ts`: `loadConfig` lê as variáveis (todas listadas no `.env.example` da raiz); `intEnv` recusa no boot o valor que não é inteiro ou fica fora da faixa, citando a variável (vazio = o padrão; tarefa 110); `insecureCookieWarning` avisa do `COOKIE_SECURE=false` com URL pública em HTTPS. Testes: `config` (inclui a conferência do `.env.example`), `auth`, `lookup`.
- `context.ts`: o `ServiceContext` (banco, quem age, `actorKind`/`agentRunId` da auditoria, o `Access` e `recipeLineIds`, o escopo das receitas). Testes: `permissions`, `statements`.
- `errors.ts`: `AppError` e a tradução dos erros do banco (23514/23505/23503/42501 pela constraint, com os textos de `i18n/errors.ts` do shared; o prazo da consulta 57014, o do lock 55P03 e o do pool viram 503 com `retry-after`, tarefa 102). Testes: `errors`, `operation`, `titles`.
- `health.ts` e `healthcheck.ts`: a saúde da imagem (tarefa 107). O worker grava o batimento num arquivo a cada passada do laço de mensagens (`WORKER_HEARTBEAT_FILE`); `dist/healthcheck.mjs` confere a API pelo `/api/health` e o worker pelo batimento. Teste: `health`.
- `http.ts`: `parse` (Zod com a mensagem pt-BR do primeiro problema), `param` (id da URL ou 404) e os tipos da requisição (`actor`, `ctx`, `rawUpload`). Testes: `auth`, `chat-media`.
- `log.ts`: opções comuns do log da API e do worker; sem os cabeçalhos de sessão e o erro sem os parâmetros das consultas nem as linhas do Postgres (tarefa 070).
- `security-headers.ts`: X-Frame-Options, nosniff, Referrer-Policy e a CSP do SPA com o hash do script do tema (tarefa 065, docs/001). Teste: `security-headers`.
- `shutdown.ts`: espera o trabalho em andamento até o prazo e segue (a reserva vencida retoma o que ficou).
- `worker.ts`: o modo worker, em três laços. O de hora em hora (`WORKER_INTERVAL_MS`): séries até 12 meses à frente (`recurrence.ts`, advisory lock por série), faturas futuras dos cartões e, com `CARD_AUTO_CLOSE=true`, o fechamento automático, a manutenção dos contratos e a limpeza das sessões. O de mensagens (`MESSAGE_INTERVAL_MS`): `messageTick` (eventos, sino, lembretes e outbox) e o batimento. O dos agentes: `agents/worker.ts`. Testes: `titles`, `cards`, `contracts`.

## Autenticação e permissão

- `auth/session.ts`: sessão em cookie httpOnly; no banco só o hash (`sessions.id` = sha256 do token); validade `SESSION_DAYS` e ociosidade `SESSION_IDLE_HOURS`; `purgeExpiredSessions` no worker. Testes: `auth`, `permissions`, `maintenance`.
- `auth/bootstrap.ts`: o admin inicial por `ADMIN_*` quando não há usuários (spec 002).
- `authz/access.ts`: a autorização central (`Access`: `assertRead`/`assertWrite`/`assertAdmin`). Admin global vê tudo; os demais pelas `caixa_members` (editor/viewer); quem lê a pagadora padrão de um cartão lê a caixa do cartão. Testes: `permissions`, `statements`, `vision`.

## Rotas (`src/routes`, REST em `/api`)

- `routes/auth.ts` (login, sessão, `me`) e `routes/users.ts` (usuários, revelar senha, papéis). Testes: `auth`, `permissions`, `admin-routes`.
- `routes/entities.ts`: entidades, `/api/entity-tags` e `/api/lookup` (CNPJ e CEP). Testes: `entities`, `entity-tags`, `cnpj-alfanumerico`.
- `routes/caixas.ts`: caixas, membros, contas (com `GET /api/accounts/:id/summary`), categorias e movimentos. Testes: `operation`, `permissions`, `account-summary`.
- `routes/titles.ts`: títulos, baixas, transferências, a visão geral, a busca da paleta e as séries (`/api/series`). Testes: `titles`, `contracts`, `title-pairs`, `charge-link`.
- `routes/cards.ts`: cartões, faturas e compras (spec 007). Testes: `cards`, `charge-link`.
- `routes/statements.ts`: extratos, linhas, mapeamentos CSV e regras de classificação (spec 009). Testes: `statements`, `statement-supersede`.
- `routes/operation.ts`: auditoria e fechamento (008), entrada de títulos e NF-e (010) e calendário (012). Teste: `operation`.
- `routes/attachments.ts`: anexos; o download aceita `Range` (`parseRange`) e sai num sandbox com CSP própria (tarefa 048). Testes: `chat-media`, `operation`.
- `routes/vision.ts`: relatórios e canvas (014), destinos e outbox das mensagens (013) e o sino. Teste: `vision`.
- `routes/contracts.ts`: contratos, obrigações, ciclo de vida, documentos e leitura por IA (020 e 034). Teste: `contracts`.
- `routes/notes.ts`: `/api/notes`, `/api/entities/:id/notes`, `/api/note-reminders/firings` e `/api/account/reminder-settings` (spec 035). Teste: `notes`.
- `routes/agents.ts`: administração da IA, conversas e sessões, execuções com SSE, confirmações, tarefas agendadas, sugestões da conciliação e `app_settings` (`area.nome`). Testes: `agents`, `autonomous`, `admin-routes`.
- `routes/reconcile-recipes.ts`: receitas de conciliação, histórico e o play (spec 030). Teste: `reconcile-recipes`.
- `routes/telegram.ts`: `POST /api/telegram/webhook/:destinationId` (fora da sessão por cookie, pelo segredo), o pareamento em Minha conta e a configuração (spec 029). Teste: `autonomous`.
- `routes/backup.ts`: exportar, importar, dump e restauração, com o download de arquivo temporário (spec 019). Teste: `backup`.
- `routes/mcp.ts`: o servidor MCP próprio em `/mcp` (Streamable HTTP sem estado), autenticado por token pessoal (`Authorization: Bearer mf_…`), com as mesmas tools dos agentes e as permissões do dono do token. Testes: `agents`, `agent-tools`.

## Serviços de domínio (`src/services`)

- `tx.ts`: `withTx` (TODA escrita: a transação começa com `app.user_id`, `app.actor_kind` e, nos agentes, `app.agent_run_id`) e `deleteOrArchive` (exclui ou arquiva num savepoint). Testes: `permissions`, `titles`, `agents`.
- `util.ts`: `snake_case` → `camelCase` das linhas de SQL cru.
- `users.ts`: usuários (a aplicação nunca lê `users.password`: `userColumns` do `@moneyflow/db`, login por `auth_login()`, revelar por `admin_reveal_password()`). Testes: `auth`, `permissions`.
- `caixas.ts`: caixas, membros, contas financeiras, ajustes do cofre e categorias ocultas por caixa (specs 002 e 004). Testes: `operation`, `permissions`.
- `categories.ts`: o plano global (leitura para todos, escrita do admin; ocultar o grupo oculta os filhos). Testes: `operation`, `titles`.
- `entities.ts`: entidades e os filhos (contatos, endereços, dados bancários, PIX, vínculos), favoritas e tags da entidade, o cadastro pelo CNPJ consultado. Testes: `entities`, `entity-tags`, `cnpj-alfanumerico`.
- `entity-tags.ts`: catálogo de tags do admin (em uso = arquivada), `replaceEntityTags` e o filtro por entidade (tags ativas any/all e favoritas) resolvido em `p_entity_ids` nos relatórios (spec 003/014). Teste: `entity-tags`.
- `overview.ts`: a visão geral (saldos, vencidos, a vencer em 30 dias, pendências) e a busca da paleta. Teste: `titles`.
- `titles.ts`: títulos a pagar e a receber (spec 005) com o espelho (006): criar, editar, cancelar, reabrir, excluir/arquivar, encerrar série (`previewSeriesEnd`/`applySeriesEnd`), aceitar e contestar o espelho. Testes: `titles`, `title-pairs`.
- `title-pair.ts`: insere o título e o espelho na mesma transação, com os ids gerados antes. Testes: `titles`, `title-pairs`.
- `settlements.ts`: baixas (com a perna do espelho, na ordem que as checagens deferidas esperam), definir a conta depois, estorno e a correção da data dele. Testes: `titles`, `operation`.
- `transfers.ts`: transferências (par de movimentos que soma zero). Testes: `titles`, `account-summary`.
- `recurrence.ts`: materializa as séries até 12 meses à frente; a ocorrência nova copia a conta prevista e o contrato da mais recente. Testes: `titles`, `contracts`.
- `series-core.ts`: os ajustes de reconhecimento da série (`termsOf`, `TERMS_SQL`, `termsColumns`, o teto `assertTolerance`) e o `ruleDto`.
- `series.ts`: a série como obrigação (spec 034): `SeriesDto` pela caixa, `insertObligation` na conta (a série na caixa da conta, a 1ª ocorrência com a conta prevista e o espelho, materializada) ou no cartão (`card_recurring_charges`), `setSeriesContract` para ligar e desligar, `planSeriesChange` ("esta e as próximas" com a data de efeito, inclusive o degrau do valor no cartão), `updateSeries` e encerrar/estender pela regra. Testes: `contracts`, `statements`, `charge-link`, `title-pairs`.
- `planned-account.ts`: a conta prevista do título, sempre da caixa dele (colunas, nomes e `assertPlannedAccount`). Testes: `contracts`, `statements`.
- `card-core.ts`: o núcleo do cartão sem permissão (datas e criação das faturas, parcelas das compras, fechamento e reabertura). Teste: `cards`.
- `cards.ts`: visão do cartão, faturas, compras, fechamento, pagamentos e a compra ligada à cobrança (`charge` no cadastro, `linkPurchaseCharge`, `expectedCharges`), e o `cardMaintenance` do worker. Testes: `cards`, `contracts`, `charge-link`.
- `card-charges.ts`: as ocorrências esperadas do cartão pelo calendário da série, sem as já cobradas, `chargeTarget` e `insertChargePurchase`. Testes: `cards`, `contracts`, `charge-link`.
- `statements.ts`: import de extratos (`importStatement`: OFX/CSV, dedup, regras na importação e, com `provisional`/`supersede`, o lote provisório e a troca pela `supersedeInTx`), `ruleFor(tx, { accountId, cardCaixaId }, …)`, `candidatesFor` (movimentos, títulos, as ocorrências de série pela regra da série na conta prevista, `seriesCandidates`, e, na fatura, os itens e as cobranças esperadas), `obligationMatches` ("É o pagamento de…?" do cofre), `cardChargeSuggestions` (a sugestão da fatura no `getImport`), o `autoMatch(ctx, tx, lote)` com a baixa sem confirmação num savepoint (`auto_settled`; no cartão, a compra ligada) e o aviso do sino por lote, as listagens e a busca nos lotes, e `assertNotSuperseded` (lote substituído é somente leitura). Testes: `statements`, `contracts`, `statement-supersede`.
- `statement.ts`: o extrato e o resumo de uma conta, lidos só para ela (`accountStatement`, `accountSummary`, `accountCategoryEntries`; tarefa 092). Teste: `account-summary`.
- `reconciliation.ts`: as ações sobre as linhas (confirmar em lote, casar, criar o lançamento, ignorar, desfazer; `created_entry` e `auto_settled` limpos juntos, `UNLINKED`), `createChargeFromLine` ("Lançar como cobrança de…"), o desfazer de `transfer_settlement` (histórico da F19, `deleteSettlementLegs`), os mapeamentos CSV e as regras por conta da spec 032 (`resolveRuleTarget` — conta corrente/poupança ou cartão, exatamente um —, `listRules`, `applyRulesToAccount`, `planRuleCopy`/`copyRules` com os pulos `exists`/`archived` e o `learnRule` na conta da linha) e as sugestões de classificação. Testes: `statements`, `admin-routes`.
- `reconciliation-guards.ts`: movimento conciliado não se apaga; a sugestão que aponta para o registro sai antes de apagá-lo. Teste: `statements`.
- `line-settle.ts`: `settleFromLine`, a baixa repartida feita a partir da linha (principal, multa, juros, desconto pelos ajustes da série; `lineSplit`, também na prévia das tools), sempre na conta da linha e num título da caixa dela, com `created_entry` `settlement` e nunca uma transferência. Testes: `statements`, `contracts`.
- `statement-supersede.ts`: o lote provisório e a troca pelo consolidado numa transação (spec 031): marcar provisório, `supersedeInTx`, as sobras pendentes (casar, manter, excluir) e o fluxo JSON `supersede_pairs` com a sugestão e a aprovação em lote; a regra fixa é `pairSupersedeLines` do shared. Teste: `statement-supersede`.
- `contracts.ts`: o contrato com vigência e obrigações (specs 020 e 034): criar com as obrigações, `contractOwner`, obrigação nova e ligar série, aditivo pelas séries, rescisão (canceladas, a última ajustada, as séries terminando e a multa avulsa), renovar estendendo as séries, `syncLifecycle` da renovação automática, o painel e `contractPayments` sobre a função `contract_payments`. Teste: `contracts`.
- `contract-documents.ts`: PDF (anexo imutável), markdown versionado (restaurar cria versão nova), a leitura do PDF e a conversão em markdown por IA. Teste: `contracts`.
- `contract-worker.ts`: renova pelo mesmo prazo ou encerra no fim da vigência, com um acesso de sistema, os avisos da vigência e `contract_charge_missing`. Teste: `contracts`.
- `attachments.ts`: anexos no Postgres (bytea, até 20 MB) ligados a títulos, baixas, movimentos, compras e entidades. Testes: `operation`, `chat-media`.
- `audit.ts`: histórico (o da entidade inclui `entity_tag_links`) e fechamento de mês (spec 008). Testes: `operation`, `entity-tags`.
- `title-entry.ts`: boleto, PIX copia-e-cola, NF-e e o ponto de extensão da leitura por IA (spec 010). Testes: `operation`, `agent-tools`, `cnpj-alfanumerico`.
- `calendar.ts`: itens por vencimento e o saldo por dia, realizado e projetado (spec 012). Teste: `operation`.
- `reports.ts`: relatórios e `scopeCaixas` (caixas legíveis + cartões das pagadoras escolhidas). Testes: `vision`, `entity-tags`.
- `flow.ts`: canvas de fluxo e as posições dos nós por usuário. Testes: `vision`, `entity-tags`.
- `messages.ts`: destinos Telegram (o `bot_token` nunca lido; `inboundToken` por `telegram_inbound_bot_token`), assinaturas, outbox, "enviar teste" e `deliver`. Testes: `vision`, `autonomous`.
- `message-worker.ts`: o laço de mensagens (`messageTick`): produtor de eventos com dedup, notificações do sino, `noteRemindersTick`, consumidor da outbox (retry, o 429 que adia) e `emitAgentEvent` (avisos dos agentes). Testes: `vision`, `budgets`, `contracts`.
- `notifications.ts`: o sino, só as do próprio usuário. Testes: `vision`, `autonomous`.
- `notes.ts`: anotações e lembretes (spec 035): visibilidade e edição pelo `Access` (`assertReadNote`/`assertWriteNote`/`noteVisibleTo`), a listagem com período por `note_occurrences` e cursor, o calendário pelo `note_calendar`, nota e lembrete na mesma transação com a data da nota = início, arquivar, o selo `noteBadge` da listagem de entidades por `noteCountsSql`, o log de disparos com `shouldRing`, dispensar, adiar, marcar todos e as preferências. Teste: `notes`.
- `note-worker.ts`: `noteRemindersTick` no `messageTick`: `note_reminder_claim`, o sino e a outbox para os destinos Telegram pessoais ativos, dedup `note_reminder:<disparo>:<adiamentos>`. Teste: `notes`.

## Serviços da IA (`src/services`)

- `conversations.ts`: sessões (spec 026): uma ativa por usuário e agente, `ensureActiveSession`/`sendToAgent` (também pelo Telegram e pelas tarefas), `finishSession` parando a execução, bifurcar, `listThreads`/`listSessions`/`getThread` e as decisões das confirmações (os segredos digitados vão ao `executeSecretTool`). Teste: `agents`.
- `chat-media.ts`: upload do chat (tipo normalizado, duração, páginas, a transcrição enfileirada), os derivados, o "tentar de novo" e o texto→áudio por mensagem e trecho (spec 025). Teste: `chat-media`.
- `ai-admin.ts`: provedores (chave write-only), preços, agentes com as versões do prompt, restaurar e o "Ver prompt montado", kits de ferramentas com duplicar, MCP e uso. Testes: `agents`, `agent-prompts`, `capabilities`.
- `ai-settings.ts`: Minha conta → IA (instruções e caixa principal do usuário). Teste: `agent-prompts`.
- `ai-flows.ts`: a IA nos fluxos com o agente dos fluxos (o marcado ou o primeiro ativo): leitura de documento, sugestões da conciliação e a conciliação com IA ao importar (`reconcileImportWithAi`, o estado e o interruptor). Testes: `agents`, `autonomous`.
- `ai-requests.ts`: requisições ao provedor (lista com cursor, detalhe, download dos corpos), o resumo com `ai_provider_health` e `app_settings` (GET/PUT/DELETE, `requestRetentionDays`; spec 023). Teste: `ai-requests`.
- `ai-budgets.ts`: orçamentos e `assertCanStartRun` (limite por minuto e `ai_budget_check`, admin isento do orçamento; chamado em `sendMessage` e nos fluxos), `exceededBudget` (o runner, antes de cada chamada), `budgetAlerts` (para o `message-worker`), `usagePanel` e `myUsage` (spec 028). Teste: `budgets`.
- `api-tokens.ts`: tokens pessoais do `/mcp` (só o SHA-256 no banco; o token aparece uma vez), inclusive os do admin para qualquer usuário (Controle MCP). Teste: `agents`.
- `agent-tasks.ts`: tarefas agendadas (spec 029): CRUD do dono e do admin, `tasksTick` do laço de `agents/worker.ts` e o "Rodar agora", com a reserva, a sessão `scheduled_task` e a execução numa transação. Teste: `autonomous`.
- `autonomous-notify.ts`: o aviso `ai_awaiting_approval` (sino e eventos) dos fluxos autônomos. Teste: `autonomous`.
- `telegram-inbound.ts`: o Telegram de entrada (spec 029): webhook com segredo e dedup, pareamento, comandos, mídia, botões e a resposta ao chat entregue pelo runner, com o "digitando…". Teste: `autonomous`.
- `reconcile-recipes.ts`: receitas de conciliação (spec 030): CRUD com `Access`, as receitas do lote, o play `runRecipe` e a fila do import (`enqueueImportRecipes`, `startNextRecipe`, `recipesTick` no laço de `agents/worker.ts`), sempre com `ai_reconcile_import_lock`/`busy` na transação que cria a execução; `insertReconcileSession` serve também à conciliação genérica. Teste: `reconcile-recipes`.

## Backup (`src/services/backup`, spec 019)

- `catalog.ts`: o catálogo do pg_catalog e a configuração do domínio (recursos, chaves naturais, filhos do dono, segredos, cluster das checagens no COMMIT); `COMPOSITE_KEYS` para as tabelas sem `id` (`entity_tag_links`, `ai_tool_kit_tools`, `app_settings` pela `key`, `ai_agent_inferences` por agente e capacidade).
- `export.ts`: o retrato REPEATABLE READ somente leitura, no formato que a importação devolve ao banco.
- `import.ts`: merge genérico por registro com savepoints, replay de estados e os ajustes de linha (agente dos fluxos sem a marca se o banco já tem um, finalidade das conversas antigas, kit para o agente anterior à F7, sessão ativa a mais de um par vira `import_conflict`, `notes` com o `object_id` traduzido pela FK da coluna gerada `entity_id`, em `normalizeRow`/`translate`, sem os disparos) e os arquivos antigos (`legacyCapabilities` da F10, `legacyClassificationRules` da F18).
- `legacy-contracts.ts`: arquivo anterior à F20 convertido pelo critério da migração 0052.
- `dump.ts`: pg_dump/pg_restore/psql pela `DATABASE_OWNER_URL` (`PG_BIN_DIR`).
- `lock.ts`: uma operação de backup por vez, por uma trava no banco (tarefa 172).
- `unzip.ts`: extração dos .zip com o teto real dos bytes descompactados (tarefa 055).
- Teste: `backup` (importa num banco novo de `freshDatabase()`; `dropFreshDatabases()` apaga esses bancos no fim, inclusive contra um banco externo).

## Agentes (`src/agents`, spec 011)

- `llm/`: os adaptadores normalizando para os blocos neutros (`types.ts`): `anthropic.ts` (streaming, tools, os pontos de cache da spec 022 e os interruptores de cache e raciocínio do provedor) e `openai.ts` (Chat Completions e compatíveis; `embed`/`transcribe`/`speak`, spec 024); `index.ts` (`createLlmClient`); `request-log.ts` (o invólucro único das chamadas pela opção `fetch` dos SDKs, com `maxRetries: 0`: cada chamada em `ai_requests`, as tentativas próprias em `ai_request_attempts`, corpos só com `log_bodies`; spec 023); `attachment-label.ts` (o rótulo do anexo para o modelo). Testes: `agents`, `ai-requests`, `capabilities`.
- `runner.ts`: o loop da execução (claim, heartbeat, eventos, confirmações, cancelamento, retomada, título, uso), em transações curtas e nunca durante a chamada ao modelo; separa o fluxo JSON do fluxo com tools (`TOOL_FLOW_PURPOSES` de `flows.ts`). Testes: `agents`, `autonomous`, `budgets`.
- `agents/worker.ts`: a fila (`ai_run_claim`, até `AGENT_CONCURRENCY`, retomando as de um worker que caiu), as transcrições, `tasksTick` e `recipesTick`, e a manutenção (`AGENT_MAINTENANCE_MS`): eventos e confirmações esquecidas de mais de 7 dias, embeddings (indexar e purgar), `purgeAiRequests`, o fechamento das requisições interrompidas e a retenção operacional `purgeOperational` (tarefa 103). Testes: `agents`, `autonomous`, `maintenance`, `ai-requests`.
- `prompt.ts`: o prompt da spec 022 (partes estável, por usuário e volátil com os pontos de cache, o contexto automático pelo `Access`, as `instructions` dos MCP por modo). Teste: `agent-prompts`.
- `tools-runtime.ts`: as tools da execução: as internas pelo kit da spec 021 (`kitTools` do shared, relido a cada chamada; `registerInternalTool` só nos testes), as MCP prefixadas, `executeSecretTool` (a tool de segredo, só na API) e o escopo das receitas (`assertRecipeScope`). Testes: `agents`, `agent-tools`, `reconcile-recipes`.
- `tool-handlers.ts`: execução e prévia das tools sobre os serviços (o `TOOL_HANDLERS`); os lotes em `tool-handlers-operation.ts` (F13a: contratos, importação a partir de anexo, cartão, caixas e contas, títulos, categorias e regras, inclusive `copy_classification_rules`), `tool-handlers-admin.ts` (F13b: configuração de IA, usuários e tokens, backup, fechamento e auditoria, mensagens e tags; teste `agent-tools-admin`), `tool-handlers-recipes.ts` (receitas; teste `reconcile-recipes`), `tool-handlers-supersede.ts` (lote provisório; teste `statement-supersede`), `tool-handlers-notes.ts` (anotações; teste `notes`) e `tool-handlers-mcp.ts` (as só do `/mcp`, como `upload_file`, que grava o arquivo em base64 e devolve o `attachmentId`). Teste geral: `agent-tools` (prévia, execução, permissão negada, anexo de outra sessão e o `/mcp` de cada tool).
- `tool-helpers.ts`: os tipos dos handlers, os nomes das prévias, `listPage` (offset/limit) e `toolAttachment` (o anexo da sessão como entrada). Teste: `agent-tools`.
- `mcp-client.ts`: o cliente MCP (Streamable HTTP; cabeçalhos secretos do banco, nunca logados). Testes: `agents`, `agent-prompts`.
- `events-hub.ts`: LISTEN `ai_run_events` → SSE e o aviso de conclusão no sino. Teste: `agents`.
- `store.ts`: SQL das tabelas de IA, com colunas listadas (nunca `search_tsv` nem segredos). Teste: `agents`.
- `flows.ts`: as finalidades dos fluxos e a leitura de documento e as sugestões como execuções normais. Testes: `agents`, `autonomous`.
- `inferences.ts`: `resolveInference`, `visionMode` e `inferenceCredentials` por `ai_capability_credentials` (spec 024). Teste: `capabilities`.
- `run-attachments.ts`: os anexos antes da chamada: visão direta, descrição pelo provedor de visão ou a camada de texto do PDF, com os derivados em `ai_attachment_derivatives`; espera a transcrição até `AI_TRANSCRIPTION_TIMEOUT_MS` (o áudio nunca vai ao modelo de texto). Testes: `capabilities`, `chat-media`.
- `pdf-text.ts` (e `pdfjs-worker.d.ts`): o pdf.js no servidor, sem worker separado; também `pdfPageCount`. Testes: `capabilities`, `chat-media`.
- `transcriptions.ts`: a fila das transcrições (spec 025): `ai_transcription_claim`, credenciais com a cerca, uso `transcription` e `complete`/`fail`. Testes: `chat-media`, `capabilities`.
- `embeddings.ts` e `search.ts`: o índice por par provedor+modelo em uso (`ai_embedding_indexes_touch` antes de gravar, purga dos parados) e a busca `semantic_search` pelo par do agente. Teste: `capabilities`.

## Integrações (`src/integrations`)

- `integrations/lookup.ts`: CNPJ no CNPJ Aberto (com `CNPJ_ABERTO_ENABLED` e a chave) ou na BrasilAPI, com o fallback, e CEP no ViaCEP; indisponível = 503, inexistente = 404 (spec 003). Teste: `lookup`.
- `integrations/telegram.ts`: a Bot API em `TELEGRAM_API_BASE`: `sendMessage` e, na entrada, `setWebhook`, `deleteWebhook`, `sendChatAction`, `answerCallbackQuery`, `getFile` e o download. Testes: `vision`, `autonomous`, `notes`.

## Testes (`test/`)

- Integração contra Postgres 18 real: `global-setup.ts` (Testcontainers ou, com `MONEYFLOW_TEST_DB=local`, `local-db.ts` sobre o Postgres de desenvolvimento), `migrate.ts` e `helpers.ts`. Os testes sobem com `AI_RUNS_PER_MINUTE=1000`.
- Modo local, em detalhe: as migrations ficam no banco modelo `moneyflow_it_tpl`, refeito quando `database/migrations` muda, e cada execução recria `moneyflow_it` por cópia dele; `MONEYFLOW_TEST_LOCAL_DB` dá outro nome ao banco (worktrees em paralelo), e o modelo vira `<nome>_tpl`. Os bancos de teste são criados pelo superusuário (`MONEYFLOW_TEST_LOCAL_SUPER_URL`) com dono `moneyflow_owner` e migrados por ele (`MONEYFLOW_TEST_LOCAL_OWNER_URL`), como no initdb (tarefa 054); o Testcontainers faz o mesmo. A ida e volta do dump em `backup.test.ts` precisa do cliente do PostgreSQL 18 (`pg_dump`, `pg_restore`, `psql`) no `PATH` ou em `PG_BIN_DIR`; sem ele, o teste fica como pulado.
- `helpers.ts`: `startApp` (a API sobre o banco de teste), `userSession`/`login`/`client`, `scenario`, `freshDatabase()`/`dropFreshDatabases()`, `newSession()` (finaliza a ativa do par, para começar do zero), `stopLeftoverRuns`, `alphaCnpj()` (CNPJ alfanumérico), `minimalPdf()` e `TINY_PNG`. Fixtures fictícias em `test/fixtures` (o `nfe-cnpj-alfanumerico.xml` inclusive).
- Falsos: o provedor de IA `e2e/fakes/fake-llm.ts` (erro HTTP com cabeçalhos e a queda no meio do stream: `status`, `headers`, `dropAfter`; `/v1/audio/transcriptions` com `audioQueue` para texto, atraso ou falha; `/v1/audio/speech` com `speechFormat = 'wav'` e `silentWav()`; `dimensions`; o prefixo `/nolist`), a Bot API `e2e/fakes/fake-telegram.ts` e o MCP `test/fakes/fake-mcp.ts` (com `instructions` opcionais); `e2e-fakes.test.ts` confere os falsos.
- Por área, além dos citados acima:
  - agentes: `agents.test.ts` (inclui o `describe('sessões (spec 026)')` e o Controle MCP), `agent-tools.test.ts` (F13a), `agent-tools-admin.test.ts` (F13b), `agent-prompts.test.ts` (F8: ordem do prompt e pontos de cache, variáveis, contexto, versões, MCP por modo), `ai-requests.test.ts` (spec 023), `capabilities.test.ts` (spec 024), `chat-media.test.ts` (spec 025), `budgets.test.ts` (028), `autonomous.test.ts` (029, com a Bot API falsa);
  - domínio: `reconcile-recipes.test.ts` (030), `statement-supersede.test.ts` (031), `contracts.test.ts` (obrigações, extrato, cofre, cartão e "não cobrada", aditivo, renovação, rescisão), `statements.test.ts` (inclui o `describe` das ocorrências de série), `notes.test.ts` (API, worker, tools e `/mcp`), `backup.test.ts` (ida e volta, arquivos antigos e o `describe` de anotações), `entity-tags.test.ts`, `cnpj-alfanumerico.test.ts` (spec 003);
  - infraestrutura: `generated-schema.test.ts` (o schema Drizzle e as migrations, tarefa 163) e `db-pool.test.ts` (os prazos do pool e a conexão que cai).
- Comandos: `pnpm --filter @moneyflow/server test:local test/titles.test.ts -t "estorno"` (um caso no Postgres local), `pnpm --filter @moneyflow/server exec vitest run test/agents.test.ts -t "retomada"` (Testcontainers) e `pnpm --filter @moneyflow/server test:coverage` (cobertura do v8).
