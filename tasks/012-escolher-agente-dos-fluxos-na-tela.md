---
status: em-andamento
tipo: melhoria
origem: agente
autor: triage
responsavel: app
prioridade: media
criada: 2026-10-13
commit:
---

# Escolher o agente dos fluxos em /admin/ai e remover `AI_FLOW_AGENT` (depois da 002)

## Descrição
Parte da aplicação da tarefa 002. Com a marca `ai_agents.use_for_flows` no banco, o agente dos fluxos (leitura de documento, sugestões da conciliação, leitura do PDF do contrato e PDF → markdown) passa a ser escolhido pelo admin na tela, e a variável `AI_FLOW_AGENT` deixa de existir.

**Começa só depois da 002 concluída pelo dba.**

## Como reproduzir
Ver `apps/server/src/services/ai-flows.ts` (`flowAgentId`) e `.env.example`.

## Análise (triagem)
- `apps/server/src/services/ai-flows.ts` → `flowAgentId`: usar o agente marcado (ativo, com provedor ativo). Sem marcado, manter o primeiro ativo, como hoje, para uma instalação nova funcionar sem configuração. Também atende `services/contract-documents.ts`.
- Remover `aiFlowAgent` de `apps/server/src/config.ts`, `AI_FLOW_AGENT` de `.env.example`, `docker-compose.yml` e `README.md`. Registrar na nota da versão que quem usava a variável marca o agente na tela.
- Admin: `services/ai-admin.ts` (criar/editar agente com `useForFlows`; ao marcar um, desmarcar o anterior na mesma transação; ao desativar ou arquivar o marcado, desmarcar, conforme o que o dba decidir na 002), schemas e DTO em `packages/shared/src/agents/`, e `apps/web/src/components/admin-ai/AgentsTab.tsx` (opção "Usar nos fluxos automáticos", com o selo na lista).
- `pnpm db:pull`. Spec 011 (linha do "agente dos fluxos") e 019, se o backup precisar de nota.
- Testes: integração (marcar B faz a leitura de documento usar B; sem marca usa o primeiro ativo; backup com a marca) e, se couber, o e2e do admin.

Ordem: 002 (dba) → 012. Esforço: médio (~2–3 h).

## Resolução (executor)
