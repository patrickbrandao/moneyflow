---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
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

## Resolução (executor)
