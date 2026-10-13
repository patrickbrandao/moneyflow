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

# Gravar e mostrar o uso de IA por finalidade (depois da 001)

## Descrição
Parte da aplicação da tarefa 001. As execuções dos fluxos (leitura de documento, sugestões da conciliação, leitura do PDF do contrato, PDF → markdown) são gravadas em `ai_usage` como `chat`, e o painel de uso não separa esses custos. Depois que o banco aceitar as finalidades dos fluxos (001) e a coluna `ai_conversations.purpose` existir (003/013), a aplicação grava a finalidade certa e o painel mostra o recorte.

**Começa só depois da 001 concluída pelo dba** (e, de preferência, da 013).

## Como reproduzir
Usar a leitura de documento com um agente ativo e ver em `ai_usage` a linha com `purpose = 'chat'`. Em /admin/ai → Uso, não há recorte por finalidade.

## Análise (triagem)
- `apps/server/src/agents/runner.ts`: o INSERT em `ai_usage` no loop grava `'chat'` fixo. Passa a gravar a finalidade da execução (a de `conversation.purpose` depois da 013). Se o dba fizer o trigger derivar a finalidade da conversa (001, item 3), basta não forçar `'chat'`.
- `apps/server/src/services/ai-admin.ts` → `usageReport`: incluir `byPurpose` a partir da view `ai_usage_monthly_by_purpose` (001). `AiUsageReport` em `packages/shared/src/agents/types.ts`, rótulos em `i18n/areas/agents*.ts` e a tabela em `apps/web/src/components/admin-ai/UsageTab.tsx`.
- `pnpm db:pull` depois da migration. Spec 011 (uso e custo) atualizada.
- Testes: integração (`agents.test.ts`, leitura de documento e contrato) conferindo `ai_usage.purpose` e o `byPurpose` do relatório.

Ordem: 001 + 003 (dba) → 013 → 011. Esforço: pequeno a médio (~2 h).

## Resolução (executor)
