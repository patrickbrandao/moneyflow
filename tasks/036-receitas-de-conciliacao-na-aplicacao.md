---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-16
commit:
---

# Receitas de conciliação na aplicação (F16)

## Descrição
Lacuna entre o código atual (v0.1.8) e a spec [030](../docs/030-receitas-de-conciliacao.md), seção "Aplicação (app)". O que fazer: `pnpm db:pull`; serviço `services/reconcile-recipes.ts` (CRUD com `Access`, aplicáveis ao lote, `runRecipe`, fila do import); `reconcileImportWithAi` enfileirando as receitas ao importar; bloco da receita no prompt e o escopo `lineIds` recusado nas tools de conciliação; o worker iniciando a próxima da fila; rotas; tools `list/create/update/archive/run_reconcile_recipe`; variáveis do lote no `prompt-vars.ts`; backup (receitas e alvos; execuções em `EXCLUDED_TABLES`); telas (Conciliação → Receitas, painel Receitas na tela do lote, a lista no cadastro da conta/cartão); textos pt-BR.

Ordem: depois da [035](035-receitas-de-conciliacao-no-banco.md). A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec na mesma mudança (seção "Decisões da implementação (F16)").

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: testes de integração **simples** em `test/reconcile-recipes.test.ts` (CRUD e permissão, play com kit `allow`, linha fora do escopo recusada, 409 com execução ativa, sequência ao importar) com o provedor falso, mais `pnpm verify:quick`. O usuário pediu testes simples: sem e2e novo.

## Análise (triagem)
Designada direto pela sessão principal (recurso especificado pelo usuário em 2026-10-16).

**Executor designado: app.**

## Resolução (executor)
Feito pelo app em 2026-10-16 (sem commit; a sessão principal commita). Decisões e o que ficou simplificado na seção "Decisões da implementação (F16)" da [030](../docs/030-receitas-de-conciliacao.md).

- `pnpm db:pull` com a 0047 aplicada (schema Drizzle regenerado).
- Serviço `apps/server/src/services/reconcile-recipes.ts` (CRUD com `Access`, receitas do lote, `runRecipe`, fila do import com `ai_reconcile_recipe_claim`/`pending_imports`, `recipesTick`); `reconcileImportWithAi` enfileira as receitas "rodar ao importar" (senão a genérica) e cria a execução genérica na mesma transação do lock/busy; worker (`agents/worker.ts`) roda `recipesTick` no ritmo da fila e ao fim de cada execução.
- Runner: bloco da receita na parte volátil do prompt e `recipeLineIds` no contexto; `assertRecipeScope` em `agents/tools-runtime.ts` recusa a linha fora do escopo nas tools de conciliação (prévia e execução).
- Rotas `routes/reconcile-recipes.ts`; tools `list/create/update/archive/run_reconcile_recipe` (`RECIPE_TOOLS` no shared e `agents/tool-handlers-recipes.ts`); variáveis do lote em `prompt-vars.ts` (`RECIPE_PROMPT_VARIABLES`, validadas no schema); textos em `t.agents.recipes` e `t.agentsUi.recipes`; mensagens das constraints da 0047 em `DB_CONSTRAINT_MESSAGES`; backup (execuções em `EXCLUDED_TABLES`, receitas e alvos no `DEFERRED_CLUSTER`).
- Web: `/reconcile-recipes` (`pages/ReconcileRecipesPage.tsx`, na navegação), painel Receitas na tela do lote (`components/reconciliation/RecipesPanel.tsx`, linhas novas selecionáveis para o escopo), nome da receita no painel da conciliação com IA e a lista das receitas ao importar no cadastro da conta e do cartão.
- Testes: `apps/server/test/reconcile-recipes.test.ts` (3 casos: cadastro e permissão; play com kit allow no escopo, linha fora do escopo recusada e 409; sequência de duas receitas ao importar) e os unitários do shared (variáveis da receita; contagem das tools de conciliação). Verificação: `pnpm verify:quick` (o lint acusou só o `tmp/` não versionado da raiz, fora desta tarefa; o Biome nos arquivos da tarefa passou) e os testes de integração afetados no Postgres local.
