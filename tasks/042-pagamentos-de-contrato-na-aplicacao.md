---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-20
commit: (não commitado; a sessão principal faz o commit)
---

# Pagamentos de contrato no extrato na aplicação (F19)

## Descrição
A spec [033](../docs/033-pagamentos-de-contrato-no-extrato.md), menos a seção Banco: conta das parcelas e conta prevista por parcela (com troca), a parcela como candidato no mesmo mês ou na janela, com encargos, desconto, tolerância, parcial e a caixa pagadora pela conta prevista; o desempate do aluguel igual; a baixa repartida (com a transferência quando a conta é de outra caixa); `auto_settle` com o aviso do sino; tools; telas (formulário do contrato, gaveta do título, sugestão com a repartição, seção Pagamentos com os gráficos) e os testes.

Ordem: depois da [040](040-regras-por-conta-na-aplicacao.md) (mexe nos mesmos serviços de conciliação) e da [041](041-pagamentos-de-contrato-no-banco.md).

## Como reproduzir
Não se aplica (recurso novo). Pronto: os testes unitários, de integração e o e2e da spec.

## Análise (triagem)
Designada direto pela sessão principal (pedido do usuário em 2026-10-20).

**Executor designado: app.**

## Resolução (executor)
Feito sobre a 040 e a 041 (`pnpm db:pull`; `transfer_settlement` em `LINE_CREATED_ENTRIES`). Decisões que a spec deixava em aberto estão em [033 → Decisões da implementação (F19)](../docs/033-pagamentos-de-contrato-no-extrato.md#decisões-da-implementação-f19).

- **Shared**: `splitSettlement`, `contractMatch`, `inContractWindow`, `contractCharges`, `pickContractInstallments` (desempate: mesmo mês, senão a mais antiga em aberto; parcial só sem outra do contrato) e `pickMatch` com a parcela de contrato e o `autoSettle` em `packages/shared/src/reconcile.ts`; entradas do contrato (conta das parcelas, passagem, encargos, tolerância, janela, `autoSettle`, `applyAccountToInstallments`), `contractPaymentsQuery`, `titleUpdateInput` com a conta prevista; tipos `PlannedAccount`, `ContractPayments*`, `MatchCandidateRow.contract`, `StatementLineRow.autoSettled` e `target.contract`; textos e as traduções das constraints novas (`*_check` e `*_fkey`).
- **Servidor**: `line-settle.ts` (`settleFromLine` com a repartição e, no título de outra caixa, a baixa na conta de passagem com a transferência e `created_entry = 'transfer_settlement'`; `lineSplit`); `statements.ts` (`contractCandidates` dentro do `candidatesFor`, `autoMatch(ctx, …)` com a baixa sem confirmação num savepoint e o aviso do sino por lote; a repartição da sugestão em `listLines`); `reconciliation.ts` (desfazer `transfer_settlement` por `deleteSettlementLegs`, `auto_settled` limpo junto com `created_entry` no desfazer e no ignorar; candidatos com `contract`); `statement-supersede.ts` (`auto_settled` limpo e levado ao consolidado só com o `created_entry`); `planned-account.ts`; `titles.ts` (conta prevista no detalhe e na edição, que marca a parcela como própria; só em aberto/parcial); `contracts.ts` (conta das parcelas e encargos no cadastro e na edição, teto de 10% da tolerância, a conta copiada ao ativar/renovar/aditivo e aplicada às parcelas que seguem com `applyAccountToInstallments`, `followingOpenInstallments`, `contractPayments`) e `GET /api/contracts/:id/payments`. Backup: as FKs novas entram pelo grafo genérico do `import.ts` (sem mudança); o teste do backup completo passou a cobrir a conta das parcelas.
- **Tools**: `list_line_candidates` com a parcela e a repartição; prévia de `match_statement_line(s)` com principal/multa/juros/desconto, dias e o aviso da transferência; `update_contract` com os campos novos (nomes das contas e o aviso das parcelas que mudam) e `update_title` com a conta prevista. A contagem de tools não mudou. O prompt da conciliação (`flows.ts`) explica a parcela de contrato.
- **Telas**: seção "Pagamento e conciliação" no formulário do contrato (com a pergunta de aplicar às parcelas que seguem); conta prevista (com "própria" e o botão de troca) na lista das parcelas, na gaveta do título e na baixa manual (começa na conta prevista, com a transferência se for de outra caixa); a parcela e a repartição na sugestão e nos candidatos da conciliação (`ContractSplit`), com a marca da baixa automática; guia Pagamentos do contrato (resumo, valores por mês, atraso por parcela, tabela com CSV/PDF). Corrigido de passagem o resumo lateral do contrato (`.kv` com linhas em `<div>` herdava as duas colunas do `.kv` da gaveta e quebrava o texto).
- **Testes**: unitários em `packages/shared/test/reconcile.test.ts` (mesmo mês, janela, encargos, desconto, tolerância com o teto, parcial, desempate do aluguel igual, o atraso pagando a mais antiga, baixa automática só no caso único); integração em `test/contracts.test.ts` (atraso com multa e juros, desconto antes, o atraso pagando a mais antiga, o resumo de pagamentos; troca da conta da parcela e do contrato, passagem e teto da tolerância) e `test/statements.test.ts` (outra caixa com transferência, desfazer estorna as duas e casar de novo; `auto_settle` só no candidato único, com o sino e o desfazer; tools); `test/backup.test.ts` ajustado; e2e `e2e/tests/contratos-pagamentos.spec.ts`.
- **Verificação**: `pnpm verify:quick` com typecheck, testes do shared, integração dos arquivos tocados (Postgres local) e pgTAP passando; o lint dele falha só pelo `biome.json` aninhado em `tmp/` (não versionado) — o Biome direto nos arquivos alterados passa. E2E numa pilha isolada (`docker compose -p moneyflow-f19`, porta 3010, derrubada no fim): `contratos-pagamentos`, `contratos`, `conciliacao-provisoria`, `operacao`, `conta` e `fluxo-principal`, 11 passaram.

