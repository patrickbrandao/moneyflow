---
status: concluida
tipo: melhoria
origem: agente
autor: triage
responsavel: app
prioridade: media
criada: 2026-10-13
commit: 7708396
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
Feito em 2026-10-13, sobre a 0034 do dba (`ai_agents.use_for_flows`).

- Escolha: `flowAgentId` (`apps/server/src/services/ai-flows.ts`) usa o agente marcado, se ele e o provedor estiverem ativos; senão o primeiro ativo com provedor ativo (instalação nova funciona sem configurar nada). Vale para os quatro fluxos (leitura de documento, conciliação e, por `contract-documents.ts`, leitura do contrato e PDF → markdown).
- Admin (`services/ai-admin.ts`): `useForFlows` na criação e na edição; marcar um desmarca o atual antes, na mesma transação (`clearFlowAgent`); desativar (`isActive: false`) tira a marca no mesmo UPDATE e arquivar (exclusão que vira arquivamento) também. Marcar um agente inativo cai no CHECK do banco, traduzido. DTO `AiAgentDto.useForFlows` e schema em `packages/shared/src/agents/`.
- Erros do banco traduzidos em `packages/shared/src/i18n/errors.ts`: `ai_agents_use_for_flows_key`, `ai_agents_use_for_flows_check` e, das tarefas 001/003, `ai_conversations_purpose_check`, `ai_conversations_purpose_immutable_check` e `ai_usage_purpose_check`.
- Tela: /admin/ai → Agentes ganhou "Usar nos fluxos automáticos" no formulário (desligado enquanto o agente está inativo, com a explicação) e o selo "Fluxos" (tom de acento) na lista (`apps/web/src/components/admin-ai/AgentsTab.tsx`; textos em `t.agentsUi.admin.agents`).
- `AI_FLOW_AGENT` removida de `apps/server/src/config.ts`, `.env.example`, `docker-compose.yml` e `README.md` (com a nota: quem usava a variável marca o agente na tela). Spec 011 atualizada.
- Backup (spec 019, decisão): na importação, o agente marcado do arquivo entra com a marca só se o banco ainda não tem um marcado; senão entra sem ela (em vez de virar conflito). Também, num arquivo anterior à coluna `ai_conversations.purpose`, a finalidade vem de `screen_context.purpose` (quando válida) e a chave sai do `screen_context` (`normalizeRow` em `services/backup/import.ts`). Spec 019 e AGENTS.md atualizados.
- Achado e corrigido no caminho: `aiAgentUpdateInput` era `aiAgentCreateInput.partial()`, e no Zod 4 o `.partial()` mantém os `.default()`. Um PATCH com um campo só (ex.: `{ useForFlows: true }` ou `{ isActive: false }`) desativava o agente, zerava o prompt, a cor e a confirmação de escrita. A tela não sofria, porque manda o formulário inteiro. Agora os campos ficam num objeto sem padrões, e só a criação aplica os padrões.

Testes: `apps/server/test/agents.test.ts`, no teste "agente dos fluxos escolhido no admin…": marcar B faz a leitura de documento usar B, marcar C desmarca B, marcar um inativo dá 422 traduzido, desativar o marcado tira a marca e cai no primeiro ativo, e arquivar o marcado tira a marca. `apps/server/test/backup.test.ts`, no teste "agente dos fluxos entra sem a marca se já há um marcado…": com um marcado no banco, o agente do arquivo entra sem a marca; a conversa antiga ganha `document_reading` e fica fora da lista; sem marcado, o do arquivo entra marcado. `packages/shared/test/agents.test.ts`, em "entrada do agente (admin)": padrões na criação e PATCH parcial sem padrões. O e2e do admin não foi acrescentado, porque a regra está coberta na integração e a mudança na tela é um checkbox e um selo.
