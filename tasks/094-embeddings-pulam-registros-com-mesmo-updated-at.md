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

# O cursor da indexação de embeddings perde registros (empate de `updated_at` acima de 500 e COMMIT tardio)

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** paginação por carimbo de tempo com empate
- **Arquivos afetados:** `apps/server/src/agents/embeddings.ts:146-169`, `apps/server/src/agents/search.ts:52-59`, `apps/server/src/agents/search.ts:82-91`, `apps/server/src/agents/worker.ts:139,154`, `database/schema.sql:8670-8677`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Depois de restaurar um backup com milhares de entidades, ou de importar um extrato grande, só parte desses registros entra na busca por significado do agente. A busca nunca sai do modo "índice em construção", e o agente deixa de achar entidades que existem.

### Evidência e análise técnica
- `syncEmbeddingSources` (`embeddings.ts:146-169`) pagina cada tipo por `updated_at > since ORDER BY updated_at LIMIT 500` e guarda `since = max(updated_at)` do lote (`:165`). Na passada seguinte, o filtro é estritamente maior.
- `updated_at` é `now()`, o início da transação, tanto no DEFAULT quanto no trigger `set_updated_at` (`schema.sql:8674`). Uma importação de backup, um extrato de 1.000 linhas ou a geração das séries, todos numa transação, gravam milhares de linhas com o MESMO `updated_at`.
- O lote pega 500 delas, em ordem arbitrária dentro do empate, e a próxima passada usa `> T`. As outras ficam para trás. O mesmo acontece em escala menor: duas linhas com o mesmo carimbo na fronteira dos 500.
- Depois que o worker reinicia (`since` volta a `-infinity`), o empate é lido de novo com a mesma ordem do plano, em geral as mesmas 500. Entidades, que raramente são editadas, podem não entrar nunca. As linhas de extrato voltam quando são conciliadas, porque o `updated_at` muda.
- Há um segundo modo de perda, do mesmo cursor. `now()` é o início da transação, não o COMMIT. Uma importação que começa em T0 e confirma em T2 grava `updated_at = T0`. Se a sincronização rodou em T1 e avançou `since` para um carimbo maior que T0, essas linhas nunca são lidas.
- `indexComplete` (`search.ts:52-59`) exige `indexed >= embeddingSourceTotal`. Com registros faltando, isso nunca é verdade, e `semanticSearch` devolve sempre `building: true`, completando com trigramas (`search.ts:82-91`).

### Verificação (tentativa de refutação)
- O banco não marca as linhas de origem para indexar: só `ai_embeddings.needs_reindex`, quando o `source_text` muda. A única entrada de registros novos no índice é essa sincronização.
- Os testes (`agents.test.ts:713-719`, `capabilities.test.ts:478-485`) criam uma entidade por requisição e repetem `indexEmbeddings` até `sources === 0`. Esse critério também é satisfeito quando há registros pulados. Nenhum teste grava mais de 500 registros numa transação.
- `ON CONFLICT … DO UPDATE … WHERE distinto` não ajuda: o registro pulado nunca entra no `src`.

### Impacto
- Busca semântica incompleta depois de backup/restauração, de importações grandes (OFX/CSV com centenas de linhas, NF-e) e da geração das séries. Os resultados ficam piores sem aviso.
- O aviso "índice em construção" fica permanente, e cada busca faz os quatro `count(*)` de `embeddingSourceTotal` (`embeddings.ts:125-129`) à toa.

## Como reproduzir
1. Num banco com um par de embeddings ativo, insira 600 entidades numa transação (`INSERT … SELECT generate_series(1, 600)`).
2. Rode `indexEmbeddings` (ou a manutenção do worker) até `sources === 0 && embedded === 0`.
3. `SELECT count(*) FROM ai_embeddings WHERE object_type = 'entity' AND provider_id = …` mostra 500, não 600. `semantic_search` continua com `building: true`.

## Solução proposta
1. Paginar por chave composta `(updated_at, object_id)`: `WHERE (s.updated_at, s.object_id) > (${since}, ${sinceId}) ORDER BY s.updated_at, s.object_id LIMIT 500`, guardando o par do último registro do lote, não o `max`.
2. Alternativa mais simples: `updated_at >= since` e um conjunto dos ids já vistos no carimbo `since`, que é pequeno.
3. Para o COMMIT tardio: reler sempre uma janela de segurança (`since - interval '10 minutes'`). O `ON CONFLICT … WHERE distinto` já torna a releitura barata. Também resolve, com custo, o caso do empate.
4. Opcional: guardar o resultado de `indexComplete` por alguns minutos por par, para não contar as quatro tabelas a cada busca.
5. Relacionado (baixa): com mais de um worker, `embedPending` (`embeddings.ts:172-194`) lê os pendentes sem `SKIP LOCKED` nem trava consultiva, e dois workers podem calcular os mesmos vetores (custo dobrado, sem inconsistência por causa do `source_hash`). Um `pg_try_advisory_lock` por par na manutenção resolve.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/embeddings.ts
+++ b/apps/server/src/agents/embeddings.ts
@@
-export type IndexState = { since: Map<string, string> };
+export type IndexState = { since: Map<string, { at: string; id: string }> };
@@
-    const since = state.since.get(key) ?? '-infinity';
+    const since = state.since.get(key) ?? { at: '-infinity', id: '00000000-0000-0000-0000-000000000000' };
     const result = await db.execute<{ max: string | null; n: number }>(sql`
-      WITH src AS (SELECT * FROM (${source}) s WHERE s.updated_at > ${since}::timestamptz AND btrim(s.source_text) <> ''
-                    ORDER BY s.updated_at LIMIT ${batch}),
+      WITH src AS (SELECT * FROM (${source}) s
+                    WHERE (s.updated_at, s.object_id) > (${since.at}::timestamptz, ${since.id}::uuid) AND btrim(s.source_text) <> ''
+                    ORDER BY s.updated_at, s.object_id LIMIT ${batch}),
```
(e devolver o `updated_at` e o `object_id` do último registro de `src`.)

## Critérios de aceite
- [ ] 600 entidades gravadas numa transação ficam todas indexadas com `batch = 500`.
- [ ] Com `batch = 10` e 25 registros no mesmo carimbo, os 25 entram.
- [ ] Depois da indexação completa, `semantic_search` devolve `mode: 'embeddings'` sem `building`.

## Testes recomendados
`apps/server/test/capabilities.test.ts`: chamar `syncEmbeddingSources(h.db, pair, state, 10)` direto, depois de inserir 25 entidades numa só transação pelo `h.db`. Repetir até não haver novos e conferir que os 25 `object_id` estão em `ai_embeddings`.

## Limitações e suposições
Nada foi executado. A afirmação de que "as mesmas 500 voltam" depois de reiniciar depende do plano de execução. Mesmo que variem, o lote continua perdendo registros a cada passada.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `syncEmbeddingSources` paginava por `updated_at > since` com `since = max(updated_at)` do lote; `updated_at` é o início da transação, então empates acima do lote e COMMITs tardios ficavam de fora para sempre.

## Resolução (executor)

- `apps/server/src/agents/embeddings.ts`: paginação pela chave composta `(updated_at, object_id)`, com o cursor no último registro do lote (`IndexState.since` guarda `{ at, id }`). Quando a passada alcança o fim (lote incompleto), o cursor volta à janela de COMMIT tardio (`least(último carimbo, now() − 10 minutes)`): reler é barato, porque o upsert só grava o texto que mudou e não conta como fonte nova.
- Não feitos (opcionais da tarefa): cache do `indexComplete` e trava consultiva no `embedPending` com vários workers.
- Teste: `capabilities.test.ts` "o cursor da indexação não perde registros com o mesmo updated_at nem o COMMIT tardio": 25 entidades numa transação com lote de 10, e 3 entidades de uma transação confirmada depois de o cursor passar por outra gravada mais tarde.
- Verificação: `pnpm verify:quick` (rápida), com `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s2`.
