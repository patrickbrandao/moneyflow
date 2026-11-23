---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 734b618
---

# Conta arquivada: o saldo some da caixa e ela ainda aceita movimentos e extratos

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** conta arquivada (saldo e escrita)
- **Arquivos afetados:** `apps/server/src/services/caixas.ts:327-337`, `apps/server/src/services/caixas.ts:47`, `apps/server/src/services/caixas.ts:274-276`, `apps/server/src/services/caixas.ts:291-296`, `apps/server/src/services/caixas.ts:346-365`, `apps/web/src/components/caixa/AccountsTab.tsx:57-61,76`, `database/schema.sql:4484-4486` (`caixa_daily_balances`), `database/schema.sql:9071-9076` (`statement_imports_validate`), `apps/server/src/services/settlements.ts:40-44`, `apps/server/src/services/transfers.ts:51-56`, `apps/server/src/services/statements.ts:67-98`, `docs/032-regras-de-classificacao-por-conta.md:22`
- **Depende de / relacionado a:** tarefa 130 (outro desencontro do "saldo")
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao "excluir" um cofre que ainda tem R$ 500, o sistema arquiva a conta (ela tem histórico) e o saldo da caixa cai R$ 500 na tela da caixa e na visão geral. No calendário, o saldo da mesma caixa continua contando esses R$ 500. A conta arquivada ainda aceita baixas, lançamentos, transferências e também importação de extrato pela API e pelos agentes, mexendo num saldo que ninguém vê. A especificação diz que conta arquivada não importa extrato novo; a conciliação da tela não a oferece, mas a API e a tool `import_statement` importam nela normalmente, e o lote novo passa a contar na divergência e nos avisos de uma conta que o usuário tirou de uso.

### Evidência e análise técnica
**Saldo (spec 008 × código).**
- `deleteAccount` (`caixas.ts:327-337`) usa `deleteOrArchive`: com movimentos, a FK falha e a conta é arquivada. Não olha o saldo.
- O saldo da caixa soma só as contas ativas (`caixas.ts:47`, `b.archived_at IS NULL`); a lista de contas e o total da aba Contas também (`caixas.ts:274-276`, `AccountsTab.tsx:76`). O total da visão geral (`overview.ts:18-26`) vem daí.
- `caixa_daily_balances` soma todas as contas da caixa, arquivadas inclusive (`schema.sql:4484-4486`, `WHERE a.caixa_id = p_caixa_id`).
- A mensagem da tela promete o contrário: "com histórico, é arquivada (some das listas e continua nos relatórios)" (`AccountsTab.tsx:57-61`, linha 60). A spec 008 diz o mesmo.

**Movimentos em conta arquivada.**
- Nada barra escrever numa conta arquivada: `accountInCaixa` (`settlements.ts:40-44`), `addAdjustment` (`caixas.ts:346-365`) e `createTransfer` (`transfers.ts:51-56`) só conferem a caixa e o acesso.

**Importação de extrato em conta arquivada.**
- `resolveTarget(…, write = true)` confere a escrita na caixa e o tipo da conta (`checking`/`savings`), mas não `archived_at` (`statements.ts:67-98`, `:73-89`); `getAccount` devolve a conta arquivada (`caixas.ts:291-296`).
- O banco também não recusa: `statement_imports_validate` só confere o tipo (`schema.sql:9071-9076`).
- `importStatement`, `previewStatementImport` (tool) e `createMapping` passam por esse `resolveTarget`.

### Verificação (tentativa de refutação)
- Banco: nenhum trigger de `financial_accounts` (`schema.sql:20230-20272`) trata arquivamento nem saldo; `financial_account_balances` expõe `archived_at` e deixa o filtro para quem lê.
- A regra do extrato está escrita na spec 032 ("a conta arquivada não importa extrato novo", linha 22); a 009 só trata a lembrança da última conta escolhida na tela (linha 21). O cartão arquivado não está na regra da spec; fica fora deste achado.
- Testes: `permissions.test.ts:91-98` cobre o arquivar de entidade; não há caso de conta com saldo. Nenhum teste tenta importar numa conta arquivada (`grep archived` em `apps/server/test/statements.test.ts`).
- A tela de contas esconde as arquivadas, então escrever nelas só acontece pela API ou pelos agentes (tools de baixa, de lançamento avulso e de importação recebem o id da conta).

### Impacto
Dois números diferentes para o saldo da mesma caixa (tela da caixa e visão geral × calendário), e dinheiro que some do total sem lançamento que explique; acontece toda vez que alguém "exclui" uma conta com saldo diferente de zero. Lote novo ou movimento numa conta desativada, feito por engano pelo agente ou por um script do `/mcp`; a divergência e o aviso `reconciliation_divergence` voltam a falar dela (baixa frequência).

## Como reproduzir
1. Caixa com cofre de saldo inicial R$ 500 e um lançamento avulso.
2. `DELETE /api/accounts/<cofre>` → `{ archived: true }`.
3. `GET /api/caixas/<caixa>`: `balanceCents` sem os R$ 500; `GET /api/calendar/balances?caixaId=<caixa>&from=<hoje>&to=<hoje>`: `realizedCents` com os R$ 500.
4. `POST /api/accounts/<cofre>/adjustments { ... }` → 200.
5. Arquivar uma conta corrente; `POST /api/statement-imports?accountId=<arquivada>&fileName=x.ofx` com um OFX: 200 e o lote criado.

## Solução proposta
1. `deleteAccount`: com saldo atual diferente de zero, recusar o arquivamento (422, "zere o saldo com uma transferência ou um lançamento avulso antes"), ou decidir com o usuário que o saldo das arquivadas continua no total da caixa.
2. Recusar baixa, lançamento avulso e transferência em conta arquivada (`accountInCaixa`, `addAdjustment`, `createTransfer`), com mensagem pt-BR; o estorno continua permitido.
3. Em `resolveTarget`, com `write`, recusar a conta com `archivedAt` (422, código novo `statement_account_archived`, texto em `t.errors`). A leitura (listar lotes, buscar linhas) continua valendo para o histórico. Se o dba preferir garantir no banco, o mesmo teste entra em `statement_imports_validate` no `INSERT`.
4. Ajustar a mensagem da tela ao que for decidido.

## Critérios de aceite
- [ ] Saldo da caixa na tela, na visão geral e no calendário batem depois de arquivar uma conta.
- [ ] Conta arquivada não recebe movimento novo (fora o estorno).
- [ ] Importar (tela, API ou tool) numa conta arquivada responde 422 `statement_account_archived`.
- [ ] Os lotes antigos da conta arquivada continuam legíveis.

## Testes recomendados
- `test/account-summary.test.ts` ou `test/permissions.test.ts`: arquivar conta com saldo (422 ou total preservado, conforme a decisão); `POST /api/accounts/<arquivada>/adjustments` e baixa com `financialAccountId` arquivado esperando 422.
- `apps/server/test/statements.test.ts`: importar numa conta arquivada (422) e listar os lotes dela (200).

## Limitações e suposições
Nada foi executado. Os relatórios (`report_*`) não foram lidos para saber se incluem as arquivadas.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `deleteAccount` arquivava sem olhar o saldo (a caixa soma só as ativas e o `caixa_daily_balances` soma todas), e `accountInCaixa`, `addAdjustment`, `createTransfer` e `resolveTarget(…, true)` não conferiam `archived_at`.

## Resolução (executor)

- Decisão (item 1): recusar o arquivamento com saldo diferente de zero, a opção recomendada; assim o total da caixa, a visão geral e o calendário continuam batendo. A exclusão física (conta sem movimentos) segue sem a trava, porque a conta some de todos os números.
- `apps/server/src/services/caixas.ts`: no ramo de arquivar do `deleteAccount`, saldo ≠ 0 → 422 `account_archive_balance` (`t.errors.accountArchiveBalance(valor)`); `assertAccountActive` (422 `account_archived`) usado no `addAdjustment`.
- `apps/server/src/services/settlements.ts` (`accountInCaixa`, que cobre a baixa, a perna do espelho e o "definir conta", e a conta de origem da transferência da baixa), `transfers.ts` (as duas contas) e `reconciliation.ts` (o avulso lançado pela linha do extrato): conta arquivada não recebe movimento novo. O estorno continua permitido (ele é obrigatório nas duas pernas no banco, e a outra perna pode ser de quem não restaura a conta).
- `apps/server/src/services/statements.ts`: `resolveTarget` com escrita recusa a conta arquivada (422 `statement_account_archived`) — importação pela tela, pela API e pela tool, a prévia da tool e os mapeamentos de CSV; a leitura dos lotes continua.
- `apps/web/src/components/caixa/AccountsTab.tsx`: a confirmação de excluir diz que a arquivada sai do saldo da caixa e precisa de saldo zero.
- `packages/shared/src/i18n/pt-BR.ts`: `accountArchived`, `accountArchiveBalance`, `statementAccountArchived`. `docs/008-categorias-auditoria-e-exclusao.md`: a regra.
- Testes: `apps/server/test/account-summary.test.ts`, `describe('conta arquivada (tarefa 080)')` (recusa com saldo, arquiva zerada com a caixa e o calendário iguais, 422 no avulso, na baixa, na transferência e no extrato, lotes antigos legíveis e o estorno); `apps/server/test/agent-tools.test.ts`, o caso de arquivar conta pela tool passa a zerar o saldo antes.
- Limite: contas já arquivadas com saldo antes desta mudança continuam fora do total da caixa e dentro do calendário; o estorno de uma baixa antiga também muda o saldo de uma arquivada. Para isso, restaurar a conta e zerar.
- Verificação: `pnpm verify:quick` (nível rápido).

### Complemento (revisão de 2026-11-22, frente P2a)

- A prévia da tool `archive_account` (`apps/server/src/agents/tool-handlers-operation.ts`) antecipa a recusa: conta com movimentos e saldo ≠ 0 sai com o mesmo 422 `account_archive_balance` do serviço, antes do cartão; com saldo e sem movimentos, a prévia mostra o saldo e avisa que ela só sai se puder ser excluída.
- Teste: `apps/server/test/agent-tools.test.ts`, "as prévias recusam antes do cartão…" (com saldo, recusada sem prévia; zerada, a prévia sai). Verificação: `pnpm verify:quick`.
