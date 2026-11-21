---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
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

## Resolução (executor)
