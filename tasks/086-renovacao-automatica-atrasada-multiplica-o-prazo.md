---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Renovação automática atrasada vira uma vigência só e multiplica o prazo das seguintes

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** renovação automática (`syncLifecycle`)
- **Arquivos afetados:** `apps/server/src/services/contracts.ts:486-506`, `apps/server/src/services/contracts.ts:981-999`, `packages/shared/src/contracts.ts:57-65`, `docs/020-contratos.md:27,78`, `docs/034-contratos-sobre-series.md:89`
- **Depende de / relacionado a:** tarefa 087 (mesma área, defeito diferente)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Um contrato de 12 meses com renovação automática, cadastrado depois de já ter vencido algumas vezes (ou com o worker parado por mais de um prazo), é renovado numa vigência única de 24, 36 ou mais meses. Na renovação seguinte o sistema repete esse prazo gigante: o contrato e as obrigações passam a ser estendidos de 36 em 36 meses, em vez de 12 em 12.

### Evidência e análise técnica
`syncLifecycle` (`contracts.ts:498-505`) calcula o prazo pela última vigência e avança o fim quantas vezes for preciso, mas grava uma única renovação:

```ts
const months = termMonths(last?.startsOn ?? contract.startsOn, contract.endsOn);
let endsOn = contract.endsOn;
while (endsOn < today) endsOn = cycleEnd(addDays(endsOn, 1), months);
const renewed = await renewInTx(ctx, tx, contract, endsOn);
```

`renewInTx` (`contracts.ts:988-993`) insere UM `contract_cycles` de `contract.endsOn + 1` até o `endsOn` final. Na próxima passada, `cycles.at(-1)` é esse ciclo e `termMonths` devolve N × prazo.

Conferido com um script no rascunho (funções reais do `packages/shared`): contrato 01/01/2023–31/12/2023 (12 meses), hoje 21/11/2026 → nova vigência 01/01/2024–31/12/2026 e `termMonths('2024-01-01', '2026-12-31') = 36`. Em 01/01/2027 o worker renova até 31/12/2029, e as séries são estendidas pelos mesmos 36 meses (`shiftedEnd`, `contracts.ts:958-962`).

### Verificação (tentativa de refutação)
- A spec pede o contrário: "renova pelo mesmo prazo da última vigência (quantas vezes for preciso até cobrir hoje)" (`docs/020:27`) e "pelo prazo da última vigência até cobrir hoje" (`docs/034:89`).
- O banco só exige contiguidade dos ciclos (`contract_cycles_contiguous_check`), não o prazo de cada um.
- O teste `contracts.test.ts:705-719` usa um contrato de 6 meses vencido há menos de um prazo: o laço roda uma vez só e não pega o caso.

### Impacto
Contratos cadastrados retroativamente com renovação automática (situação comum ao migrar contratos antigos) e qualquer parada longa do worker. O prazo cresce sem limite a cada renovação, as obrigações ganham ocorrências por anos e o histórico de vigências fica errado.

## Como reproduzir
1. `POST /api/contracts` com `startsOn: 2023-01-01`, `endsOn: 2023-12-31`, `autoRenew: true` e uma obrigação mensal.
2. Rodar `contractMaintenance(db, '2026-11-21')`: vigência 2 vai de 2024-01-01 a 2026-12-31.
3. Rodar `contractMaintenance(db, '2027-01-02')`: vigência 3 vai até 2029-12-31.

## Solução proposta
Renovar um prazo por vez, cada um com a sua vigência, até cobrir hoje. O aviso usa o `seq` da última.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/contracts.ts
+++ b/apps/server/src/services/contracts.ts
@@ export async function syncLifecycle(
-  let endsOn = contract.endsOn;
-  while (endsOn < today) endsOn = cycleEnd(addDays(endsOn, 1), months);
-  const renewed = await renewInTx(ctx, tx, contract, endsOn);
-  return { action: 'renewed', startsOn: addDays(contract.endsOn, 1), endsOn, seq: renewed.seq };
+  const startsOn = addDays(contract.endsOn, 1);
+  let current = contract;
+  let seq = 0;
+  for (let i = 0; current.endsOn! < today && i < 600; i += 1) {
+    const next = cycleEnd(addDays(current.endsOn!, 1), months);
+    seq = (await renewInTx(ctx, tx, current, next)).seq;
+    current = await loadContract(tx, contractId, true);
+  }
+  return { action: 'renewed', startsOn, endsOn: current.endsOn!, seq };
```

## Critérios de aceite
- [ ] Contrato de 12 meses vencido há três prazos ganha três vigências de 12 meses.
- [ ] A renovação seguinte estende por 12 meses, e as obrigações também.

## Testes recomendados
`apps/server/test/contracts.test.ts`: contrato com `startsOn` 3 anos atrás, prazo de 12 meses e `autoRenew`. Chamar `contractMaintenance` com hoje e depois com uma data após o novo fim, e conferir `cycles` (seq, início, fim de cada um) e o `endsOn` da obrigação.

## Limitações e suposições
Nada foi executado contra o banco. Só as funções puras do `packages/shared` rodaram num script do rascunho. A materialização a cada passo do laço custa mais, porém roda uma vez por contrato atrasado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `syncLifecycle` avançava o fim no laço, mas gravava uma vigência só, de `contract.endsOn + 1` até o fim final. Na passada seguinte, `termMonths` da última vigência devolvia N × prazo.

## Resolução (executor)

- `apps/server/src/services/contracts.ts`: `syncLifecycle` renova um prazo por vez (`renewInTx` com `cycleEnd(fim + 1, meses)`), recarregando o contrato a cada passo, até cobrir hoje (teto de 600). Cada vigência tem o prazo da última. O aviso usa o `seq` da última, e o corpo mostra o início da primeira e o fim da última.
- `docs/020-contratos.md` e `docs/034-contratos-sobre-series.md`: "uma vigência por prazo".
- Teste: `apps/server/test/contracts.test.ts`, "renovação automática atrasada: uma vigência por prazo e a seguinte pelo mesmo prazo (tarefa 086)". O contrato vai de 2023-01-01 a 2023-12-31. Em 21/11/2026, ganha as vigências 2 a 4 de 12 meses e a obrigação vai até 31/12/2026. Em 02/01/2027, ganha a vigência 5 até 31/12/2027, com a obrigação junto.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
