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

# O laço de mensagens recalcula resumos e views pesadas a cada 30 s só para a dedup descartar

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** desempenho
- **Subcategoria:** trabalho repetido antes da dedup
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:340-366,528-555,596-761,870-877`, `apps/server/src/config.ts:124`
- **Depende de / relacionado a:** tarefa 104 (mexe na mesma função)
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A cada 30 segundos, o worker remonta o resumo diário de cada destino, recalcula o limite de todos os cartões e soma os títulos em aberto de todas as caixas, mesmo quando tudo isso já foi enviado naquele dia. O banco faz o trabalho pesado o dia inteiro para descobrir que não há nada de novo.

### Evidência e análise técnica
- `messageTick` roda a cada `MESSAGE_INTERVAL_MS` (padrão 30 s, `config.ts:124`), ou seja, 2880 vezes por dia.
- Resumo diário e semanal (`message-worker.ts:340-366`): depois do `send_at`, toda passada executa `openTitles` (até 200), `overdueTotals` (até 5000 títulos pela view `title_balances`, com a soma lateral das baixas), `balancesByCaixa` (view `financial_account_balances`, soma de todos os movimentos) e `flowByCaixa`, monta o texto e só então o `INSERT … ON CONFLICT DO NOTHING` descarta, porque a chave `daily_summary:<data>` já existe. São cerca de 1900 recálculos por destino por dia com `send_at` às 08:00.
- `produceNotifications` (`:596-761`), também a cada passada: espelhos pendentes e contestados dos últimos 60 dias, faturas fechadas, `card_limits` de todos os cartões (view que soma todas as parcelas e pagamentos), divergências, `budgetAlerts`; depois do `NOTIFY_AT`, a agregação de `title_balances` de todas as caixas gerais e `contractNotifications`. Tudo vira `INSERT … ON CONFLICT (user_id, dedup_key) DO NOTHING` em lotes de 200, a maioria descartada.
- O limite do cartão é calculado duas vezes por passada quando há assinatura `card_limit` (`:386` e `:674`).

### Verificação (tentativa de refutação)
- A dedup garante a correção, então não há bug; o custo é só de carga. Numa instalação pequena (uma casa, poucas caixas), isso cabe com folga, e por isso a severidade é baixa.
- Não medi os planos nem o tempo das consultas (não rodei nada contra o banco); a estimativa vem da forma das views (`database/schema.sql:13283-13304`, `13402-13423`, `14782-14800`).

### Impacto
Carga constante e crescente com o número de caixas, títulos e movimentos, concorrendo com a API no mesmo banco, e passadas mais longas, que atrasam o consumo da outbox e os lembretes, que vêm depois na mesma passada.

## Como reproduzir
Com `log_min_duration_statement = 0` no Postgres local e uma assinatura `daily_summary` às 00:00, deixe o worker rodar uma hora: o log mostra as quatro consultas do resumo e as de `produceNotifications` a cada 30 s, com os INSERTs devolvendo zero linhas.

## Solução proposta
1. Antes de montar um evento com chave conhecida de antemão (resumos, `card_limit`, avisos diários por caixa), conferir se a chave já existe: `SELECT 1 FROM message_outbox WHERE destination_id = $1 AND dedup_key = $2` (índice único) e pular o cálculo.
2. Em `produceNotifications`, rodar os blocos caros no máximo a cada N minutos (por exemplo, 5) guardando o último instante no processo, ou só a primeira vez no dia para os avisos diários (conferindo uma chave do dia).
3. Calcular `cardUsage` uma vez por passada e reaproveitar entre `eventsFor` e `produceNotifications`.

## Critérios de aceite
- [ ] Depois de enviado o resumo do dia, as passadas seguintes não executam as consultas do resumo daquele destino.
- [ ] Os avisos diários do sino continuam saindo uma vez por dia, no horário.

## Testes recomendados
`apps/server/test/vision.test.ts`: um `Executor` dublê que conta as consultas; duas chamadas de `produceMessages` com o mesmo relógio depois do `send_at` — na segunda, nenhuma consulta a `title_balances` para aquele destino.

## Limitações e suposições
Nada foi medido. O ganho real depende do volume de dados da instalação.

## Análise (triagem)

## Resolução (executor)
