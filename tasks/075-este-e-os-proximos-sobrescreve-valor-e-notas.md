---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# "Este e os próximos" no formulário do título sobrescreve o valor e as notas das ocorrências seguintes, mesmo sem mudá-los

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** perda silenciosa de reajuste e notas nas séries
- **Arquivos afetados:** `apps/web/src/components/titles/TitleFormModal.tsx:120-131`, `apps/server/src/services/titles.ts:340-406` (em especial `364`, `375-403`), `apps/server/src/services/series.ts:537-671` (contraste), `docs/005-titulos-baixas-e-movimentos.md:5,11`, `docs/034-contratos-sobre-series.md:39`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Numa série com reajuste (o aluguel sobe de 1.000 para 1.100 a partir de julho), quem abre a ocorrência de março, troca só a categoria e escolhe "Este e os próximos" volta todas as ocorrências seguintes para 1.000, sem aviso. As observações de cada ocorrência seguinte também são trocadas pelas de março (ou apagadas). E mudar o vencimento com "Este e os próximos" só muda a de março.

### Evidência e análise técnica
- O formulário de edição manda sempre todos os campos: `description`, `categoryId`, `amountCents`, `dueDate`, `competenceDate`, `notes`, `scope` e `entityId` (`TitleFormModal.tsx:121-129`), mudados ou não.
- No servidor, com `scope = 'following'` (`titles.ts:364`), o laço das seguintes monta `futurePatch` com todo campo presente no corpo (`titles.ts:388-394`): `amountCents`, `notes`, `categoryId`, `description`, `entityId`. Não compara com o valor atual da ocorrência editada. As seguintes em aberto (`status = 'open'`, `titles.ts:376-387`) recebem o valor e as notas desta.
- Quando o valor da seguinte difere, `syncMirror` muda o espelho junto e, sem escrita na outra caixa, devolve o espelho para "aguardando aceite" (`titles.ts:397-400`, `425`). Pelo lado espelho, a edição inteira falha com `mirrorEditOriginal` se alguma seguinte tiver valor diferente.
- O vencimento não vai para as seguintes ("datas seguem a regra", `titles.ts:374`), mas o seletor "Aplicar a: Este e os próximos" fica ao lado do campo de vencimento. A mudança de dia da série só existe em "Editar série" (`planSeriesChange` com `anchorDay`, `series.ts:549-555,633`).
- Há duas implementações de "esta e as próximas" na mesma gaveta: a de `updateTitle` e a de `planSeriesChange` ("Editar série", aditivo). A segunda pula ocorrências de mês fechado (`series.ts:618-631`), pega o advisory lock da série (`loadRule(tx, id, true)`, `series.ts:60`) e só aplica o que o pedido traz de fato. A primeira não faz nada disso.

### Verificação (tentativa de refutação)
- Banco: `titles_period_lock` e `titles_mirror_check` não impedem mudar o valor das seguintes em aberto; só o mês fechado bloquearia, e aí a edição inteira falha.
- Testes: o único caso com `scope: 'following'` (`statements.test.ts:777`) manda só `plannedAccountId`; nenhum teste nem e2e cobre o corpo completo que o formulário envia.
- Spec 005:5 diz que "esta e as próximas" reescreve os futuros, mas a 034:39 e a 005:11 tratam valor e dia como mudanças explícitas a partir de uma data. Nada pede reverter um reajuste já aplicado quando o usuário edita outro campo.
- A tool `update_title` só manda o que o agente pede, então o defeito aparece sobretudo pela tela.

### Impacto
Reajustes e valores especiais de ocorrências futuras voltam ao valor antigo sem aviso, e as notas são perdidas. A conciliação passa a procurar o valor errado (`seriesMatch` usa o valor da ocorrência). Editar uma ocorrência de série com "Este e os próximos" é um fluxo comum.

## Como reproduzir
1. Série mensal de 1.000 (13 ocorrências). `PATCH /api/series/:id { amountCents: 110000, effectiveOn: <vencimento da 7ª> }` ou um aditivo.
2. Na tela, abrir a 3ª ocorrência, Editar, trocar só a categoria, "Este e os próximos", Salvar (corpo: `{ ..., amountCents: 100000, notes: null, scope: 'following' }`).
3. `GET /api/titles?caixaId=…`: da 4ª à 13ª voltam a 1.000; as notas delas ficam `null`.

## Solução proposta
1. Servidor: em `scope = 'following'`, propagar só os campos que mudaram em relação à ocorrência editada (`input.x !== undefined && input.x !== title.x`). Isso protege também clientes antigos.
2. Preferível: fazer `updateTitle` com `following` delegar a `planSeriesChange(ctx, tx, loadRule(tx, ruleId, true), change, title.dueDate, true)`, com o `change` montado só pelos campos mudados (inclusive `anchorDay` quando o dia do vencimento muda). Assim ficam uma regra só, o lock, as puladas por mês fechado e a mudança do dia.
3. Formulário: mandar só os campos alterados e, com "Este e os próximos", dizer que valor, dia, categoria, descrição e conta vão para as seguintes em aberto sem baixa.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/titles.ts
+++ b/apps/server/src/services/titles.ts
@@
-      const futurePatch: Patch = {};
-      if (input.categoryId !== undefined) futurePatch.categoryId = input.categoryId;
-      if (input.description !== undefined) futurePatch.description = input.description;
-      if (input.amountCents !== undefined) futurePatch.amountCents = input.amountCents;
-      if (input.notes !== undefined) futurePatch.notes = input.notes;
-      if (input.entityId !== undefined && !mirror) futurePatch.entityId = input.entityId;
+      // Só o que mudou nesta ocorrência vai para as próximas (o formulário manda o corpo inteiro).
+      const changed = <K extends keyof Patch>(k: K, v: Patch[K] | undefined) => v !== undefined && v !== title[k as keyof typeof title];
+      const futurePatch: Patch = {};
+      if (changed('categoryId', input.categoryId)) futurePatch.categoryId = input.categoryId;
+      if (changed('description', input.description)) futurePatch.description = input.description;
+      if (changed('amountCents', input.amountCents)) futurePatch.amountCents = input.amountCents;
+      if (changed('notes', input.notes)) futurePatch.notes = input.notes;
+      if (!mirror && changed('entityId', input.entityId)) futurePatch.entityId = input.entityId;
```

## Critérios de aceite
- [ ] Editar só a categoria com "Este e os próximos" não muda valor nem notas das seguintes.
- [ ] Mudar o valor com "Este e os próximos" muda as seguintes em aberto sem baixa e pula as de mês fechado, como "Editar série".
- [ ] Mudar o dia do vencimento com "Este e os próximos" move as seguintes (ou a tela deixa claro que só muda esta).

## Testes recomendados
`test/titles.test.ts`, novo `describe('esta e as próximas')`: série mensal, reajuste a partir da 7ª por `PATCH /api/series/:id`; depois `PATCH /api/titles/<3ª>` com o corpo completo do formulário (valor atual, categoria nova, `notes: null`, `scope: 'following'`). Esperar: 4ª–6ª com a categoria nova e o valor antigo, 7ª–13ª com o valor reajustado e as notas intactas. Um e2e em `e2e/` editando pela gaveta cobriria o corpo real.

## Limitações e suposições
Nada foi executado. O comportamento do formulário foi lido no código (`TitleFormModal.tsx`), não observado no navegador.

## Análise (triagem)

## Resolução (executor)
