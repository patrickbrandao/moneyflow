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

# Competência das ocorrências novas da série escorrega para o dia 28 depois de fevereiro

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** soma de meses em dia 29–31
- **Arquivos afetados:** `packages/shared/src/recurrence.ts:39-52`, `apps/server/src/services/recurrence.ts:16-19,43-48,74`, `apps/web/src/components/titles/TitleFormModal.tsx:52`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Uma conta recorrente criada com competência no dia 31 (ou 29, ou 30) recebe, a partir de certo mês, ocorrências com competência no dia 28, e assim fica para sempre. O vencimento continua certo. O mês da competência também (os relatórios não mudam), mas a data mostrada no título fica errada.

### Evidência e análise técnica
O worker usa como modelo a ocorrência **mais recente** da série (`services/recurrence.ts:43-48`) e calcula a competência a partir dela:

```ts
competenceDate: occurrenceCompetenceDate(rule, { occurrence: template.occurrence, competenceDate: template.competenceDate }, n),
```

`occurrenceCompetenceDate` (`shared/src/recurrence.ts:51`) chama `addMonths(template.competenceDate, delta)` **sem** o dia âncora. Então o dia do modelo vira a âncora. Quando o modelo é a ocorrência de fevereiro (dia 28), as seguintes saem no dia 28. Executado com o fonte:

```
occurrenceCompetenceDate(mensal, { occurrence: 1, competenceDate: '2026-01-31' }, 2) → '2026-02-28'
occurrenceCompetenceDate(mensal, { occurrence: 2, competenceDate: '2026-02-28' }, 3) → '2026-03-28'   (esperado 2026-03-31)
```

Na criação, as 12 primeiras ocorrências nascem certas, todas do modelo 1. O escorregão começa no worker: no mês em que o modelo passa a ser a ocorrência de fevereiro do ano seguinte, a de março sai com dia 28, e dali em diante todas.

O formulário de título usa hoje como competência padrão (`TitleFormModal.tsx:52`). Uma série criada nos dias 29 a 31 cai nesse caso sem o usuário perceber.

### Verificação (tentativa de refutação)
- O vencimento não tem o problema: `occurrenceDueDate` usa `rule.anchorDay`.
- As obrigações de contrato usam a competência no dia 1 (`series.ts:375`, `monthStart`) e não são afetadas.
- O mês fica sempre certo, porque `addMonths` limita o dia dentro do mês de destino. Por isso relatórios e fechamento de mês (que olham o mês) não mudam.
- O teste existente (`packages/shared/test/money-dates.test.ts:72`) usa o dia 1.

### Impacto
Data de competência errada (dia 28 em vez de 31) nas ocorrências futuras de séries criadas nos dias 29 a 31. Aparece na tela, no CSV e nas tools dos agentes. Os totais não mudam.

## Como reproduzir
1. Crie um título mensal recorrente com competência e vencimento em 31/01/2026.
2. Rode `materializeRule(tx, regra, horizonte)` avançando o horizonte mês a mês até março de 2027.
3. A ocorrência de março de 2027 tem `competence_date = 2027-03-28` e `due_date = 2027-03-31`.

## Solução proposta
Usar uma âncora fixa para a competência: o dia da competência da **primeira** ocorrência que ainda existe na série (ou de `starts_on`, se não houver nenhuma).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/shared/src/recurrence.ts
+++ b/packages/shared/src/recurrence.ts
@@ export function occurrenceCompetenceDate(
   rule: RecurrenceRule,
   template: { occurrence: number; competenceDate: string },
   n: number,
+  /** Dia da competência original da série (a 1ª ocorrência); sem ele, o do modelo. */
+  competenceAnchorDay?: number,
 ): string {
@@
-  return addMonths(template.competenceDate, (n - template.occurrence) * monthsStep(rule));
+  return addMonths(template.competenceDate, (n - template.occurrence) * monthsStep(rule), competenceAnchorDay);
```

Em `materializeRule`, buscar a competência da menor `occurrence` da série (lado original) e passar o dia dela.

## Critérios de aceite
- [ ] Uma série com competência no dia 31 mantém o último dia do mês em todas as ocorrências criadas pelo worker, inclusive depois de fevereiro.
- [ ] Uma série com competência no dia 1 ou 15 não muda.

## Testes recomendados
- `packages/shared/test/money-dates.test.ts`: `occurrenceCompetenceDate` com modelo de fevereiro e âncora 31, esperando `…-03-31`.
- `apps/server/test/titles.test.ts`: série mensal em 31/01, materializada com horizontes sucessivos até março do ano seguinte, conferindo a competência.

## Limitações e suposições
As funções do shared foram executadas num script descartável. A sequência do worker foi deduzida do código (o modelo é a ocorrência mais recente), sem rodar contra o banco.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `occurrenceCompetenceDate` somava os meses a partir da competência do modelo (a ocorrência mais recente) sem âncora; com o modelo de fevereiro (dia 28), ou de um mês de 30 dias, as seguintes saíam presas no dia menor. Reproduzido no teste novo antes da correção (`2027-12-30` no lugar de `2027-12-31`).

## Resolução (executor)

- `packages/shared/src/recurrence.ts`: `occurrenceCompetenceDate(regra, modelo, n, competenceAnchorDay?)`, a âncora do dia na série mensal ou anual.
- `apps/server/src/services/recurrence.ts`: `materializeRule` lê a competência da 1ª ocorrência que ainda existe na série (lado original) e passa o dia dela como âncora.
- Spec 005 (materialização das séries).
- Testes: `packages/shared/test/money-dates.test.ts` (modelo de fevereiro com âncora 31 dá `…-03-31` e `…-04-30`; dias 1 e 15 não mudam; anual no dia 29) e `apps/server/test/titles.test.ts`, "a série no dia 31 mantém o último dia do mês…": série em 31/01/2026 materializada mês a mês pelo horizonte (como o worker) até 30 meses, com todas as competências e vencimentos no último dia do mês.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
