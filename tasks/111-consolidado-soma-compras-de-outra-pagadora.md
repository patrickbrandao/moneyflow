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

# Relatório consolidado de uma caixa soma as compras de cartão feitas por outra pagadora

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** escopo do relatório (competência × caixa)
- **Arquivos afetados:** `apps/server/src/services/reports.ts:33-44,62-101`, `database/schema.sql:8427-8431,8558-8561`, `packages/shared/src/reports.ts:15-16`, `apps/web/src/pages/ReportsPage.tsx:160-161`, `apps/server/test/vision.test.ts:144-153`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O cartão da família tem a "Casa" como pagadora padrão, mas algumas compras foram lançadas para a "Empresa". Quem abre o relatório por categoria escolhendo só a "Casa" vê as compras da "Empresa" somadas no consolidado. Quem não tem acesso à "Empresa" vê o nome e os valores dela. Os números da "Casa" mudam conforme se olha o consolidado, a visão "Por caixa" ou o regime de caixa.

### Evidência e análise técnica
1. `scopeCaixas` (`reports.ts:33-44`) acrescenta à seleção os cartões cuja **pagadora padrão** está nela: pedir `[Casa]` vira `[Casa, Cartão]`.
2. Por competência, `report_category_totals` e `report_entity_totals` incluem a compra se **a pagadora OU o cartão** está na lista (`schema.sql:8429` e `:8559`), com `caixa_id = p.payer_caixa_id`. Com o cartão na lista entra toda compra dele, inclusive as de pagadora `Empresa`, que não foi pedida.
3. No consolidado, `inScope` (`shared/src/reports.ts:15-16`) fica com tudo que não é interno. A compra da `Empresa` (sempre `is_internal = false` para compras) soma no total.
4. A visão "Por caixa" só oferece caixas gerais (`ReportsPage.tsx:160-161`) e filtra `line.caixaId === scope`. "Por caixa: Casa" não tem essas compras. Resultado: com uma única caixa geral escolhida, o consolidado é diferente da visão dessa caixa.
5. No regime de caixa, o pagamento da fatura só entra pela conta da pagadora (`schema.sql:8455-8457`, `a.caixa_id = ANY`). Ali a parte da `Empresa` fica de fora. Os dois regimes discordam para a mesma seleção.
6. No relatório por entidade, o rastreio mostra o nome da caixa `Empresa` (`reports.ts:97`, `JOIN caixas c ON c.id = r.caixa_id`), mesmo para quem não a lê.

### Verificação (tentativa de refutação)
- A spec 014 (`:31`) diz que o consolidado "soma as caixas escolhidas". A inclusão automática do cartão é para mostrar os gastos da pagadora no cartão, não os de outra pagadora. A spec 007 (`:4`) permite trocar a pagadora por compra, então o caso é previsto.
- O teste `vision.test.ts:152` tem a intenção oposta ("viewer de uma caixa só enxerga ela": nenhuma linha com `caixaId` de B). Ele só passa porque o cenário não tem compra de outra pagadora no cartão.
- Não é vazamento grave: quem lê a pagadora padrão lê o cartão (`authz/access.ts:123-130`) e já vê as compras dele. O problema é o total errado.
- O "OU o cartão" do banco faz sentido quando o próprio cartão é escolhido de propósito (ver o cartão inteiro). Isso deve continuar valendo.

### Impacto
Despesa a mais no consolidado de quem divide um cartão com outra caixa (família e empresa, casal). O total não fecha com a visão por caixa nem com o regime de caixa. O mesmo acontece no CSV/PDF exportado.

## Como reproduzir
1. Caixas A e B. Cartão K com pagadora padrão A. Compra de R$ 100 em K com `payerCaixaId = B`.
2. `GET /api/reports/categories?from=...&to=...&caixaIds=<A>`: aparece uma linha `source=card_purchase`, `caixaId=B`, `amountCents=10000`.
3. Na tela, o consolidado mostra os R$ 100. "Por caixa: A" não mostra. Com `basis=cash`, depois de pagar a fatura de B, também não aparece.

## Solução proposta
Na aplicação (sem mudar o banco), em `categoryReport` e `entityReport`, descartar as linhas `card_purchase` cuja pagadora (`caixa_id`) não está no escopo das caixas gerais, a não ser que o próprio cartão tenha sido pedido explicitamente em `caixaIds`. Exemplo:

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/reports.ts
+++ b/apps/server/src/services/reports.ts
@@ export async function categoryReport(
-  const lines = result.rows.map((row) => {
+  const scopeIds = new Set(caixas.map((c) => c.id));
+  const explicitCards = new Set(q.caixaIds);
+  const lines = result.rows.map((row) => {
     const line = camel<CategoryTotalLine>(row);
     return { ...line, amountCents: Number(line.amountCents), entries: Number(line.entries) };
-  });
+  }).filter((l) => l.source !== 'card_purchase' || scopeIds.has(l.caixaId) || explicitCards.has(l.cardCaixaId!));
```
O mesmo em `entityReport`. Alternativa no banco (dba): um parâmetro com as pagadoras.

Registrar a regra na spec 014: "compras de cartão contam na pagadora; o cartão escolhido sozinho mostra todas".

## Critérios de aceite
- [ ] Com só A escolhida, nenhuma linha tem `caixaId` fora das caixas do escopo.
- [ ] Com o cartão K escolhido explicitamente, as compras de todas as pagadoras aparecem.
- [ ] O consolidado de uma única caixa geral é igual à visão "Por caixa" dela.

## Testes recomendados
`apps/server/test/vision.test.ts`, no `describe('relatórios (spec 014)')`: no `visionScenario`, uma compra no cartão com `payerCaixaId = caixaB`. Conferir que `caixaIds=A` não traz a linha (categorias e entidades); que `caixaIds=<cartão>` traz; e que o viewer só de A não vê linha com `caixaId = B`.

## Limitações e suposições
Não executado. O comportamento do banco foi lido em `schema.sql`. Supus que a intenção da spec é "compra conta na pagadora", como no regime de caixa e na projeção.

## Análise (triagem)

## Resolução (executor)
