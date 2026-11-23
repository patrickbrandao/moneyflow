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

# Do lado espelho, excluir, arquivar e "Excluir este e os próximos" mexem no título e na série da outra caixa sem escrita nela

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** escrita na caixa do original sem `Access`
- **Arquivos afetados:** `apps/server/src/services/titles.ts:460-484`, `apps/server/src/services/titles.ts:616-650`, `apps/server/src/services/titles.ts:486-507`, `apps/server/src/services/titles.ts:429-452`, `apps/server/src/services/titles.ts:530-541` (contraste), `apps/server/src/services/titles.ts:413-427` (contraste), `apps/web/src/components/titles/TitleDrawer.tsx:92,525-534`, `docs/005-titulos-baixas-e-movimentos.md:16-17`
- **Depende de / relacionado a:** tarefa 072 (amplia o alcance); tarefa 081
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando a caixa A lança um título contra a empresa dona da caixa B, o espelho aparece em B "aguardando aceite". Hoje um editor só de B pode, pelo espelho, apagar o título de A, arquivá-lo (some das listas de A) ou apagar as próximas ocorrências da série de A. A spec diz que o editor de B aceita ou contesta, e que mexer na série pede escrita na caixa de A.

### Evidência e análise técnica
- `deleteTitle` (`titles.ts:460-484`) confere `assertWrite(title.caixaId)` só na caixa do título pedido e opera sobre o par: `DELETE ... WHERE id IN (espelho, original)` ou arquiva os dois.
- Com `scope = 'following'` numa ocorrência espelho (`titles.ts:466-469`), `endSeriesFrom` (`titles.ts:616-650`) apaga as ocorrências `>= n` da série inteira (as duas caixas), muda `ends_on`/`installments_total` da regra, que é da caixa do original, ou transforma o resto em título avulso. Também não pega o advisory lock da série (`MATERIALIZE_LOCK`), que `seriesEndPlanOf` pega (`titles.ts:531-534`).
- `archiveTitle` (só pela tool `archive_title`, `tool-handlers-operation.ts:1083`), `restoreTitle` (`POST /api/titles/:id/restore`) e `cancelTitle`/`reopenTitle` (`titles.ts:429-452`, `486-507`) fazem o mesmo com o par. Pela tela, "Excluir" numa ocorrência de série ("só esta") também arquiva o par (`titles.ts:471`).
- O próprio código mostra a regra pretendida: `seriesEndPlanOf` exige `assertWrite(rule.caixaId)` ("A série é do lado original", `titles.ts:525-541`) e `syncMirror` recusa mudar valor e vencimento pelo espelho sem escrita no original (`titles.ts:420-421`, mensagem `mirrorEditOriginal`).
- A tela oferece "Excluir" e "Excluir este e os próximos" a quem escreve na caixa do espelho (`TitleDrawer.tsx:525-534`) e mostra "Encerrar série…" (`TitleDrawer.tsx:92`), que o servidor recusa com 404 para quem não lê a caixa do original.
- As tools `delete_title` e `cancel_title` (`tool-handlers-operation.ts:1068,1108`) chamam os mesmos serviços.

### Verificação (tentativa de refutação)
- Banco: `titles_mirror_check` só exige o par recíproco; apagar os dois lados juntos passa. Não há RLS.
- Spec 005:16 ("encerrar pede escrita na caixa do título original (a série é dele)") e 006:5 ("um editor de lá aceita … ou contesta"). Nenhuma das duas autoriza o lado espelho a excluir o original.
- Parte é desenho: o cancelamento do par é anunciado na tela ("O espelho na outra caixa também é cancelado", `TitleDrawer.tsx:97`) e a baixa e o estorno das duas pernas são obrigatórios no banco (`settlements_mirror_check`). Por isso o cancelamento fica para a triagem decidir; a exclusão física, o arquivamento e a mudança na série não têm essa justificativa.
- Testes: nenhum caso em `titles.test.ts` ou `permissions.test.ts` exclui ou arquiva pelo lado espelho.

### Impacto
Um devedor (editor só de B) apaga ou esconde a conta a receber do credor (A) e encerra a série dele, sem permissão em A. Só o `audit_log` guarda o que havia. Combinado com a caixa principal tomada (achado relacionado), vale para qualquer titular.

## Como reproduzir
1. `scenario`: editor U só da `caixaB`; admin lança em `caixaA` um título a pagar mensal para `holderB` (espelho em `caixaB`, pendente se o autor não escreve lá).
2. U: `DELETE /api/titles/<espelho da 3ª ocorrência>?scope=following` → 200; as ocorrências 3–13 somem também em `caixaA` e a regra ganha `ends_on`.
3. U: `DELETE /api/titles/<espelho avulso>` → o título de `caixaA` é apagado.

## Solução proposta
1. Em `deleteTitle`, `archiveTitle`, `restoreTitle` e `endSeriesFrom`: quando o título é o lado espelho (`mirrorStatus !== null`), exigir `canWrite` na caixa do original (ou na `rule.caixaId`, como `seriesEndPlanOf`); sem ela, 403 com mensagem orientando a contestar.
2. Decidir na triagem se `cancelTitle`/`reopenTitle` pelo espelho seguem a mesma regra.
3. `endSeriesFrom`: pegar `pg_advisory_xact_lock(MATERIALIZE_LOCK, hashtext(ruleId))` antes de ler a regra, como `seriesEndPlanOf` e `loadRule(…, true)`.
4. Tela: esconder "Excluir este e os próximos" e "Encerrar série…" no espelho quando `title.mirror?.canWrite` é falso.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/titles.ts
+++ b/apps/server/src/services/titles.ts
@@ export async function deleteTitle(
   const title = await loadTitle(ctx.db, id);
   ctx.access.assertWrite(title.caixaId);
+  // O par é do lado original: pelo espelho, só com escrita lá também (spec 005/006).
+  if (title.mirrorStatus !== null && title.counterpartyCaixaId && !ctx.access.canWrite(title.counterpartyCaixaId))
+    throw forbidden(strings.errors.mirrorEditOriginal);
@@ async function endSeriesFrom(tx: Tx, ruleId: string, occurrence: number, dueDate: string) {
+  await tx.execute(sql`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${ruleId}))`);
   const [rule] = await tx.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId)).for('update');
```

## Critérios de aceite
- [ ] Editor só da caixa do espelho recebe 403 ao excluir, arquivar ou "excluir este e os próximos" pelo espelho; nada muda na caixa do original.
- [ ] Quem escreve nas duas caixas continua podendo.
- [ ] A tela não oferece as ações que o servidor recusaria.

## Testes recomendados
`test/titles.test.ts`, no `describe('espelhamento (spec 006)')`: autor editor só de `caixaA`, outro editor só de `caixaB`; o de B tenta `DELETE /api/titles/<espelho>` (avulso), `DELETE …?scope=this` e `?scope=following` (série), esperando 403 e o original intacto. Em `test/agent-tools-admin.test.ts` ou `agent-tools.test.ts`, o mesmo pela tool `archive_title`.

## Limitações e suposições
Nada foi executado. A decisão sobre o cancelamento pelo espelho depende do produto.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `deleteTitle`, `archiveTitle`, `restoreTitle`, `cancelTitle` e `reopenTitle` conferiam só a escrita na caixa do título pedido e operavam no par; `endSeriesFrom` não pegava a trava da série.

## Resolução (executor)

- `apps/server/src/services/titles.ts`: `assertPairOwner` — pelo lado espelho (`mirrorStatus` não nulo), excluir (avulso, "só esta" e "este e os próximos"), arquivar, restaurar, cancelar e reabrir exigem escrita também na caixa do original (`counterpartyCaixaId` do espelho); sem ela, 403 com `t.errors.mirrorPairOriginal`, que orienta a contestar. `endSeriesFrom` pega `pg_advisory_xact_lock(MATERIALIZE_LOCK, hashtext(regra))` antes de ler a regra.
- Decisão (item 2): o cancelamento e a reabertura pelo espelho seguem a mesma regra, porque cancelam o título do original; o editor só do espelho aceita, contesta, baixa e edita categoria, descrição e observações do lado dele.
- `apps/web/src/components/titles/TitleDrawer.tsx`: `ownsPair` esconde Cancelar/Reabrir, Excluir, "Este e os próximos", "Editar série" e "Encerrar série…" no espelho de quem não edita o original.
- `packages/shared/src/i18n/pt-BR.ts`: `errors.mirrorPairOriginal`. `docs/006-espelhamento-entre-caixas.md`: a regra.
- Testes: `apps/server/test/titles.test.ts`, "pelo espelho, só quem edita também o original exclui, arquiva, cancela ou encerra a série (tarefa 079)" (avulso e série, 403 e o original intacto; o admin continua podendo); `apps/server/test/agent-tools.test.ts`, no caso "cancelar, arquivar, excluir…", a tool `archive_title` pelo editor só da caixa B.
- Verificação: `pnpm verify:quick` (nível rápido).

### Complemento (revisão de 2026-11-22, frente P2a)

- As prévias de `cancel_title`, `archive_title` e `delete_title` (`assertPairOwnerPreview` em `apps/server/src/agents/tool-handlers-operation.ts`) recusam pelo lado espelho sem escrita na caixa do original, com o mesmo 403 `t.errors.mirrorPairOriginal` do serviço, antes do cartão.
- Teste: `apps/server/test/agent-tools.test.ts`, "as prévias recusam antes do cartão…" (as três tools pelo editor só da caixa B, sem prévia, e o original intacto). Verificação: `pnpm verify:quick`.
