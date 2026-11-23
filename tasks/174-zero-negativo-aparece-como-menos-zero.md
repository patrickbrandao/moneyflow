---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Zero negativo aparece como "-R$ 0,00" no formato contábil

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** formatação de dinheiro (-0)
- **Arquivos afetados:** `packages/shared/src/money.ts:9-24,53-54`, `apps/web/src/components/reports/ProjectionReport.tsx:77-83`, `apps/web/src/components/TitleMiniTable.tsx:39`, `apps/web/src/components/caixa/PlannedOccurrences.tsx:84`, `apps/web/src/components/forms.tsx:52-59`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
No fluxo projetado, a linha "A pagar" mostra "-R$ 0,00" quando não há nada a pagar. O mesmo acontece em títulos a pagar já quitados (por exemplo, os títulos da fatura e a lista de "conta a definir" na visão geral). O formato contábil da spec pede "R$ 0,00" para o zero.

### Evidência e análise técnica
A tela inverte o sinal das saídas antes de formatar:

```tsx
const value = m.sign === -1 ? -raw : raw;   // ProjectionReport.tsx:79
{formatAccounting(value)}                     // :82
```

Com `raw = 0`, `value` vale `-0`. Em `formatAccounting` (`money.ts:22-24`), `-0 < 0` é falso, então cai em `formatBRL(-0)`. O `Intl.NumberFormat` mostra o sinal do zero negativo (`signDisplay: 'auto'`). Saída medida com um script descartável que importa o fonte:

```
formatAccounting(-0) → "-R$ 0,00"
formatBRL(-0)        → "-R$ 0,00"
formatCents(-0)      → "-0,00"
parseBRL("-0")       → -0
```

O mesmo padrão `-x` com `x = 0` aparece em `TitleMiniTable.tsx:39` (`-title.openCents` de título a pagar pago, usado em `InvoicePage.tsx:258` e `OverviewPage.tsx:155`) e em `PlannedOccurrences.tsx:84`. No `MoneyInput` (`forms.tsx:52-59`), digitar "-0" com `allowNegative` volta como "-0,00" no blur.

### Verificação (tentativa de refutação)
- A exportação não é afetada: `centsToCsv` e `formatCell` testam `cents < 0` e montam o texto à mão. CSV e PDF saem "0,00" e "R$ 0,00".
- A spec 014 (`:44`) define "Zero e positivo seguem `R$ 1.234,56`".
- `packages/shared/test/money-dates.test.ts` não tem caso de `-0`.

### Impacto
Cosmético, mas aparece toda vez que a pagar ou vencidos a pagar é zero (o caso comum de "vencidos"), além dos títulos quitados da fatura. Contradiz o formato contábil da spec.

## Como reproduzir
Relatórios → aba Fluxo projetado, numa caixa sem títulos a pagar vencidos: a linha "Vencidos a pagar" mostra "-R$ 0,00" nas três colunas.

## Solução proposta
Normalizar o zero nas funções do shared, para valer em todo chamador:

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/shared/src/money.ts
+++ b/packages/shared/src/money.ts
@@
 export function formatBRL(cents: number): string {
-  return brl.format(cents / 100);
+  return brl.format((cents + 0) / 100); // -0 + 0 === +0
 }
@@
 export function formatCents(cents: number): string {
-  return plain.format(cents / 100);
+  return plain.format((cents + 0) / 100);
 }
@@ export function parseBRL(input: string): number | null {
-  return negative ? -cents : cents;
+  return negative && cents !== 0 ? -cents : cents;
```

## Critérios de aceite
- [ ] `formatAccounting(-0)` é `R$ 0,00` e `formatCents(-0)` é `0,00`.
- [ ] `parseBRL('-0')` devolve `0` (`Object.is(…, 0)`).
- [ ] O fluxo projetado sem a pagar mostra `R$ 0,00`.

## Testes recomendados
`packages/shared/test/money-dates.test.ts`: os três casos acima. Opcional: e2e do relatório projetado conferindo que nenhuma célula tem `-R$`.

## Limitações e suposições
As saídas das funções foram executadas num script descartável no Node 26 desta máquina. A renderização das telas foi deduzida do código.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `formatBRL(-0)`, `formatCents(-0)` e `formatAccounting(-0)` mostravam o sinal (`-R$ 0,00`), e `parseBRL('-0')` devolvia `-0`.

## Resolução (executor)

- `packages/shared/src/money.ts`: `formatBRL` e `formatCents` normalizam o zero (`cents + 0`), o que vale para `formatAccounting`, `formatSignedBRL` e todo chamador (fluxo projetado, `TitleMiniTable`, `PlannedOccurrences`, `MoneyInput`); `parseBRL` não devolve `-0`.
- Spec 014 (formato contábil: o zero negativo sai como zero).
- Teste em `packages/shared/test/money-dates.test.ts`, "o zero negativo sai sem sinal": `formatAccounting(-0)`, `formatBRL(-0)`, `formatCents(-0)`, `formatSignedBRL(-0)` e `parseBRL('-0')`/`parseBRL('-0,00')` (`Object.is(…, 0)`).
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
