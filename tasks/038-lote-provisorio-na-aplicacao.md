---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-19
commit:
---

# Lote provisório e a troca pelo consolidado na aplicação (F17)

## Descrição
A seção "Aplicação (app)" da spec [031](../docs/031-lote-provisorio-e-consolidado.md): marcar provisório (import e depois), a dedup, a substituição numa transação (casamento fixo, transferência mudando o vínculo, desfechos), as sobras do provisório (casar, manter, excluir o lançamento), o fluxo de IA `supersede_pairs` com aprovação em lote, somente leitura do substituído, divergência e fechamento de mês, API, tools (`set_statement_import_provisional`, `supersede_statement_import`, `resolve_superseded_lines`) e as telas.

Ordem: depois da [037](037-lote-provisorio-no-banco.md).

## Como reproduzir
Não se aplica (recurso novo). Pronto: os testes de integração e o e2e da seção Testes da spec.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-19).

**Executor designado: app.**

## Resolução (executor)
Serviço `apps/server/src/services/statement-supersede.ts`, regra fixa `packages/shared/src/supersede.ts`, tools `SUPERSEDE_TOOLS`/`tool-handlers-supersede.ts`, rotas em `routes/statements.ts`, fluxo `supersede_pairs` em `agents/flows.ts`, telas em `components/reconciliation/SupersedePanel.tsx`, `ImportDetail.tsx`, `ImportModal.tsx` e `StatementImportPanel.tsx`. Testes: `apps/server/test/statement-supersede.test.ts` (transferência sem duplicar com avulso, baixa e título; sobras de cada lado; fechamento recusado; data deslocada pela sugestão da IA; intervalo zero depois da troca; troca na importação; as tools), `packages/shared/test/supersede.test.ts` e `e2e/tests/conciliacao-provisoria.spec.ts`; contagens da Conciliação em `agentes.spec.ts` (21 de 21, 4 leitura · 17 escrita). Decisões na seção "Decisões da implementação (F17)" da spec 031.
