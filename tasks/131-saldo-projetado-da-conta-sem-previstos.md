---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 3e2a06f
---

# O saldo projetado por conta no calendário é só o realizado: ignora os previstos da conta

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** projeção por conta depois da conta prevista (spec 034)
- **Arquivos afetados:** `apps/server/src/services/calendar.ts:53-64`, `database/schema.sql:74-105` (`account_daily_balances`), `database/schema.sql:4498-4516` (contraste, `caixa_daily_balances`), `apps/web/src/pages/CalendarPage.tsx:254-270`, `packages/shared/src/i18n/areas/calendar.ts:18-25`, `docs/012-calendario.md:5`, `docs/016-banco-de-dados.md:94`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
No calendário, o seletor "saldo projetado" oferece Caixa ou Conta. Na caixa, os dias futuros descontam as contas a pagar e somam as a receber. Na conta, a linha fica parada no saldo de hoje, mesmo quando a conta tem ocorrências previstas (aluguel, escola) marcadas para ela.

### Evidência e análise técnica
- `dailyBalances` com `accountId` devolve `scheduledCents: 0` e `projectedCents = realizado` (`calendar.ts:53-64`); `account_daily_balances` só soma movimentos (`schema.sql:74-105`).
- `caixa_daily_balances` soma o saldo aberto dos títulos da caixa por vencimento (`schema.sql:4498-4516`).
- Desde a spec 034, cada ocorrência tem `titles.planned_account_id`, e a tela da conta já lista esses "Previstos" (`listTitles` com `plannedAccountId`). O dado para projetar por conta existe.
- O seletor e a dica falam em "projetado" e "previsto pendente" para os dois casos (`CalendarPage.tsx:254-270`, `calendar.ts:18-25` do i18n).

### Verificação (tentativa de refutação)
- A docs/016:94 documenta a função da conta como só realizado; a spec 012:5 pede "saldo projetado por dia, por caixa ou conta". As duas specs divergem, e a 034 tornou viável o que a 012 pede.
- Testes: `operation.test.ts:372` cobre o projetado da caixa; não há caso por conta.

### Impacto
Quem acompanha uma conta específica (a corrente onde caem os boletos) não vê o saldo futuro dela. Não há erro de dado, só uma visão que promete mais do que entrega.

## Como reproduzir
1. Conta corrente com saldo 1.000 e uma ocorrência prevista nela de 300, vencendo em 10 dias.
2. `GET /api/calendar/balances?accountId=<conta>&from=<hoje>&to=<hoje+15>`: todos os dias com 1.000 e `scheduledCents` 0.
3. O mesmo com `caixaId`: o dia do vencimento cai para 700.

## Solução proposta
1. dba: `account_daily_balances(conta, de, até, hoje)` com o previsto pelos títulos abertos não arquivados com `planned_account_id = conta` (vencidos contando em hoje, como na caixa), devolvendo realizado, previsto e projetado.
2. app: `dailyBalances` repassa `todayIso()` e preenche `scheduledCents`.
3. Atualizar a docs/016:94 e a 012.

## Critérios de aceite
- [ ] O projetado por conta desconta as ocorrências previstas na conta a partir do vencimento.

## Testes recomendados
pgTAP de `account_daily_balances` com uma ocorrência prevista; `test/operation.test.ts`, no `describe('calendário (spec 012)')`, o mesmo cenário pela API.

## Limitações e suposições
Nada foi executado. Ocorrências sem conta prevista continuam fora da projeção por conta (só entram na da caixa).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: `account_daily_balances(conta, de, até)` só somava movimentos e devolvia `(day, balance_cents)`. Desde a 0052, `titles.planned_account_id` (com o índice `titles_planned_account_open_idx`) tem o dado para projetar por conta.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0057_balance_queries.sql` (grupo dos saldos); teste `database/tests/0057_balance_queries.sql`.

- `account_daily_balances(conta, de, até, hoje DEFAULT hoje em America/Sao_Paulo)` devolve `(day, balance_cents, scheduled_cents, projected_cents)`:
  - `balance_cents` = o realizado, como antes. O nome foi mantido para a chamada atual da aplicação continuar valendo.
  - `scheduled_cents` = a partir de hoje, o saldo aberto acumulado dos títulos não arquivados, `open`/`partial`, com `planned_account_id = conta` (+ receber, − pagar). Os vencidos entram em hoje e os de fatura aberta ficam fora, como na caixa. Antes de hoje, 0.
  - `projected_cents` = balance + scheduled, nulo antes da abertura.
- A versão de três argumentos saiu (DROP + CREATE). A chamada com três argumentos resolve para a nova pelo padrão de `p_today`; `p_today` nulo dá `22023`.
- Títulos sem conta prevista continuam só no previsto da caixa.
- Testes:
  - previsto dos títulos com a conta prevista (pago, cancelado, arquivado, sem conta e o do cofre fora; vencido em hoje);
  - previsto anterior ao período entrando no primeiro dia;
  - cofre;
  - nulo antes da abertura;
  - chamada com três argumentos;
  - conta inexistente;
  - `22023`;
  - privilégios.
- `tests/0017_calendar.sql` ajustado à assinatura nova. `docs/016` (Calendário) atualizada.

### Pendente na aplicação

1. `pnpm db:pull`, se o schema gerado lista as funções.
2. `apps/server/src/services/calendar.ts:53-64` (`dailyBalances` com `accountId`):
   - Consultar `SELECT day, balance_cents, scheduled_cents, projected_cents FROM account_daily_balances(${accountId}::uuid, ${from}::date, ${to}::date, ${todayIso()}::date)`.
   - Mapear `realizedCents = balance_cents`, `scheduledCents = scheduled_cents` e `projectedCents = projected_cents`.
3. Teste em `apps/server/test/operation.test.ts` (`describe('calendário (spec 012)')`): conta com saldo 1.000 e uma ocorrência prevista nela de 300 vencendo em 10 dias. O dia do vencimento cai para 700, e `scheduledCents` = −300 a partir dele.
4. `docs/012`: o projetado por conta vem dos títulos com a conta prevista; os sem conta prevista só entram no da caixa.

### Aplicação (app)

- `apps/server/src/services/calendar.ts` (`dailyBalances` com `accountId`): `account_daily_balances(conta, de, até, todayIso())` com `realizedCents = balance_cents`, `scheduledCents = scheduled_cents` e `projectedCents = projected_cents` (nulos antes da abertura, como antes). A tela do calendário já mostrava o previsto da série escolhida: passa a ver o da conta sem mudança.
- `docs/012-calendario.md`: o projetado da caixa e o da conta (só os títulos com ela como conta prevista; os sem conta prevista só no da caixa); linha da 012 no `docs/INDEX.md`.
- Teste: `apps/server/test/operation.test.ts`, no `describe('calendário (spec 012)')`, "o projetado da conta desconta os previstos com ela como conta prevista": saldo 1.000 e uma ocorrência de 300 na conta vencendo em 10 dias cai para 700 no dia, com `scheduledCents` −300; o título sem conta prevista entra só no projetado da caixa.
- Verificação: `pnpm verify:quick` (nível rápido).

