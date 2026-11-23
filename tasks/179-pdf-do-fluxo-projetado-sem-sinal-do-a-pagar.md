---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 6a7d975
---

# Fluxo projetado exportado mostra o "a pagar" positivo, ao contrário da tela e da spec 014

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** sinal na exportação CSV/PDF
- **Arquivos afetados:** `apps/web/src/components/reports/ProjectionReport.tsx:16-24,76-83,115-135`, `docs/014-visualizacao-e-relatorios.md:44`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Na tela do fluxo projetado, "A pagar" e "Vencidos a pagar" aparecem negativos, entre parênteses. No PDF e no CSV exportados os mesmos valores saem positivos. Quem soma a coluna na planilha não chega ao "Projetado".

### Evidência e análise técnica
- A tela inverte o sinal das métricas com `sign: -1` (`ProjectionReport.tsx:20,22`): `const value = m.sign === -1 ? -raw : raw` (`:79`).
- A exportação usa o valor cru: `...Object.fromEntries(METRICS.map((m) => [m.key, Number(l[m.key] ?? 0)]))` (`:132`), sem olhar `m.sign`.
- A spec 014 (`:44`) diz: "No fluxo projetado, a pagar e vencidos a pagar aparecem como negativos. O PDF exportado usa o mesmo formato, com o negativo em vermelho escuro; o CSV mantém o número cru (`-1234,56`) para a planilha somar." O PDF deveria trazer `(R$ …)` em vermelho, e o CSV o número negativo.

### Verificação (tentativa de refutação)
- `downloadPdf` só pinta de vermelho quando `cents < 0` (`lib/export.ts:67-70`), e `formatCell` só põe parênteses no negativo. O positivo exportado sai preto, sem parênteses.
- As exportações dos outros relatórios usam o valor já com o sinal da tela (`CategoryReport.tsx:190-196`, `EntityReport.tsx:118-129`). Só a projeção diverge.

### Impacto
O PDF e o CSV do fluxo projetado ficam diferentes da tela. Na planilha, `saldo + a receber + a pagar` não dá o projetado.

## Como reproduzir
Relatórios → Fluxo projetado, numa caixa com título a pagar em aberto → Exportar PDF. A linha "A pagar" sai como `R$ X` preto. Na tela, `(R$ X)` em vermelho.

## Solução proposta
Aplicar o mesmo sinal na exportação.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/components/reports/ProjectionReport.tsx
+++ b/apps/web/src/components/reports/ProjectionReport.tsx
@@
-      ...Object.fromEntries(METRICS.map((m) => [m.key, Number(l[m.key] ?? 0)])),
+      ...Object.fromEntries(METRICS.map((m) => [m.key, (m.sign === -1 ? -1 : 1) * Number(l[m.key] ?? 0)])),
```

## Critérios de aceite
- [ ] No PDF, "A pagar" e "Vencidos a pagar" saem entre parênteses e em vermelho escuro.
- [ ] No CSV, os dois saem negativos, e saldo + agendado + a receber + a pagar = projetado.

## Testes recomendados
Hoje a função de exportação não tem teste. Mover `projectionExport` (pura) para um teste no shared, ou cobrir no e2e de relatórios baixando o CSV da projeção e conferindo o sinal da coluna "A pagar".

## Limitações e suposições
Nada foi executado. Supus que a API devolve `payableCents` e `overduePayableCents` positivos, como diz o comentário de `:78`.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: a tela invertia o sinal de "A pagar" e "Vencidos a pagar" (`sign: -1`), e `projectionExport` exportava o valor cru.

## Resolução (executor)
As métricas do fluxo projetado e a exportação foram para o shared (`packages/shared/src/reports.ts`: `PROJECTION_METRICS`, `projectionValue` e `projectionExport`), e a tela (`ProjectionReport.tsx`) e a exportação usam o mesmo `projectionValue`: no PDF, a pagar e vencidos a pagar saem entre parênteses e em vermelho escuro; no CSV, negativos, e saldo + agendado + a receber + a pagar = projetado. O zero de uma saída não vira −0. A spec 014 já dizia isso; o código passou a seguir.

Testes: `packages/shared/test/projection.test.ts` (sinais exportados, a soma das colunas igual ao projetado, colunas de dinheiro e destaque da linha da caixa). Verificação: `pnpm verify:quick`.
