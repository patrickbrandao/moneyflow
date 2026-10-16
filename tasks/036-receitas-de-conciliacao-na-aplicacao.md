---
status: aberta
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
