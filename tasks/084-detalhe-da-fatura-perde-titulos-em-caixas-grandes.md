---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: b492cc7
---

# Detalhe da fatura carrega até 1.000 títulos por caixa e perde os da fatura em caixas grandes

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** consulta sem filtro, com limite que trunca o resultado (também desempenho)
- **Arquivos afetados:** `apps/server/src/services/cards.ts:151-160`, `apps/server/src/services/titles.ts:130-134`, `packages/shared/src/schemas/index.ts:447`, `apps/web/src/pages/InvoicePage.tsx:255-258`, `apps/server/src/agents/tool-handlers-operation.ts:847`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Na tela de uma fatura fechada, a lista "Títulos da fatura" (o a pagar na pagadora e o a receber no cartão) some quando a caixa pagadora já tem mais de mil títulos. Cada abertura da fatura também puxa centenas de títulos sem relação com ela, e a tela fica lenta.

### Evidência e análise técnica
`getInvoice` acha os ids dos títulos da fatura, mas, para montar as linhas, lista todos os títulos de cada caixa e filtra em memória:

```ts
const all = await Promise.all(
  [...new Set(readable.map((r) => r.caixaId))].map((caixaId) => listTitles(ctx, { caixaId, archived: false, limit: 1000 })),
);
invoiceTitles = all.flat().filter((tr) => wanted.has(tr.id));   // cards.ts:155-159
```

`listTitles` ordena por `t.due_date, t.created_at` crescente e corta em `LIMIT ${query.limit}` (`titles.ts:130-134`). O teto do schema é 1000 (`schemas/index.ts:447`). Numa caixa com mais de mil títulos não arquivados, os primeiros mil são os mais antigos, e o título da fatura recente fica de fora. Ele também fica de fora se estiver arquivado (`archived: false`).

### Verificação (tentativa de refutação)
- As séries são materializadas 12 meses à frente (spec 005/034). Uma caixa com 30 a 40 obrigações por mês passa de mil títulos em dois ou três anos, mesmo antes do histórico.
- `getInvoice` também atende ao fechamento, à reabertura, ao pagamento e à antecipação (`cards.ts:409-536`), além das tools `get_invoice`, `close_invoice`, `pay_invoice` e `reopen_invoice`. A prévia de `reopen_invoice` mostra `invoice.titles.length` (`tool-handlers-operation.ts:847`), que pode aparecer como 0 com títulos existindo.
- Os testes usam caixas novas, com poucos títulos.

### Impacto
Tela e tools da fatura para caixas com histórico longo: os títulos da fatura somem (sem o atalho para o título a pagar) e cada abertura lê até 1.000 linhas, com as junções de `rowSelect`, por caixa envolvida (o cartão e cada pagadora).

## Como reproduzir
1. Caixa pagadora com 1.000 títulos não arquivados vencendo antes da fatura (por exemplo, uma série semanal antiga).
2. Fechar uma fatura do cartão e abrir `GET /api/card-invoices/:id`: `titles` volta vazio para a pagadora.

## Solução proposta
Buscar só os títulos da fatura: dar a `listTitles` um filtro interno por ids ou por `card_invoice_id` (`t.card_invoice_id = $1`), sem `limit`, mantendo o `readableFilter`, e usar o mesmo `rowSelect`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/titles.ts
+++ b/apps/server/src/services/titles.ts
 export async function listTitles(
   ctx: ServiceContext,
   query: z.output<typeof titleListQuery>,
-  opts: { writableOnly?: boolean } = {},
+  opts: { writableOnly?: boolean; cardInvoiceId?: string } = {},
 ): Promise<TitleRow[]> {
@@
+  if (opts.cardInvoiceId) where.push(sql`t.card_invoice_id = ${opts.cardInvoiceId}`);
--- a/apps/server/src/services/cards.ts
+++ b/apps/server/src/services/cards.ts
-    const all = await Promise.all(... listTitles(ctx, { caixaId, archived: false, limit: 1000 }) ...);
+    const all = await listTitles(ctx, { archived: false, limit: 1000 }, { cardInvoiceId: id });
```
(Se os arquivados também devem aparecer, tratar `archived` à parte.)

## Critérios de aceite
- [ ] A fatura mostra os seus títulos mesmo com mais de mil títulos anteriores na pagadora.
- [ ] `getInvoice` faz uma consulta de títulos limitada à fatura.

## Testes recomendados
`apps/server/test/cards.test.ts`: com o cenário de fechamento, inserir títulos anteriores na pagadora (ou usar uma regra semanal antiga) além do limite e conferir `closed.titles` com as duas pernas.

## Limitações e suposições
Nada foi executado. O número de títulos por caixa em produção não foi verificado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `getInvoice` listava até 1.000 títulos de cada caixa (`listTitles` por `due_date` crescente) e filtrava em memória. Numa pagadora com mais de mil títulos anteriores, os da fatura ficavam de fora.

## Resolução (executor)

- `apps/server/src/services/titles.ts`: `listTitles` com a opção interna `cardInvoiceId` (`t.card_invoice_id = …`, com o `readableFilter` e o mesmo `rowSelect`).
- `apps/server/src/services/cards.ts`: `getInvoice` faz uma consulta só dos títulos da fatura (não arquivados, como antes) e filtra pela pagadora pedida.
- Teste: `apps/server/test/cards.test.ts`, "o detalhe da fatura traz os títulos dela mesmo com mais de mil títulos antes na pagadora (tarefa 084)". Insere 1.005 títulos antigos na pagadora direto no banco e confere as duas pernas no fechamento. O teste falha sem a correção.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
