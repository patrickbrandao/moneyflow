---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit:
---

# Orçamentos com aviso e bloqueio, limite por minuto e painel de uso (F14)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [028](../docs/028-limites-e-uso.md), seção "Aplicação (app)". O que fazer: Checagem na criação de execução, nos fluxos e antes de cada chamada (`budget_exceeded`, admin isento), avisos com dedup no `message-worker`, limite por minuto (banco vence a variável), painel com gráficos, tabelas e CSV, uso próprio em Minha conta; testes e e2e.

Ordem: Depois da 030. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [028](../docs/028-limites-e-uso.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **`services/conversations.ts`**: `createConversation` e `sendMessage` devolvem 429 com `retry-after`.
- **Fluxos**: `services/ai-flows.ts` e `agents/flows.ts`.
- **`runner.ts`**: a checagem antes de `callModel` e o término com `budget_exceeded`, um código de erro novo em `t.agents.errors`.
- **`services/message-worker.ts`**: o produtor de eventos gera os avisos com dedup por (orçamento, mês, limiar).
- **`services/ai-admin.ts`**: `usageReport`.
- **Config**: `AI_RUNS_PER_MINUTE` e `AI_FLOW_RUNS_PER_MINUTE`.
- **Web**:
  - `components/admin-ai/UsageTab.tsx`: gráficos, tabelas e CSV por `lib/export.ts`;
  - `pages/AccountPage.tsx`: o uso próprio;
  - o sino.
- **Backup**: `ai_budgets` em `catalog.ts`.
- **Banco**: `pnpm db:pull` depois da 030.

**Riscos e observações**
- O `apps/web` não tem biblioteca de gráficos (`package.json`). É preciso escolher entre SVG próprio (seguindo o `dataviz` e os tokens do tema) e uma dependência nova.
- O admin fica isento do bloqueio, mas não do limite por minuto.
- O limite por minuto pode ser contado em `ai_runs.created_at`, sem tabela nova.

**Dependências**
- Depende da 030.
- Se o ponto 5 da 029 for aceito, as tools de orçamentos entram aqui.

**Como verificar**
- Os testes da 028: aviso uma vez só, 100% com o admin isento, `budget_exceeded` no meio da execução, fluxo pulado, uso sem preço, 429 e o banco vencendo a variável.
- O e2e do orçamento baixo.

**Pontos para a revisão da spec**
1. (028, Bloqueio) "Termina com o erro `budget_exceeded`" não diz se é um status novo. Recomendação: o status `failed`, com o código `budget_exceeded` no evento `error`, sem status novo em `ai_runs`.
2. Os pontos da 030 também valem aqui.

## Resolução (executor)
Feito pelo app em 2026-10-14 (sem commit; a sessão principal commita). A spec [028](../docs/028-limites-e-uso.md) ganhou a seção "Aplicação (app)" com as decisões abaixo e a dimensão modelo em `ai_usage_daily` (decisão do dba aceita); [011](../docs/011-agentes-de-ia.md), [013](../docs/013-mensagens-telegram.md), o `docs/INDEX.md` e o `AGENTS.md` foram atualizados.

**Banco**: `pnpm db:pull` (entram `ai_budgets` e as colunas novas das visões). O driver já converte `numeric` e `bigint` em número (`packages/db`), então `audio_seconds` não chega como string; o `SELECT u.*` de `usageReport` segue funcionando.

**Checagem** (`apps/server/src/services/ai-budgets.ts`)
- `assertCanStartRun(ctx, agente, éFluxo)`: limite por minuto e depois `ai_budget_check`; chamado em `sendMessage` (chat, leitura de documento, conciliação e contratos) e, nos fluxos, antes de abrir a conversa arquivada.
- Estourado: `429 budget_exceeded`, "Orçamento de IA do mês atingido: <escopo>", sem gravar mensagem nem execução. O admin que aciona não consulta o orçamento.
- Runner: antes de cada chamada ao modelo (`exceededBudget`), termina `failed` com o texto em `error` e o evento `error` com `code: 'budget_exceeded'` (campo `code` novo no evento); o que já foi feito fica.
- Conciliação logo após importar: pulada, com `aiSuggestion.skippedReason` (a tela mostra o aviso); "Sugerir com IA" devolve o 429.

**Limite por minuto**: `AI_RUNS_PER_MINUTE` (10) e `AI_FLOW_RUNS_PER_MINUTE` (30) em `config.ts`, no `.env.example` e no compose; `app_settings` vence (`runsPerMinute` em `ai-requests.ts`, as duas chaves em `SETTINGS` e em `APP_SETTING_KEYS`). Conta as execuções do usuário em `ai_runs` no último minuto, sessões e fluxos à parte; `429 rate_limited` com `retry-after` (o `AppError` ganhou cabeçalhos). Vale para o admin.

**Avisos** (`message-worker.ts`): `budgetAlerts()` lê `ai_budget_status()`; para cada orçamento em `alert`/`blocked`, o maior limiar (aviso ou 100), chave `ai_budget_alert:<orçamento>:<AAAA-MM>:<limiar>`.
- Sino: o usuário do escopo `user` (link `/account`) e todos os admins ativos (link `/admin/ai/usage`).
- Destinos: o global recebe todos; o pessoal de admin, todos; o pessoal de outro usuário, só o orçamento `user` dele; o de caixa, nenhum.

**API**
- `GET/POST /api/admin/ai/budgets` e `PATCH/DELETE /api/admin/ai/budgets/:id`. O valor entra em unidades da moeda (`monthlyLimit`) e é gravado em micros; o escopo e o alvo não mudam.
- `GET /api/admin/ai/usage/panel`: `ai_usage_daily`, `ai_usage_top_conversations` e `ai_provider_health` nos dias do período até hoje.
- `GET /api/account/ai/usage`.
- Erros traduzidos: `ai_budgets_active_key`, os `ai_budgets_*_check`, as FKs e `app_settings_value_check`; o `22023` do ranking vira 400 (a entrada já limita o período a 366 dias).

**Shared**
- `agents/budgets.ts`: entradas, DTOs, `cacheHitRate`, `budgetThreshold`, `budgetScopeLabel` e `formatMicros`.
- `ai_budget_alert` em `MESSAGE_EVENT_KINDS`, nos parâmetros (`{}`), nos tipos de evento e de notificação, `dedupKeys.aiBudgetAlert`, `budgetAlertMessage` e os textos.

**Web**
- Guia Uso reescrita (`UsageTab.tsx`): filtros numa linha, totais, três gráficos em SVG próprio (`usage-charts.tsx`), as tabelas top 20 sessões (abre a sessão em leitura), por modelo com saúde e por finalidade, com CSV/PDF.
  - Gráficos: custo por dia empilhado por provedor ou agente, tokens por dia e acerto do cache.
  - Seguem o `dataviz`, com a paleta validada pelo `validate_palette.js` nos dois temas, nos tokens `--chart-1…6` e `--chart-other` (nada roxo).
- `UsageBudgets.tsx`: seção Orçamentos (barra com as marcas do aviso e do bloqueio, CRUD) e o limite por minuto (banco × variável, "Usar o padrão").
- Minha conta → IA: `AiUsagePanel.tsx`.
- Ícone do sino; o evento nas assinaturas, sem filtro de caixa.
- Conferido no navegador (claro e escuro, dica no passar do mouse, modal do orçamento).

**Tools** (Configuração de IA, só admin): `list_ai_budgets` (read/allow), `create_ai_budget`, `update_ai_budget` e `delete_ai_budget` (write/ask, com prévia; a exclusão é destrutiva). **Para o dba**: acrescentar as quatro ao kit "Padrão" do `database/seeds/dev.sql`, no `suggestedMode` de cada uma (52+1 `allow`, 93+3 `ask`).

**Testes**
- `apps/server/test/budgets.test.ts` (8):
  - CRUD, unicidade e auditoria;
  - aviso em 80% uma vez só (sino do usuário e do admin, destino global e não o pessoal alheio) e depois o de 100%;
  - em 100% a execução nova recusada (usuário, agente e global) e o admin passando;
  - estouro no meio da execução (`budget_exceeded`);
  - orçamento de fluxos pulando a conciliação e recusando a leitura (o chat segue; o admin passa);
  - uso sem preço e em outra moeda fora do gasto;
  - limite por minuto com `retry-after`, o banco vencendo a variável, o admin limitado e os fluxos à parte;
  - o painel com filtros.
- `backup.test.ts`: `ai_budgets` vai e volta no JSON completo, a reimportação não duplica e um ativo repetido volta como conflito.
- `agent-tools-admin.test.ts`: as quatro tools com prévia, auditoria como agente e ausentes para quem não é admin.
- Shared: `budgets.test.ts` e o registro em `agents.test.ts`. Os testes de integração sobem com `AI_RUNS_PER_MINUTE=1000` (`helpers.ts`).
- e2e (`agentes.spec.ts`): orçamento baixo de um usuário criado na guia Uso, o aviso no sino, a conversa recusada com o escopo, Minha conta e a barra bloqueada. O arquivo grava `ai.runs_per_minute = 1000` no início e apaga no fim.

**Verificação**
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 137, servidor 194, banco de teste recriado e migrado) e `pnpm build`: ok.
- e2e `agentes.spec.ts` + `tema.spec.ts` contra a pilha (`TELEGRAM_API_BASE=…:18081`): 22 passaram; pilha parada.
