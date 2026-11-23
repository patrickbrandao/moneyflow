---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 57e458a
---

# Aviso de vencimento no Telegram para no 30º título: "o resto na seguinte" nunca vem

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** paginação que repete a primeira página
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:56-57,123-140,302-320`, `docs/013-mensagens-telegram.md:26`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando mais de 30 contas vencem no mesmo dia, o Telegram avisa só as 30 primeiras (em ordem de caixa e descrição). As demais nunca recebem o aviso de D-3, D-1 nem D-0, embora a especificação diga que elas saem na passada seguinte.

### Evidência e análise técnica
- `eventsFor`, caso `due_reminder` (`message-worker.ts:302-320`): para cada alvo (hoje + N), `openTitles(db, caixaIds, sql\`t.due_date = ${target.dueDate}\`, MAX_TITLE_MESSAGES)`, com `MAX_TITLE_MESSAGES = 30` (`:57`).
- `openTitles` ordena de forma determinística e corta: `ORDER BY t.due_date, c.name, t.description, t.id LIMIT ${limit}` (`:139-140`). Não exclui o que já foi enfileirado.
- O `enqueue` faz `ON CONFLICT (destination_id, dedup_key) DO NOTHING` (`:449`). Na passada seguinte, a consulta devolve os mesmos 30 títulos, as 30 inserções caem no conflito e nada novo entra. Os títulos da 31ª posição em diante só entram se algum dos 30 primeiros for pago antes.
- A spec promete o contrário: "Até 30 títulos por passada (o resto na seguinte)" (`docs/013:26`).
- Do mesmo jeito, mas com tetos altos: `overdue` lê até 1000 títulos (`:323`), o `overdueTotals` do resumo soma no máximo 5000 (`:190-193`) e a lista de vencimentos do resumo busca 200 (`:347`). Acima disso, o "… e mais N" e o total atrasado do resumo saem menores que o real.

### Verificação (tentativa de refutação)
- Não há outro filtro de "já enviado" no caminho: `eventsFor` não consulta a outbox e a dedup só acontece no INSERT.
- Procurei testes com mais de 30 títulos no mesmo vencimento (`vision.test.ts`, `budgets.test.ts`, `packages/shared/test`): nenhum.
- O banco não intervém: a outbox só garante a unicidade da chave.

### Impacto
Em quem tem muitos títulos no mesmo dia (folha, mensalidades, parcelas de cartão nas pagadoras, o dia 10 de muitas séries), parte dos lembretes some, sempre os mesmos (os do fim da ordem alfabética), sem erro nem registro.

## Como reproduzir
1. Uma caixa com 35 títulos a pagar vencendo amanhã.
2. Destino Telegram com a assinatura `due_reminder` (`days_before: [1]`, `send_at: 00:00`).
3. Rode `produceMessages` duas vezes (ou espere duas passadas do worker): a outbox fica com 30 mensagens `due_reminder` e não passa disso.

## Solução proposta
Excluir na consulta o que já está na outbox daquele destino, para que o `LIMIT` ande:

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/message-worker.ts
+++ b/apps/server/src/services/message-worker.ts
       for (const target of targets) {
-        const titles = await openTitles(db, caixaIds, sql`t.due_date = ${target.dueDate}::date`, MAX_TITLE_MESSAGES);
+        const titles = await openTitles(
+          db,
+          caixaIds,
+          sql`t.due_date = ${target.dueDate}::date AND NOT EXISTS (
+                SELECT 1 FROM message_outbox o
+                 WHERE o.destination_id = ${sub.destination_id}
+                   AND o.dedup_key = 'due_reminder:' || t.id || ':D-' || ${target.daysBefore}::int || ':' || t.due_date::text)`,
+          MAX_TITLE_MESSAGES,
+        );
```
A chave do SQL tem de bater com `dedupKeys.dueReminder` (`packages/shared/src/messages.ts:113`); o índice único `(destination_id, dedup_key)` atende a subconsulta. O mesmo padrão serve ao `overdue`. No resumo, contar o total com `count(*)`/`sum` em vez de somar uma lista cortada.

## Critérios de aceite
- [ ] Com 35 títulos no mesmo vencimento, duas passadas enfileiram 35 mensagens (30 + 5), sem duplicar.
- [ ] O total atrasado e o "… e mais N" do resumo batem com o banco acima de 5000 e de 200 títulos.

## Testes recomendados
`apps/server/test/vision.test.ts`: caso novo com 35 títulos D-1 e o relógio fixo (`spClock`), chamando `produceMessages` duas vezes; espera 30 e depois 35 linhas `due_reminder` na outbox do destino.

## Limitações e suposições
Nada foi executado. Não medi o custo da subconsulta; com o índice único da outbox, deve ser desprezível.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado em `apps/server/src/services/message-worker.ts`: `due_reminder` lia os 30 primeiros do dia em ordem fixa sem excluir os já enfileirados (a dedup só agia no INSERT), `overdue` lia os 1000 mais antigos do mesmo jeito, e o resumo contava os atrasados numa lista de até 5000 e os vencimentos numa de até 200.

## Resolução (executor)

- `apps/server/src/services/message-worker.ts`: `openTitleFilter` (o filtro comum dos títulos em aberto) e `notQueued(destino, chave)`, um `NOT EXISTS` na `message_outbox` pelo índice único `(destination_id, dedup_key)`. Vencimentos e atrasados deixam de fora os já enfileirados com a chave de `dedupKeys` montada no SQL, e o teto de 30 anda; os atrasados com repetição filtram os dias da repetição no SQL, como `overdueSchedule`. O teto dos atrasados passa de 1000 para os mesmos 30 por passada (o resto na seguinte). `openTitleTotals` soma no banco: o total atrasado do resumo e a contagem dos vencimentos (`dueCount`) não cortam mais; a lista do resumo busca só os 25 que mostra.
- `packages/shared/src/messages.ts`: `SummaryData.dueCount` (o "… e mais N" usa a contagem real) e `SUMMARY_MAX_ITEMS` exportado.
- Spec: `docs/013` (vencimentos, atrasados e resumo).
- Testes: `apps/server/test/vision.test.ts` ("mais de 30 títulos no mesmo dia…": 35 vencendo hoje e 31 atrasados, três passadas: 30/30, depois 35/31 e nada a mais; o resumo com "… e mais 10" e "Atrasados: 31 títulos") e `packages/shared/test/vision.test.ts` (o "… e mais 235" pelo `dueCount`).
- Verificação: `pnpm verify:quick`.
