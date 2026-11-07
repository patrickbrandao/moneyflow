---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# O escopo da receita (`assertRecipeScope`) não cobre as tools que agem no lote inteiro

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** escopo de autorização incompleto / defesa contra prompt injection
- **Arquivos afetados:** `apps/server/src/agents/tools-runtime.ts:185-207`, `packages/shared/src/agents/tools-supersede.ts:12-28`, `packages/shared/src/agents/recipes.ts:183-216`, `packages/shared/src/agents/tools-operation.ts:283-285`, `docs/030-receitas-de-conciliacao.md:34`
- **Depende de / relacionado a:** 056
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
A receita deveria mexer só em algumas linhas do extrato. Mas, se o kit do agente permitir, ele consegue mexer no lote inteiro, ou em outros lotes: marcar como provisório, trocar pelo consolidado, criar ou disparar outra receita. Isso pode acontecer induzido pelo texto das próprias linhas do extrato, que é dado externo.

### Evidência e análise técnica
- `inputLineIds` (`tools-runtime.ts:185-207`) só olha `lineId`, `lineIds` e `matches`/`items`/`suggestions`. A checagem roda só para `category === 'reconciliation'`.
- Passam sem checagem: `set_statement_import_provisional` e `supersede_statement_import` (`tools-supersede.ts:12-28`); `run_reconcile_recipe` e o CRUD de receita (`recipes.ts:183-216`); `set_statement_import_balance`, que é da categoria `imports` (`tools-operation.ts:283-285`).

### Verificação (tentativa de refutação)
- Refutado: o `consolidatedLineId` de `resolve_superseded_lines` não é alcançável. O `items[].lineId` é checado e aponta para uma linha do provisório, fora do escopo, então a tool inteira já é recusada.
- O kit decide allow/ask, e o `Access` vale sempre. O `run_reconcile_recipe` no mesmo lote cai no 409 da trava, mas em outro lote não.
- `docs/030:34` só promete o escopo para as tools "que recebem uma linha". As de lote ficam fora da promessa: é defesa em profundidade, não violação literal.

### Impacto
Uma execução de receita pode alterar o lote, ou outros lotes, além do escopo das linhas, dentro das permissões do usuário e do kit.

## Como reproduzir
Com o provedor falso, numa execução de receita cujo kit tem `supersede_statement_import` em allow, pedir essa tool: ela executa.

## Solução proposta
- Numa execução de receita (`ctx.recipeLineIds`), recusar as tools de nível de lote ou de receita.
- Alternativa mais fina: exigir que o `importId`/`statementImportId` seja o lote da receita, levando o `importId` ao `ServiceContext`.
- Alternativa à lista: uma flag `recipeSafe` no `define`.
- Listar as tools vetadas em `docs/030:34`. Incluir ou não `set_statement_import_balance` é decisão de produto.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/tools-runtime.ts
+++ b/apps/server/src/agents/tools-runtime.ts
@@
+/** Tools de lote ou de receita: fora de uma execução de receita (spec 030). */
+const RECIPE_DENIED = new Set([
+  'set_statement_import_provisional', 'supersede_statement_import', 'resolve_superseded_lines',
+  'run_reconcile_recipe', 'create_reconcile_recipe', 'update_reconcile_recipe', 'archive_reconcile_recipe',
+  'set_statement_import_balance',
+]);
+
 export function assertRecipeScope(ctx: ServiceContext, def: AgentToolDef, input: unknown) {
-  if (!ctx.recipeLineIds || def.category !== 'reconciliation') return;
+  if (!ctx.recipeLineIds) return;
+  if (RECIPE_DENIED.has(def.name)) throw unprocessable(t.agents.recipes.outOfScope, 'line_out_of_scope');
+  if (def.category !== 'reconciliation') return;
```
Conferir os nomes exatos das tools de CRUD de receita no registro.

## Critérios de aceite
- [ ] Numa execução de receita, as tools de lote/receita devolvem erro de escopo e não gravam.
- [ ] Fora de uma receita, nada muda.
- [ ] `docs/030` atualizada.

## Testes recomendados
`test/reconcile-recipes.test.ts`: o provedor falso pede `supersede_statement_import` e `run_reconcile_recipe` numa execução de receita; esperar `tool_result` com erro e o lote sem mudança. Nada disso foi executado nesta auditoria.

## Limitações e suposições
A lista precisa ser mantida quando entrar tool nova.

## Análise (triagem)

Sem triage (auditoria verificada; a sessão principal designou o app). Confirmado: `assertRecipeScope` (`agents/tools-runtime.ts`) só olhava as tools `reconciliation` e as linhas citadas; as de lote (`set_statement_import_provisional`, `supersede_statement_import`, `resolve_superseded_lines`), a de saldo (`set_statement_import_balance`, categoria `imports`) e o CRUD/play das receitas passavam. Nomes reais conferidos no registro: `create_reconcile_recipe`, `update_reconcile_recipe`, `archive_reconcile_recipe`, `run_reconcile_recipe` (`list_reconcile_recipes` é leitura e fica liberada). Executor: app.

## Resolução (executor)

Decisão da sessão principal (2026-11-07): `set_statement_import_balance` entra na lista negada numa execução de receita.

- `RECIPE_DENIED_TOOLS` em `apps/server/src/agents/tools-runtime.ts`; numa execução de receita (`ctx.recipeLineIds`), essas tools dão 422 `tool_out_of_scope` (`t.agents.recipes.toolOutOfScope`) na prévia e na execução, sem gravar. Fora da receita nada muda. Nenhuma tool nova.
- Teste: `test/reconcile-recipes.test.ts` (mesmo caso da 056) — o provedor falso pede `set_statement_import_provisional`, `set_statement_import_balance`, `supersede_statement_import`, `run_reconcile_recipe` e `archive_reconcile_recipe`; os cinco `tool_result` voltam com erro e o lote, o saldo e a receita ficam como estavam.
- Spec: `docs/030-receitas-de-conciliacao.md` (Escopo garantido no servidor, com a lista).
