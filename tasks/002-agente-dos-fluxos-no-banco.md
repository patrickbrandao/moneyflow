---
status: em-andamento
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: media
criada: 2026-10-11
commit:
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
