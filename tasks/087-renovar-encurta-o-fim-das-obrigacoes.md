---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: d658050
---

# Renovar o contrato encurta o fim das obrigações e perde a última ocorrência

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** datas na renovação (meses inteiros, fim de mês)
- **Arquivos afetados:** `apps/server/src/services/contracts.ts:931-978`, `apps/server/src/services/contracts.ts:994-997`, `packages/shared/src/contracts.ts:57-65`, `packages/shared/src/recurrence.ts:55-59`, `docs/020-contratos.md:26,76`, `docs/034-contratos-sobre-series.md:89`
- **Depende de / relacionado a:** tarefa 086
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao renovar um contrato, as obrigações que acompanhavam a vigência deveriam ir até o novo fim. Em vários casos elas terminam antes, e a última parcela da nova vigência simplesmente não é gerada. O aluguel de dezembro some de um contrato renovado até 15/12. Uma mensalidade que vence no dia 31 perde a de outubro numa renovação até 31/10.

### Evidência e análise técnica
`shiftedEnd` (`contracts.ts:958-962`) desloca o fim antigo da série por meses inteiros:

```ts
return addMonths(rule.ends_on, termMonths(addDays(oldEnd, 1), newEnd));
```

`termMonths` arredonda para baixo os meses incompletos, e `addMonths` prende o dia ao do fim antigo, que pode ser 28 ou 30. A ocorrência só existe se `vencimento <= ends_on` (`recurrence.ts:57`). Conferido com as funções reais num script do rascunho, série terminando junto com a vigência:

| vigência até → renovada até | fim novo da série | ocorrência perdida |
|---|---|---|
| 30/04/2027 → 15/12/2027 | 30/11/2027 | a de dezembro (qualquer dia ≤ 15) |
| 30/04/2027 → 31/10/2027 | 30/10/2027 | dia 31 de outubro |
| 28/02/2027 → 29/02/2028 (12 meses) | 28/02/2028 | dia 29 de fevereiro |
| 30/06/2027 → 31/12/2027 | 30/12/2027 | dia 31 de dezembro |

`renewableRules` (`contracts.ts:931-955`) já escolhe só as séries que "iam até o fim do contrato" (fim a menos de um período do fim da vigência). Para elas, o fim certo é o novo fim da vigência.

### Verificação (tentativa de refutação)
- A decisão da implementação (`docs/020:76`) descreve "o antigo deslocado pelo mesmo prazo da renovação (meses...)". A intenção declarada, porém, é estender a obrigação "pelo mesmo tanto" que a vigência (`docs/020:26`), e o resultado fica menor que ela.
- O teste `contracts.test.ts:684-689` fixa `endsOn: '2027-10-30'` para uma renovação até 31/10, mas a obrigação vence no dia 10 e não mostra a perda.
- A prévia (`planRenewal`) mostra o fim novo da série, só que a tela não alerta que ele é anterior ao da vigência.

### Impacto
Toda renovação com fim fora do mesmo dia do mês e toda obrigação com vencimento em fim de mês. A ocorrência que falta não aparece nos previstos, no calendário, na projeção nem na conciliação. Um pagamento real dessa parcela não encontra candidato no extrato.

## Como reproduzir
1. Contrato de 01/11/2026 a 30/04/2027 com obrigação mensal no dia 10 (fim omitido = fim da vigência).
2. `POST /api/contracts/:id/renew` com `{ "endsOn": "2027-12-15" }`.
3. A série termina em 30/11/2027 e não existe a ocorrência de 10/12/2027.

## Solução proposta
- Para as séries de `renewableRules`, o fim novo é o fim novo da vigência (`newEnd`), ou `null` sem fim. Isso vale para o mensal, o anual e o semanal.
- Atualizar a frase da `docs/020:76` (e a da 034, se houver) na mesma mudança.

### Diff/patch proposto — NÃO APLICADO
```diff
-function shiftedEnd(rule: { ends_on: string; frequency: string }, oldEnd: string, newEnd: string | null): string | null {
-  if (newEnd === null) return null;
-  if (rule.frequency === 'weekly') return addDays(rule.ends_on, diffDays(oldEnd, newEnd));
-  return addMonths(rule.ends_on, termMonths(addDays(oldEnd, 1), newEnd));
-}
+/** A série acompanhava a vigência (renewableRules): passa a terminar no novo fim dela. */
+const shiftedEnd = (_rule: unknown, _oldEnd: string, newEnd: string | null) => newEnd;
```

## Critérios de aceite
- [ ] A renovação até 15/12/2027 de uma vigência que terminava em 30/04/2027 gera a ocorrência de 10/12/2027.
- [ ] Uma obrigação no dia 31 renovada de 30/04 até 31/10 tem a ocorrência de 31/10.
- [ ] A prévia mostra o fim da série igual ao da vigência.

## Testes recomendados
- `apps/server/test/contracts.test.ts`, no caso "renovar estende a vigência e as obrigações": renovar até uma data no meio do mês e com uma obrigação de dia 31, conferindo as ocorrências materializadas.
- Ajustar a expectativa `endsOn: '2027-10-30'` (linha 688) para `'2027-10-31'`.

## Limitações e suposições
Nada foi executado contra o banco. As datas da tabela saíram das funções puras do `packages/shared`, rodadas num script do rascunho. Uma série que terminava de propósito alguns dias antes da vigência, ainda dentro de um período, passa a ir até o fim novo. É o comportamento esperado para uma obrigação que "acompanha a vigência".

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `shiftedEnd` deslocava o fim antigo da série por meses inteiros (`termMonths` arredonda para baixo, `addMonths` prende o dia). A renovação até 15/12 perdia a ocorrência de dezembro, e a de dia 31 perdia a de 31/10.

## Resolução (executor)

- `apps/server/src/services/contracts.ts`: `shiftedEnd` saiu. Em `planRenewal`, toda série de `renewableRules` (a que acompanhava a vigência) passa a terminar no novo fim da vigência, ou sem fim, no mensal, no anual e no semanal. A prévia mostra o mesmo fim.
- `docs/020-contratos.md` (renovar e decisões) e `docs/034-contratos-sobre-series.md` (decisões).
- Testes: em `apps/server/test/contracts.test.ts`, a expectativa do caso "renovar estende a vigência e as obrigações" passou a `2027-10-31`. O caso novo "renovar até o meio do mês ou com vencimento no dia 31 não perde a última ocorrência (tarefa 087)" renova até 15/08/2027 e materializa a de 10/08. Depois renova até 31/10/2027, e a obrigação do dia 31 ganha a de 31/10.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
