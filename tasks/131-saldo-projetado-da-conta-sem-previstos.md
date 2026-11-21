---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
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

## Resolução (executor)
