---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-21
commit: 6d9ded8
---

# Editor de qualquer caixa toma a caixa principal de outra entidade e passa a receber os espelhos dela

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** escalada entre caixas pela caixa principal do titular
- **Arquivos afetados:** `apps/server/src/services/caixas.ts:97-134`, `apps/server/src/services/caixas.ts:142-159`, `apps/server/src/authz/access.ts:63-70`, `apps/server/src/services/titles.ts:244-253`, `apps/server/src/services/entities.ts:120,155-161`, `apps/web/src/components/titles/MirrorFields.tsx:37-43`, `apps/server/src/agents/tool-handlers-operation.ts:910,924`
- **Depende de / relacionado a:** tarefa 079 (o que o lado espelho consegue fazer no original)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Um usuário que edita uma caixa qualquer consegue criar outra caixa em nome de uma empresa que não é dele e marcá-la como "principal". A partir daí, os títulos que os outros lançam contra essa empresa passam a ter o espelho criado na caixa dele, pré-selecionada na tela. Ele vê descrição, valor, vencimento e contrato desses títulos e, pelo espelho, consegue marcar o título do outro como pago ou cancelá-lo.

### Evidência e análise técnica
- `createCaixa` (`caixas.ts:97-134`) só exige `assertRegistryWrite()`, que vale para qualquer editor de alguma caixa (`access.ts:63-70`). O titular pode ser qualquer entidade ativa (`assertHolder`, `caixas.ts:91-95`).
- Com `isPrimary: true`, a linha `caixas.ts:104-106` faz `UPDATE caixas SET is_primary = false WHERE holder_entity_id = <titular>` em todas as caixas do titular, inclusive as que o usuário nem lê, e a nova caixa vira a principal. `updateCaixa` faz o mesmo (`caixas.ts:154-159`) para quem edita uma caixa vazia e troca o titular dela (`caixas.ts:148-153` só barra a troca com títulos ligados).
- `resolveMirror` sem `mirrorCaixaId` usa a principal do titular (`titles.ts:244-253`); o formulário pré-seleciona a principal da lista de `GET /api/entities/:id`, que traz todas as caixas do titular, visíveis ou não (`entities.ts:120,155-161`; `MirrorFields.tsx:41-42`). As tools `create_title`, `create_series` e o "lançar como título" da conciliação também caem no padrão.
- O espelho nasce `pending` na caixa nova e aparece para o editor dela em "Aguardando aceite" e no `overview.pendingMirrors`. Pelo espelho ele baixa (a perna do original vira "baixado, conta a definir", `settlements.ts:128-138`) e cancela (`titles.ts:430-438`) o título de quem lançou.

### Verificação (tentativa de refutação)
- Banco: `caixas_holder_primary_key` (`schema.sql:17948`) só garante uma principal por titular; nada impede trocar qual é. `caixas_validate` não olha `is_primary`.
- Spec: 002 não diz quem cria caixas; 006 diz que a principal "vem pré-selecionada". Nada autoriza um usuário a mudar a principal de caixas que ele não edita.
- Testes: `permissions.test.ts` e `titles.test.ts` não cobrem criar caixa para titular alheio nem trocar a principal.
- A auditoria de 2026-11-07 leu `caixas.ts` só pelo lado de acesso direto; o efeito via espelho não foi registrado (tarefas 048–069).

### Impacto
Vazamento de títulos de outras caixas e manipulação do status deles por um editor mal-intencionado (ou por engano de quem marca "principal" sem saber que tira a de outra caixa). Afeta toda instalação com mais de um grupo de usuários (escritório com clientes, por exemplo).

## Como reproduzir
1. Usuário U, editor só da caixa X. Entidade E é titular da caixa principal P (U não lê P).
2. U: `POST /api/caixas { name: "E", holderEntityId: E, isPrimary: true }`.
3. Admin ou editor de outra caixa: `POST /api/titles { caixaId: A, direction: "receivable", entityId: E, ... }` sem `mirrorCaixaId`.
4. O espelho nasce na caixa de U; `GET /api/caixas/P` mostra `isPrimary: false`. U faz `POST /api/titles/<espelho>/settlements { financialAccountId: null, ... }` e o título de A fica `paid`.

## Solução proposta
1. Em `createCaixa` e `updateCaixa`, quando o pedido marca a principal: se o titular já tem uma principal que o ator não edita, recusar (403, mensagem em `t.errors`), salvo admin.
2. Avaliar com o usuário se criar caixa para um titular que já tem caixas alheias deve ser só do admin.
3. Opcional: no formulário, mostrar com destaque quando a caixa pré-selecionada não é visível ao autor.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/caixas.ts
+++ b/apps/server/src/services/caixas.ts
@@
+async function assertCanTakePrimary(ctx: ServiceContext, tx: Executor, holderEntityId: string, exceptId?: string) {
+  if (ctx.access.isAdmin) return;
+  const rows = await tx.execute<{ id: string }>(sql`
+    SELECT id FROM caixas WHERE holder_entity_id = ${holderEntityId} AND is_primary
+       ${exceptId ? sql`AND id <> ${exceptId}` : sql``}`);
+  const current = rows.rows[0]?.id;
+  if (current && !ctx.access.canWrite(current)) throw forbidden(t.errors.primaryOfOtherCaixa);
+}
@@ createCaixa
-    if (input.isPrimary && !isCard) {
+    if (input.isPrimary && !isCard) {
+      await assertCanTakePrimary(ctx, tx, input.holderEntityId);
       await tx.update(caixas).set({ isPrimary: false }).where(eq(caixas.holderEntityId, input.holderEntityId));
@@ updateCaixa
     if (input.isPrimary) {
+      await assertCanTakePrimary(ctx, tx, holder, id);
```

## Critérios de aceite
- [ ] Usuário não admin não consegue tirar a principal de uma caixa que não edita (criando ou editando caixa).
- [ ] Admin continua trocando a principal de qualquer titular.
- [ ] Mensagem pt-BR vinda de `t`.

## Testes recomendados
`test/permissions.test.ts`: editor só da caixa X tenta `POST /api/caixas` com `holderEntityId` = titular da `caixaB` do `scenario` e `isPrimary: true` (403; `caixaB` continua principal); o mesmo por `PATCH /api/caixas/:id` numa caixa vazia dele; admin consegue.

## Limitações e suposições
Nada foi executado. Supõe que a instalação tem usuários que não devem ver as caixas uns dos outros (o modelo de permissão por caixa da spec 002).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado no código: `createCaixa` e `updateCaixa` faziam `UPDATE caixas SET is_primary = false` em todas as caixas do titular para quem só passava em `assertRegistryWrite()`/`assertWrite(id)`, e o `resolveMirror` usa a principal como caixa padrão do espelho. O teste novo falha sem a correção (`POST /api/caixas` devolvia 200 com `isPrimary: true`).

## Resolução (executor)

- `apps/server/src/services/caixas.ts`: `assertCanTakePrimary` — sem ser admin, marcar uma caixa como principal (no `createCaixa` e no `updateCaixa`, inclusive trocando o titular de uma caixa vazia) exige escrita na principal atual do titular; sem ela, 403 com `t.errors.primaryOfOtherCaixa`. O admin continua trocando a principal de qualquer titular. De passagem, o `PATCH` de um cartão com `isPrimary: true` não tira mais a principal do titular (o cartão nunca é principal).
- `packages/shared/src/i18n/pt-BR.ts`: `errors.primaryOfOtherCaixa`.
- `docs/004-caixas-e-contas.md`: a regra da troca da principal.
- Decisão: segui a solução 1 da tarefa. O item 2 (criar caixa para um titular que ainda não tem principal, ou que só tem caixas de outros, continua aberto a qualquer editor de alguma caixa) fica como decisão de produto: a caixa nova vira a principal desse titular e passa a receber os espelhos dos títulos lançados contra ele dali em diante. O destaque opcional no formulário (item 3) não foi feito.
- Teste: `apps/server/test/permissions.test.ts`, "só quem edita a caixa principal do titular a troca; o admin troca qualquer uma (tarefa 072)" (POST e PATCH recusados, a caixa B continua principal e recebendo o espelho; quem edita a principal atual troca; o admin troca).
- Verificação: `pnpm verify:quick` (nível rápido).
