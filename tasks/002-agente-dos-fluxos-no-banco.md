---
status: concluida
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: media
criada: 2026-10-11
commit: 499da8a
---

# Marcar no banco qual agente atende os fluxos automáticos

## Descrição
Hoje o agente usado na leitura de documento e nas sugestões da conciliação vem da variável `AI_FLOW_AGENT` (pelo nome) ou é o primeiro agente ativo. Pedido: uma marca em `ai_agents` (ex.: `use_for_flows boolean`, no máximo um ativo) para o admin escolher pela tela; depois o `app` remove a variável e expõe a escolha em /admin/ai.

## Como reproduzir
Ver `apps/server` (resolução do agente dos fluxos) e o `.env.example`.

## Análise (triagem)
**Procede** (conferido em 2026-10-13).

- `apps/server/src/services/ai-flows.ts` → `flowAgentId()`: primeiro agente ativo (com provedor ativo) por `created_at`, filtrado pelo nome de `AI_FLOW_AGENT` (`apps/server/src/config.ts`, `aiFlowAgent`) quando a variável existe. Desde os contratos, `services/contract-documents.ts` (`runFlow`) também usa `flowAgentId`, então a escolha vale para quatro fluxos: leitura de documento, sugestões da conciliação, leitura do PDF do contrato e PDF → markdown.
- A variável aparece em `.env.example`, `docker-compose.yml`, `README.md` e na spec 011 (linha do "agente dos fluxos").
- `ai_agents` (`0024_ai_providers_and_agents.sql`) não tem marca nenhuma. Ela é auditada e entra no backup (spec 019, `services/backup/catalog.ts`, chave natural `lower(name)`).

**Parte do banco (esta tarefa, dba):**
1. `ai_agents.use_for_flows boolean NOT NULL DEFAULT false` e um índice único parcial (`WHERE use_for_flows`) para haver no máximo um marcado.
2. Recomendação: o marcado precisa estar ativo e não arquivado (CHECK `NOT use_for_flows OR (is_active AND archived_at IS NULL)`). Assim, desativar ou arquivar o agente marcado exige desmarcar antes; a aplicação faz isso na mesma transação. A alternativa é um trigger que desmarca sozinho ao desativar; o dba escolhe e registra na 016.
3. `COMMENT ON COLUMN`, pgTAP (0024) e spec 016. Conferir que um backup com dois agentes marcados não quebra a importação: o segundo deve voltar como conflito (spec 019), não abortar.

Depois: **tarefa 012** (app) usa a marca, remove `AI_FLOW_AGENT` e expõe a escolha em /admin/ai.

Comportamento sugerido sem agente marcado (fica na 012, sem bloquear): continuar no primeiro agente ativo, para uma instalação nova funcionar sem configuração, como hoje.

Risco: baixo. Verificação: `make -C database test`; marcar dois agentes falha (23505); marcar um inativo falha (23514).

Ordem: 002 (dba) → 012 (app). Esforço: pequeno (~1 h).

## Resolução (executor)
Feito em 2026-10-13 (dba), na migration `database/migrations/0034_ai_agents_use_for_flows.sql`.

- `ai_agents.use_for_flows boolean NOT NULL DEFAULT false`.
- No máximo um marcado: índice único parcial `ai_agents_use_for_flows_key ON ai_agents ((true)) WHERE use_for_flows` (`23505`).
- Escolha: **CHECK**, não trigger. `ai_agents_use_for_flows_check`: `NOT use_for_flows OR (is_active AND archived_at IS NULL)` (`23514`). Desativar ou arquivar o marcado é recusado até desmarcar; a aplicação desmarca no mesmo UPDATE/transação. A troca fica explícita e auditada (`ai_agents` é auditada). Registrado na spec 016.
- Backup (spec 019): a importação grava cada registro num savepoint, então um segundo agente marcado no arquivo (ou um marcado quando o banco já tem outro) sai como conflito `23505`, sem abortar. Efeito colateral: o agente inteiro não entra. Recomendação para a 012 (app): na importação, gravar `use_for_flows = false` quando o banco já tem um marcado (ou sempre), para o agente entrar sem a marca.
- `COMMENT ON COLUMN`, pgTAP em `database/tests/0024_ai_providers_and_agents.sql`, `schema.sql` e `packages/db/src/generated` regenerados.

Verificação: `make -C database test` verde (marcar dois → 23505; marcar inativo, desativar ou arquivar o marcado → 23514). Próximo: tarefa 012 (app).
