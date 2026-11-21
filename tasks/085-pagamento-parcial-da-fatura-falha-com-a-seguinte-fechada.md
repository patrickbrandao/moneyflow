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

# Pagamento parcial da fatura (e o crédito do fechamento) falha quando a fatura seguinte já fechou

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** saldo rolado (carryover) no cartão
- **Arquivos afetados:** `apps/server/src/services/cards.ts:472-482`, `apps/server/src/services/cards.ts:501-511`, `apps/server/src/services/card-core.ts:262-277`, `database/schema.sql:4785-4791`, `docs/007-cartao-de-credito.md:7,15,17`
- **Depende de / relacionado a:** tarefa 136
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quem paga só parte da fatura de outubro e registra esse pagamento depois que a fatura de novembro já fechou recebe "não há fatura aberta" e não consegue lançar o pagamento. Com `CARD_AUTO_CLOSE=true`, a fatura seguinte fecha sozinha poucos dias depois do vencimento, e a janela para registrar o pagamento parcial fica bem curta.

### Evidência e análise técnica
- `payInvoice` rola o resto para `nextOpenInvoice` (`cards.ts:478`), que só aceita o mês seguinte exato e falha se ele estiver fechado:
  ```ts
  if (!row || row.closedAt) throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');   // cards.ts:509
  ```
- O mesmo acontece no crédito negativo do fechamento (`closeInvoiceTx`, `card-core.ts:264-268`): `if (!next || next.closedAt) throw ... no_open_invoice`. Fechar de novo uma fatura reaberta, com a seguinte já fechada, falha se houver crédito.
- No mesmo `payInvoice`, os encargos usam `insertPurchase`, que procura a primeira fatura aberta (`openInvoiceFor`, `card-core.ts:85-94`). O resto e os encargos seguem regras diferentes.
- O banco aceita saldo rolado para qualquer fatura posterior aberta do mesmo cartão: `card_invoice_items_carryover_check` exige só `src.reference_month < inv.reference_month` e a origem fechada (`schema.sql:4785-4791`).

### Verificação (tentativa de refutação)
- O teste `cards.test.ts:99-121` paga com a fatura seguinte aberta e não cobre o caso.
- A conciliação pelo extrato baixa o título parcialmente pela baixa normal, sem rolar, e não passa por aqui. O problema fica no "Pagar fatura" da tela e na tool `pay_invoice` (`tool-handlers-operation.ts:824`).
- Para contornar, é preciso reabrir a fatura seguinte, o que exige que ela não tenha pagamento nem saldo rolado (`reopenInvoiceTx`), pagar a anterior e fechar de novo. Com o fechamento automático ligado, o worker fecha a fatura de novo na passada seguinte.

### Impacto
Usuários que registram o pagamento parcial com atraso (comum quando ele é lançado ao conciliar o extrato do mês seguinte), e todos com `CARD_AUTO_CLOSE=true`. A saída é reabrir e fechar faturas à mão, ou registrar o pagamento como baixa parcial comum e perder o saldo rolado com os encargos.

## Como reproduzir
1. Cartão que fecha no dia 3 e vence no dia 10. Compras em setembro, fatura 10/2026 fechada.
2. Fechar a fatura 11/2026 (`POST /api/card-invoices/:nov/close`).
3. `POST /api/card-invoices/:out/pay` com `amountCents` menor que o aberto: 422 `no_open_invoice`.

## Solução proposta
Rolar o resto (e o crédito do fechamento) para a primeira fatura aberta depois da competência, como já fazem as compras. Uma função `firstOpenInvoiceAfter(tx, card, month)` serve aos dois lugares, e `nextOpenInvoice`, que duplica `addMonths`, sai.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/card-core.ts
+++ b/apps/server/src/services/card-core.ts
+/** Primeira fatura aberta com competência depois de `month` (cria as que faltarem). */
+export async function firstOpenInvoiceAfter(tx: Executor, card: Card, month: string): Promise<Invoice> {
+  let next = addMonths(month, 1);
+  for (let i = 0; i < 60; i += 1, next = addMonths(next, 1)) {
+    await ensureInvoices(tx, card, next, next);
+    const invoice = await invoiceByMonth(tx, card.id, next);
+    if (invoice && !invoice.closedAt) return invoice;
+  }
+  throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');
+}
```
Depois, usar `firstOpenInvoiceAfter` em `payInvoice` (no lugar de `nextOpenInvoice`) e no ramo `amount < 0` de `closeInvoiceTx`.

## Critérios de aceite
- [ ] Pagamento parcial de 10/2026 com 11/2026 fechada rola o resto para 12/2026.
- [ ] Fechar uma fatura reaberta com crédito, com a seguinte fechada, rola o crédito para a primeira aberta.

## Testes recomendados
`apps/server/test/cards.test.ts`: um caso "pagamento parcial depois da fatura seguinte fechada" que confere o item `carryover` na fatura aberta seguinte e o `carriedOutCents` da origem.

## Limitações e suposições
Nada foi executado. Supõe-se que rolar para uma fatura mais distante seja aceitável para o produto. A spec diz "a próxima", sem prever esse caso.

## Análise (triagem)

## Resolução (executor)
