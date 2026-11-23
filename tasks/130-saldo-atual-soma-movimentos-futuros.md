---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# O "saldo atual" da conta e da caixa soma movimentos com data futura

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** saldo do dia × saldo com lançamentos futuros
- **Arquivos afetados:** `database/schema.sql:14782-14794` (`financial_account_balances`), `apps/server/src/services/caixas.ts:47`, `apps/server/src/services/caixas.ts:268-273`, `apps/web/src/components/titles/SettlementModal.tsx:85-86`, `docs/004-caixas-e-contas.md:24`
- **Depende de / relacionado a:** tarefa 080
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quem registra hoje um pagamento agendado para o dia 25 vê o saldo atual da conta já sem esse dinheiro. O calendário, para o mesmo dia, mostra o saldo realizado sem ele. A tela da conta promete "saldo atual".

### Evidência e análise técnica
- `financial_account_balances.balance_cents` = saldo inicial + todos os movimentos, sem filtro de data (`schema.sql:14782-14794`).
- O saldo da caixa (`caixas.ts:47`), o de cada conta (`caixas.ts:268-273`), o total da visão geral e o topo da tela da conta usam esse valor.
- Nada impede data futura: `settledOn`, `occurredOn` e `transferredOn` só passam por `isoDate`, e o formulário da baixa não tem `max` (`SettlementModal.tsx:85-86`).
- O calendário separa realizado e previsto pelo dia (`caixa_daily_balances`, `account_daily_balances`), e a spec 004:24 fala em "saldo atual".

### Verificação (tentativa de refutação)
- Pode ser intencional (o saldo como "tudo o que já foi lançado"); nenhuma spec diz isso, e a `financial_account_balance_at(conta, data)` existe justamente para o saldo numa data.
- Movimentos do extrato importado têm data passada; o caso aparece em baixas e lançamentos à mão (e por agentes) com data adiante.
- Testes: `account-summary.test.ts` não lança movimento futuro.

### Impacto
O saldo atual da tela não bate com o do calendário no mesmo dia nem com o do banco. A frequência depende de quanto os usuários lançam pagamentos agendados.

## Como reproduzir
1. Conta com saldo inicial de 1.000.
2. Baixa de 200 com `settledOn` = hoje + 10 dias.
3. `GET /api/accounts?caixaId=…` mostra 800; `GET /api/calendar/balances?accountId=…&from=<hoje>&to=<hoje>` mostra 1.000.

## Solução proposta
1. Decidir com o usuário o significado do "saldo atual".
2. Se for o saldo de hoje: o dba acrescenta a `financial_account_balances` uma coluna com o saldo até hoje em São Paulo (ou uma função por caixa), e o app usa essa coluna nos cartões de saldo, mantendo o total com os futuros como informação à parte ("inclui R$ X agendados").
3. Alternativa sem banco: recusar data futura na baixa, no avulso e na transferência.

## Critérios de aceite
- [ ] O saldo atual da tela da caixa, da conta e da visão geral bate com o realizado do calendário no dia.

## Testes recomendados
`test/account-summary.test.ts`: movimento com data futura; conferir o saldo atual de `GET /api/accounts` e `GET /api/caixas/:id` contra `financial_account_balance_at(conta, hoje)`. pgTAP da view, se ela mudar.

## Limitações e suposições
Nada foi executado. A intenção do produto não está escrita em nenhuma spec, por isso a confiança é "provável".

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: `financial_account_balances.balance_cents` = saldo inicial + todos os movimentos, sem filtro de data. O calendário separa o realizado pelo dia.

Decisão (confirmar com o usuário): o "saldo atual" das telas é o saldo no fim de hoje em America/Sao_Paulo, e o que já está lançado com data futura fica como informação à parte. É a opção 2 da tarefa: a mais conservadora e coerente com o calendário (docs/016, *Calendário*). A alternativa 3, recusar data futura, tiraria o lançamento de pagamentos agendados. A mudança no banco é aditiva: `balance_cents` continua igual, e se o usuário decidir o contrário basta a aplicação não usar a coluna nova.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0057_balance_queries.sql` (grupo dos saldos); teste `database/tests/0057_balance_queries.sql`.

- `financial_account_balances` ganha, no fim, `balance_today_cents`: o saldo inicial, só se a conta já abriu, mais os movimentos com `occurred_on` até hoje em America/Sao_Paulo. Sai da mesma varredura que soma `balance_cents`.
- `balance_cents − balance_today_cents` = o que está lançado com data futura (inclusive o saldo inicial de conta que abre no futuro).
- Testes: o movimento de amanhã fica fora do saldo de hoje e dentro de `balance_cents`; a conta que abre amanhã tem saldo de hoje 0; o valor é igual a `financial_account_balance_at(conta, hoje)`.
- `docs/016` (Saldos) atualizada.

### Pendente na aplicação

1. `pnpm db:pull`, para pegar a coluna nova da visão.
2. Usar `balance_today_cents` nos cartões de "saldo atual":
   - `apps/server/src/services/caixas.ts:47`: saldo da caixa, `sum(b.balance_today_cents)`.
   - `caixas.ts:268-273` (`listAccounts`): expor `balanceTodayCents`, ou trocar o que `balanceCents` mostra.
   - A visão geral (`overview.ts`), o topo da tela da conta (`statement.ts`) e o resumo diário do Telegram (`message-worker.ts:165`, que soma `financial_account_balances`).
3. Quando `balance_cents ≠ balance_today_cents`, mostrar à parte "inclui R$ X lançados com data futura" (texto no shared).
4. Teste em `apps/server/test/account-summary.test.ts`: baixa com `settledOn` = hoje + 10. `GET /api/accounts?caixaId=…` e `GET /api/caixas/:id` mostram o saldo de hoje igual a `financial_account_balance_at(conta, hoje)` e ao realizado do calendário no dia.
5. `docs/004` (saldo atual = saldo do dia; os agendados à parte).

### Aplicação (app)

- Decisão: a da triagem (opção 2). O `balanceCents` da API passa a ser o saldo de hoje e ganha ao lado o `futureCents` (o lançado com data futura, `balance_cents − balance_today_cents`). Mantive o nome `balanceCents` para todas as telas, tools e exportações passarem a mostrar o saldo de hoje sem mudar cada uma.
- `apps/server/src/services/caixas.ts`: `summarySql` soma `balance_today_cents` das contas ativas e devolve `future_cents`; `listAccounts` devolve `balance_today_cents AS balance_cents` e `future_cents`. O arquivamento da conta (tarefa 080) continua conferindo o `balance_cents` com os futuros, porque a conta só sai da caixa zerada de vez.
- `apps/server/src/services/overview.ts`: `totals.futureCents`. `apps/server/src/services/message-worker.ts` (resumo diário do Telegram): `balance_today_cents`.
- `packages/shared/src/types.ts`: `futureCents` em `AccountRow`, `CaixaSummary` e `Overview.totals`; textos `t.caixa.futureEntries`/`futureEntriesHint` em `i18n/pt-BR.ts`.
- `apps/web`: `FutureEntries` em `components/domain.tsx` (nada quando é zero; "R$ X lançados com data futura" no formato contábil, com a dica), no saldo da tela da caixa (`CaixaPage`), da conta (`FinancialAccountPage`), da aba Contas (total e cada conta, `AccountsTab`), da lista de caixas (`CaixasPage`) e da visão geral (total e cada caixa, `OverviewPage`).
- `docs/004-caixas-e-contas.md`: o saldo atual e o lançado com data futura; linha da 004 no `docs/INDEX.md`.
- Teste: `apps/server/test/account-summary.test.ts`, "a conta, a caixa e a visão geral mostram o saldo de hoje, com o agendado à parte" — baixa com `settledOn` = hoje + 10 e uma conta que abre amanhã: `GET /api/accounts`, `GET /api/caixas/:id`, o extrato e a visão geral com o saldo igual a `financial_account_balance_at(conta, hoje)` e ao realizado do calendário no dia, e o `futureCents`.
- Verificação: `pnpm verify:quick` (nível rápido).

