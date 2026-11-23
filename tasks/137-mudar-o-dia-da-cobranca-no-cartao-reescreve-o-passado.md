---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: d658050
---

# Mudar o dia de uma cobrança no cartão (aditivo ou edição da série) reescreve as datas esperadas do passado

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** "esta e as próximas" na cobrança esperada
- **Arquivos afetados:** `apps/server/src/services/series.ts:549-551`, `apps/server/src/services/series.ts:556-612`, `apps/server/src/services/contracts.ts:693-706`, `apps/server/src/services/series.ts:716-727`, `apps/server/src/services/card-charges.ts:93-97`, `packages/shared/src/recurrence.ts:33-37`, `database/schema.sql:5830,5837`, `docs/034-contratos-sobre-series.md:39,87`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Numa assinatura paga no cartão, um aditivo (ou a edição da série) que muda o dia da cobrança "a partir de março" muda também as datas esperadas de todos os meses anteriores. A guia Pagamentos passa a mostrar atrasos e adiantamentos diferentes para cobranças antigas, e uma ocorrência passada pode virar "não cobrada", com aviso no sino.

### Evidência e análise técnica
- No ramo do cartão de `planSeriesChange`, o dia novo só faz `UPDATE recurrence_rules SET anchor_day` (`series.ts:610`). Não há degrau por ocorrência, como existe para o valor em `card_recurring_charge_amounts` (`series.ts:591-602`).
- As ocorrências do cartão não são materializadas. A data esperada é sempre recalculada do início da série com o dia âncora atual: `addMonths(rule.startsOn, (n - 1) * step, rule.anchorDay)` (`recurrence.ts:36`), inclusive a ocorrência 1. É o que usam `expectedCardOccurrences` (`card-charges.ts:95`) e `contract_payments` (`schema.sql:5830,5837`: `recurrence_occurrence_due(..., c.anchor_day, c.starts_on, n)`).
- O aditivo passa o `anchorDay` para toda série atingida, inclusive a de cartão (`contracts.ts:697-703`), e o `PATCH /api/series/:id` também (`series.ts:719`).
- Na série de títulos isso não acontece: as ocorrências passadas já existem com o vencimento delas, e só as em aberto desde a data de efeito mudam.

### Verificação (tentativa de refutação)
- A spec só fala do VALOR "dali em diante" no cartão (`docs/034:39`; decisões em `docs/034:87`: "o valor muda a partir da primeira ocorrência na data... descrição, categoria e pagadora valem para as próximas"). O dia não aparece, e o efeito retroativo não é intencional.
- O teste do cartão (`contracts.test.ts:583-615`) muda só o valor.

### Impacto
Contratos com cobrança no cartão que mudam o dia: o histórico de pontualidade (`days`, `onTimePercent`) muda, ocorrências antigas sem compra podem passar a "não cobrada" (a fatura esperada muda) e gerar `contract_charge_missing` até 120 dias para trás, e as sugestões da fatura deslocam.

## Como reproduzir
1. Obrigação no cartão, mensal, no dia 15, com compras ligadas de nov e dez.
2. `POST /api/contracts/:id/amendments` com `{ effectiveOn: "2027-03-01", ruleIds: [rule], anchorDay: 2 }`.
3. `GET /api/contracts/:id/payments`: as linhas de nov e dez mostram `dueDate` no dia 2 e `days` recalculado.

## Solução proposta
- Curto prazo: recusar a mudança de dia na série de cartão (422 com mensagem: "encerre a cobrança e crie outra com o novo dia"), na prévia e na aplicação do aditivo e do `PATCH`.
- Alternativa: dividir a série na data de efeito, encerrando a atual e criando outra ligada ao mesmo contrato com o dia novo e o valor vigente.
- Registrar a regra na `docs/034` (decisões, "Edição da série").

## Critérios de aceite
- [ ] Depois de um aditivo com mudança de dia numa cobrança no cartão, as datas esperadas das ocorrências anteriores à data de efeito não mudam (ou a mudança é recusada com mensagem clara).

## Testes recomendados
`apps/server/test/contracts.test.ts`, no `describe('obrigação no cartão')`: aditivo com `anchorDay` e conferência das linhas `card_charge` anteriores à data de efeito em `/payments`.

## Limitações e suposições
Nada foi executado. O efeito foi deduzido das fórmulas do calendário em `packages/shared` e do SQL de `contract_payments`.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: no ramo do cartão de `planSeriesChange`, o dia novo só fazia `UPDATE recurrence_rules SET anchor_day`. As datas esperadas (`occurrenceDueDate`, `contract_payments`) são recalculadas desde a 1ª ocorrência, então o passado mudava.

## Resolução (executor)

- Decisão (a de curto prazo da tarefa): a cobrança no cartão não muda de dia. `apps/server/src/services/series.ts`: `planSeriesChange` recusa a mudança do dia âncora numa série de cartão com 422 `card_charge_anchor_day` (`t.contracts.errors.cardAnchorDay`: "encerre a cobrança e crie outra com o novo dia"). A recusa vale na prévia e na aplicação do aditivo, no `PATCH /api/series/:id` e nas tools que passam por ali. O `UPDATE` morto do ramo saiu.
- `apps/web/src/components/contracts/ObligationFormModal.tsx`: o `SeriesEditModal` não mostra nem manda o dia numa cobrança no cartão.
- `docs/034-contratos-sobre-series.md` (decisões, "Edição da série").
- Teste: `apps/server/test/contracts.test.ts`, no `describe('obrigação no cartão')`, "a cobrança no cartão não muda de dia (aditivo ou edição): as datas esperadas do passado ficam (tarefa 137)". O aditivo e o `PATCH` com `anchorDay` dão 422, as datas de `/payments` não mudam e a descrição continua editável.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
