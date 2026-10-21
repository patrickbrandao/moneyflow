---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-20
commit:
---

# Contratos sobre séries recorrentes na aplicação (F20)

## Descrição
A spec [034](../docs/034-contratos-sobre-series.md), menos a seção Banco: contrato como documento e vínculo com obrigações (séries em corrente, poupança ou cofre e cobranças esperadas no cartão), a regra de reconhecimento generalizada para toda série (ajustes na série), previstos no Extrato da conta, o "É o pagamento de…?" do cofre, a sugestão na fatura do cartão e a "não cobrada", aditivo/renovar/rescindir como operações da série, detalhe do contrato e Pagamentos, tools, backup antigo e testes. Reescrever as specs 020 e 033 por esta.

Ordem: depois da [043](043-contratos-sobre-series-no-banco.md).

## Como reproduzir
Não se aplica (redesenho). Pronto: os testes de integração e o e2e da spec.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-20).

**Executor designado: app.**

## Resolução (executor)
Implementada sobre a migration 0052 (tarefa 043), com o schema Drizzle regenerado (`pnpm db:pull`).

- **Shared**: `contracts.ts` sem o ciclo de parcelas (vigência, `termMonths`, `periodicityCalendar`, `occurrencePeriodEnd`, proporcional, reajuste, `stripInstallmentSuffix`); `reconcile.ts` com a regra generalizada para a série (`RecognitionTerms`/`SeriesTerms`, `seriesMatch`, `cardChargeMatch`, `pickSeriesOccurrences`, candidato `card_charge`); schemas do contrato com vigência e obrigações, `seriesCreateInput`/`seriesUpdateInput`, aditivo por obrigações, rescisão com `lastAmounts`, renovação por data; títulos com `plannedAccountId`/`seriesTerms` e o filtro `plannedAccountId`; compra com `charge`; tipos (`SeriesDto`, `ContractDetail` com obrigações, `ContractPaymentRow` com `card_charge`, previews novas); traduções das constraints novas (as que saíram foram removidas) e dos NOT NULL; tools de contrato e série.
- **Servidor**: `series-core.ts`, `series.ts`, `card-charges.ts`, `contracts.ts` reescrito, `contract-worker.ts` (renovação automática e encerramento, avisos pela vigência, `contract_charge_missing`), `recurrence.ts` (a ocorrência copia conta prevista e contrato, sem o " · n/N"), `titles.ts` (série com caixa e ajustes, conta prevista da caixa, "esta e as próximas" com a conta, encerrar pela regra), `line-settle.ts` (sem transferência), `statements.ts`/`reconciliation.ts` (candidatos pela série, sugestão e compra da cobrança no cartão, "É o pagamento de…?"), `cards.ts` (compra ligada, `expected-charges`, `charge-link`), backup (`card_recurring_charges`/`_amounts` no catálogo e o cluster, `legacy-contracts.ts` para arquivos antigos), tools (`add_contract_obligation`, `link_series_to_contract`, `renew_contract` no lugar de `decide_contract_renewal`, `get_series`, `create_series`, `update_series`, `create_card_charge_from_line`, `end_series` com `ruleId`). Removido o código da 033/F19 que não se aplica (conta das parcelas, passagem, transferência na baixa nova, geração por ciclo, recálculo do aditivo por ciclo, tarefas de renovação abertas, `renewalReminderDue`/`contractRenewalMessage`).
- **Console**: formulário do contrato (vigência + obrigações), obrigação/série (`ObligationFormModal.tsx` com `SeriesEditModal`), detalhe com obrigações, Pagamentos e Histórico, aditivo/renovar/rescindir, previstos no Extrato da conta com Baixar, "É o pagamento de…?" no cofre, sugestão "Lançar como cobrança de…" na fatura, "É cobrança de um contrato?" na compra, conta prevista e ajustes no título.
- **Docs**: 020 e 033 reescritas; 004, 005, 007, 009, 011, 019, 034 (decisões da implementação), 015 (F20 entregue), INDEX e AGENTS.md.
- **Testes**: `test/contracts.test.ts` reescrito (duas obrigações em contas diferentes, aluguel atrasado pelo extrato, baixa sem confirmação, cofre, cartão casado na fatura e a não cobrada, aditivo, renovar com o worker, rescindir, espelho, documentos, painel e avisos), `test/statements.test.ts` (ocorrências de série), `test/backup.test.ts` (ida e volta com obrigações e cobrança no cartão; arquivo antigo convertido), `test/agent-tools.test.ts`, unitários do shared; e2e `contratos.spec.ts` e `contratos-pagamentos.spec.ts` reescritos e as contagens de tools em `agentes.spec.ts`. Achado durante os testes: a rescisão estendia uma obrigação que já terminava antes da data (corrigido, com teste).
- **Verificação**: `pnpm verify:quick` (typecheck, shared relacionados, integração dos tocados e pgTAP passam; o lint falha só pelo `tmp/.../biome.json` não versionado — o Biome nos arquivos alterados passa); integração local completa (24 arquivos, 242 testes); e2e completo numa pilha isolada (43 testes).

