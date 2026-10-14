---
status: aberta
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
