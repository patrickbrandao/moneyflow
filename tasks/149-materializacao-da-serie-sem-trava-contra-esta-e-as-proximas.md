---
status: em-andamento
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# A materialização da série corre sem trava contra "excluir este e os próximos" e "esta e as próximas" do título

- **Severidade:** baixa
- **Confiança:** provável (a corrida vem da ordem das travas; não foi reproduzida)
- **Categoria:** ponto fraco
- **Subcategoria:** condição de corrida entre o worker e a edição da série
- **Arquivos afetados:** `database/schema.sql:9820-9826` (`titles_validate`, ocorrência ≤ N), `database/schema.sql:8283-8296` (`recurrence_rules_validate`), `database/schema.sql:5043` (`card_purchases_validate_occurrence`, para comparar), `apps/server/src/services/titles.ts:375-403,616-650`, `apps/server/src/services/recurrence.ts:41-52,110-120`, `apps/server/src/services/series.ts:59-60`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se o worker cria a próxima parcela de uma série no mesmo instante em que o usuário edita "esta e as próximas" ou exclui "este e os próximos", a parcela nova pode sair com os dados antigos. Num parcelamento, pode até ficar com o número acima do total de parcelas, coisa que o banco promete impedir.

### Evidência e análise técnica
O worker materializa cada série sob `pg_try_advisory_xact_lock(MATERIALIZE_LOCK, hashtext(série))` (`recurrence.ts:114`) e lê o modelo (a ocorrência mais recente) e a regra sem trava de linha (`recurrence.ts:41-52`). Os caminhos de série de `series.ts` (`loadRule`, `:59-60`) e `seriesEndPlanOf` (`titles.ts:533`) pegam a mesma trava consultiva. Dois caminhos de `titles.ts` não pegam:

1. `updateTitle` com `scope = 'following'` (`titles.ts:375-403`) reescreve as ocorrências futuras em aberto (`SELECT ... FOR UPDATE`). Se o worker já leu o modelo antigo, ele insere a ocorrência N+1 com o valor, a descrição, a categoria e a conta prevista de antes. O `FOR UPDATE` do `updateTitle` não pega uma linha que ainda não existe. Resultado: a série fica com a ocorrência nova fora do que o usuário acabou de mudar.
2. `endSeriesFrom` (`titles.ts:616-650`, "excluir este e os próximos") trava a regra com `FOR UPDATE` e reduz `installments_total`. No banco, `titles_validate` (`schema.sql:9820-9826`) lê `installments_total` da regra sem trava. `recurrence_rules_validate` (`schema.sql:8283-8296`) procura títulos com ocorrência acima do novo total, também sem trava. O worker passa por `titles_validate` com o total antigo antes de chegar à checagem da FK; a FK (`FOR KEY SHARE`) espera o `FOR UPDATE` de `endSeriesFrom`, que confirma sem ver o título ainda não confirmado; depois o worker confirma. Fica um título com `occurrence > installments_total`, que a `docs/016` (seção *Recorrência*) diz que nunca acontece (`titles_occurrence_total_check`).

Para as compras ligadas a uma série, o banco já trava a regra antes de conferir (`card_purchases_validate_occurrence`, `SELECT ... FOR NO KEY UPDATE`, `schema.sql:5043`). Para os títulos, não.

### Verificação (tentativa de refutação)
- O worker roda de hora em hora (`WORKER_INTERVAL_MS`, `config.ts:108`) e só cria uma ocorrência quando ela entra no horizonte de 12 meses. A janela é pequena, mas existe. O mesmo vale para o `materializeRule` chamado pela API em `applySeriesEnd` e na criação, que já roda sob a trava.
- `recurrence_rule_assert` (deferido) não confere ocorrência × total.
- Nenhum teste exercita o worker em paralelo com a edição.

### Impacto
Raro. Uma parcela nova com dados antigos aparece em silêncio. O pior caso é uma parcela "13 de 12", que quebra a numeração e o "n de N" na tela e nos relatórios. Para corrigir é preciso excluir à mão.

## Como reproduzir
Duas sessões: S1 faz `BEGIN; SELECT pg_advisory_xact_lock(7310001, hashtext('<série>'));` e insere a ocorrência N+1 como o worker. Ainda sem COMMIT, S2 faz o `UPDATE recurrence_rules SET installments_total = N` de `endSeriesFrom` e confirma. Depois S1 confirma. A ocorrência N+1 fica com N parcelas no total.

## Solução proposta
1. (dba) Em `titles_validate`, ler a regra com `FOR SHARE`, como já se faz nas compras. Se a redução do total chegou primeiro (`FOR UPDATE` em `endSeriesFrom`), a inserção espera e relê o total novo. Se a inserção chegou primeiro, a redução espera, e `recurrence_rules_validate` (ou o `SELECT` dos títulos a excluir) enxerga o título já confirmado.
2. (app) Pegar `pg_advisory_xact_lock(MATERIALIZE_LOCK, hashtext(série))` no começo de `updateTitle` com `scope = 'following'` e de `endSeriesFrom`, antes de ler as ocorrências. O worker então pula a série naquela volta (`pg_try_advisory_xact_lock`) e a materializa na próxima, a partir do modelo novo.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/titles.ts
+++ b/apps/server/src/services/titles.ts
@@ async function endSeriesFrom(tx: Tx, ruleId: string, occurrence: number, dueDate: string) {
+  await tx.execute(sql`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${ruleId}))`);
   const [rule] = await tx.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId)).for('update');
```

## Critérios de aceite
- [ ] Com o roteiro de "Como reproduzir", S2 espera S1 e depois falha com `titles_occurrence_total_check`.
- [ ] `updateTitle` com "esta e as próximas" e `endSeriesFrom` pegam a trava da série.

## Testes recomendados
- `database/tests/0007_recurrence_rules.sql`: os casos de ocorrência acima do total continuam passando. O pgTAP roda numa sessão só, então a concorrência fica para a integração.
- `apps/server/test/titles.test.ts` (`describe('séries ...')`): `materializeAll` em paralelo com `updateTitle(scope: 'following')`, e a ocorrência nova com o valor novo.

## Limitações e suposições
Nada foi executado. A reprodução por duas sessões depende da ordem descrita (o `BEFORE` de `titles_validate` antes da checagem da FK), que é a ordem padrão do PostgreSQL.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: `titles_validate` lia `installments_total` da regra sem trava (a FK só toma `FOR KEY SHARE`, que não conflita com o `UPDATE` da série). Já `card_purchases_validate_occurrence` trava a regra com `FOR NO KEY UPDATE`. Do lado da aplicação, `updateTitle` (scope `following`) e `endSeriesFrom` não tomam a trava consultiva `MATERIALIZE_LOCK` da série, que o worker e os outros caminhos de série tomam.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0061_recurrence_occurrence_lock.sql`; teste `database/tests/0061_recurrence_occurrence_lock.sql`.

- `titles_validate` lê o total da regra com `FOR SHARE` no INSERT e quando a ocorrência muda de série ou de número. A edição comum da ocorrência continua sem trava.
  - Se a redução de N chega primeiro (`FOR UPDATE` ou `UPDATE` da série), a inserção espera e relê o total novo.
  - Se a inserção chega primeiro, a redução espera o COMMIT dela, e `recurrence_rules_validate` enxerga a ocorrência confirmada.
- pgTAP, por `pgrowlocks` (só na transação do teste):
  - A ocorrência nova deixa a regra com `For Share`. A função antiga deixava só o `For Key Share` da FK, o que foi conferido rodando a função antiga na mesma fixture.
  - Ocorrência acima do total e redução abaixo de uma ocorrência continuam recusadas.
  - Editar a ocorrência e aumentar o total continuam livres.
- Conferido à mão com duas sessões em `moneyflow_test`, numa série 1..11 de 12:
  - Com o worker inserindo a 12 aberto e o "excluir este e os próximos" (`FOR UPDATE` + `installments_total = 11`) em paralelo, a redução esperou e falhou com `titles_occurrence_total_check`. Quando o worker desfez, a redução passou.
  - Na ordem inversa, a inserção da 12 esperou e falhou com `titles_occurrence_total_check`.
  - No fim ficou N = 11 e a maior ocorrência = 11.
- `docs/016` (Recorrência) atualizada. Os pgTAP `0007`, `0008` e `0052` passam. `make dump` rodado.

### Pendente na aplicação

1. `apps/server/src/services/titles.ts`:
   - Em `updateTitle` com `scope = 'following'` (`:375-403`), antes de ler as ocorrências seguintes: `await tx.execute(sql\`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${ruleId}))\`)`.
   - Em `endSeriesFrom` (`:616-650`), a mesma chamada antes do `SELECT … FOR UPDATE` da regra, como no diff da tarefa.
   - Com isso, o worker (`pg_try_advisory_xact_lock`) pula a série naquela volta e a materializa na próxima, já a partir do modelo novo. A trava do banco só garante o "n de N": sem a trava consultiva, a ocorrência nova ainda pode sair com o valor, a descrição ou a conta prevista de antes.
2. Teste em `apps/server/test/titles.test.ts` (`describe('séries …')`): `materializeAll` em paralelo com `updateTitle(scope: 'following')`; a ocorrência nova tem de sair com o valor novo.
