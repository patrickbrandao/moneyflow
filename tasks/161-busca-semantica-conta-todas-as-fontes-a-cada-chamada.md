---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# A busca semântica recalcula o tamanho de todas as fontes e do índice a cada chamada

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** embeddings (spec 024)
- **Arquivos afetados:** `apps/server/src/agents/search.ts:52-68`, `apps/server/src/agents/embeddings.ts:100-129`, `database/schema.sql:10817-10829` (`ai_embedding_index_stats`), `database/schema.sql:1145-1152` (`ai_embedding_indexes`)
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Cada vez que o agente usa a busca "por significado", o sistema conta de novo todas as entidades, títulos, compras e linhas de extrato do banco, só para saber se o índice já está completo. Com o crescimento dos dados, cada busca do agente fica mais lenta por um motivo que nada tem a ver com a busca.

### Evidência e análise técnica
- `semanticSearch` chama `indexComplete` antes de buscar (`search.ts:67`).
- `indexComplete` (`search.ts:53-59`) lê `ai_embedding_index_stats` do par, que conta todas as linhas de `ai_embeddings` do par (`schema.sql:10824-10829`), e depois chama `embeddingSourceTotal` (`embeddings.ts:125-129`).
- `embeddingSourceTotal` monta, para cada tipo, `SELECT count(*) FROM (<fonte>) s WHERE btrim(s.source_text) <> ''`. As fontes (`embeddings.ts:101-122`) fazem `titles JOIN entities JOIN categories`, `card_purchases JOIN entities JOIN categories` e `statement_lines LEFT JOIN financial_accounts`, e calculam o `concat_ws` de todos os registros só para filtrar o texto vazio.
- Resultado: quatro varreduras completas com junções, mais a contagem dos vetores do par, em toda chamada de `semantic_search`, antes mesmo do embedding da consulta.

### Verificação (tentativa de refutação)
- Sem o par de embeddings, a busca vai direto aos trigramas (`search.ts:93`), sem esse custo; o achado vale para o agente com a inferência de embeddings.
- O worker já sabe quando terminou uma passada sem nada novo (`syncEmbeddingSources` devolve 0 e `embedPending` não acha pendentes), mas não grava isso em lugar nenhum: `ai_embedding_indexes` só tem `last_in_use_at` (`schema.sql:1145-1152`).
- Não há teste de desempenho; os testes de `capabilities.test.ts` e `agents.test.ts` usam poucos registros.

### Impacto
Latência e carga crescentes em cada busca semântica, proporcionais ao total de títulos e linhas de extrato de todas as caixas, não às do usuário.

## Como reproduzir
1. Com algumas dezenas de milhares de linhas de extrato e um agente com embeddings, rode `EXPLAIN ANALYZE` da consulta de `embeddingSourceTotal`.
2. Compare o tempo da tool `semantic_search` com o de `ai_embeddings_search` sozinha.

## Solução proposta
1. dba: em `ai_embedding_indexes`, uma coluna `complete_at timestamptz` (o fim da última passada completa do worker sem fila), mais uma função `ai_embedding_index_mark(provedor, modelo, completo)` para o worker gravar. A visão `ai_embedding_index_stats` pode mostrar a coluna.
2. app: o worker marca o par ao fim de uma passada sem fontes novas nem pendentes; `indexComplete` passa a ler só `complete_at IS NOT NULL AND NOT EXISTS (… needs_reindex …)`, este último pelo índice parcial `ai_embeddings_reindex_idx`.
3. O total de fontes continua no detalhe do provedor (tela do admin), onde é usado com pouca frequência.
4. Troca a ser decidida: um registro criado depois da marcação fica fora da busca vetorial (e sem o aviso) até a próxima passada, no máximo um ciclo de `AGENT_MAINTENANCE_MS` (5 min). Se isso não for aceitável, compare `complete_at` com o `max(updated_at)` de cada fonte, o que pede índice em `updated_at` nas quatro tabelas (custo do dba).

## Critérios de aceite
- [ ] `semantic_search` não varre `titles`, `statement_lines`, `card_purchases` nem `entities` para decidir se o índice está completo.
- [ ] O aviso "índice em construção" continua aparecendo enquanto houver fila ou passada incompleta.

## Testes recomendados
- `apps/server/test/agents.test.ts` (embedding por par): antes da primeira passada completa, `building: true`; depois dela, `mode: 'embeddings'` sem `building`; depois de o worker sincronizar o texto de um título editado (linha em `needs_reindex`), `building: true` de novo.
- pgTAP em `database/tests/0041_ai_provider_capabilities.sql`: a função de marcação grava e limpa `complete_at`.

## Limitações e suposições
Nada foi executado nem medido. O custo exato depende do volume de cada instalação.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado:
- `ai_embedding_index_stats` conta todos os vetores do par (`count(e.id)` com `LEFT JOIN`).
- `ai_embedding_indexes` só tinha `last_in_use_at`, então não havia onde o worker gravar que terminou uma passada.
- `indexComplete` (`search.ts`) lê essa visão e ainda soma `embeddingSourceTotal`, a cada chamada.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0069_ai_embedding_index_complete.sql`; teste `database/tests/0069_ai_embedding_index_complete.sql`.

- Coluna nova `ai_embedding_indexes.complete_at timestamptz` (nula): o fim da última passada completa do worker no par.
- `ai_embedding_index_mark(p_provider_id uuid, p_model text, p_complete boolean) RETURNS boolean` (`SECURITY INVOKER`, `EXECUTE` para a aplicação):
  - com `true`, grava `complete_at = now()` só se o par não tiver vetor em `needs_reindex`; senão grava nulo;
  - com `false`, limpa;
  - devolve se o par ficou completo;
  - par não registrado dá `P0002`, e `p_complete` nulo dá `22023`.
- `ai_embedding_index_ready(p_provider_id uuid, p_model text) RETURNS boolean` (`STABLE`): verdadeiro com `complete_at` preenchido e nenhum vetor do par em `needs_reindex`. Usa o índice parcial `ai_embeddings_reindex_idx` e não conta as fontes. Par não registrado dá `false`.
- `ai_embedding_index_stats` ganhou `complete_at` no fim. As colunas de antes não mudam.
- Decisão: a troca do item 4 da tarefa foi aceita. Um registro criado depois da marcação fica fora da busca vetorial e do aviso até a próxima passada (um ciclo de manutenção). O texto editado de um registro já sincronizado tira o "pronto" na hora, porque vira `needs_reindex`.
- `tests/0041_ai_provider_capabilities.sql`: o `columns_are` de `ai_embedding_indexes` inclui a coluna nova.

Testes:
- nunca marcado e par não registrado: não está pronto;
- a marcação com a fila vazia grava `complete_at`;
- o texto editado tira o pronto, e marcar com fila não marca;
- o vetor recalculado permite marcar de novo;
- uma fonte nova na fila tira o pronto;
- `false` desmarca;
- os erros `P0002` e `22023`;
- o `ai_embedding_indexes_touch` não mexe na marca;
- a visão mostra a marca.

Verificação:
- `make test` com `0069`, `0041` e `0029` passou, com o down da 0069.
- `docs/016` (Embeddings) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`, para a coluna nova `ai_embedding_indexes.complete_at` e a coluna `complete_at` da visão.
2. `apps/server/src/agents/embeddings.ts` (`indexEmbeddings`):
   - marcar o par quando a passada alcançar o fim: em `syncEmbeddingSources`, todo tipo devolveu menos linhas que o `batch` (contar as linhas de `src`, e não só as `upserted`, que ficam em 0 quando nada mudou), e `embedPending` saiu sem pendentes;
   - nesse caso, `SELECT ai_embedding_index_mark(${providerId}, ${model}, true)`. Numa passada incompleta, ou com erro, `false`.
   - Na primeira passada de um processo (`state.since` vazio), o worker não sabe o que foi criado enquanto ele estava parado. Recomendo marcar `false` no início e só marcar `true` quando a recuperação alcançar o fim.
3. `apps/server/src/agents/search.ts`: `indexComplete` vira `SELECT ai_embedding_index_ready(${providerId}, ${model}) AS ready`, sem `ai_embedding_index_stats` nem `embeddingSourceTotal`. O total de fontes fica só no detalhe do provedor (tela do admin).
4. Testes em `apps/server/test/agents.test.ts` (embedding por par):
   - antes da primeira passada completa, `building: true`;
   - depois dela, `mode: 'embeddings'` sem `building`;
   - com um título editado e sincronizado (`needs_reindex`), `building: true` de novo.

### Aplicação (app)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `indexComplete` lia `ai_embedding_index_stats` e somava `embeddingSourceTotal` a cada `semantic_search`. Construído sobre o cursor da tarefa 094.

1. `pnpm db:pull`: o schema gerado da integração já tinha `complete_at` (tabela e visão).
2. `apps/server/src/agents/embeddings.ts`:
   - `syncEmbeddingSources` devolve `{ upserted, reachedEnd }`: `reachedEnd` quando todo tipo leu menos que o lote, contadas as linhas de `src` (o `read`), não só as gravadas;
   - `markEmbeddingIndex(db, par, completo)` chama `ai_embedding_index_mark`;
   - `indexEmbeddings`, por par: na primeira passada do processo (nenhum cursor do par em `IndexState`), desmarca antes de ler; ao fim, marca com `reachedEnd` (o banco grava nulo se sobrou vetor em `needs_reindex`, o que cobre o `embedPending` que não esvaziou a fila); com erro, desmarca. Aceita `sourceBatch` (só para o teste).
   - Decisão: seguir a recomendação de desmarcar no recomeço. Efeito: depois de reiniciar o worker, a busca avisa "em construção" até a releitura alcançar o fim (no ritmo de hoje, 500 por tipo a cada `AGENT_MAINTENANCE_MS`), o que é o estado real do índice nesse intervalo.
3. `apps/server/src/agents/search.ts`: `indexComplete` é só `SELECT ai_embedding_index_ready(provedor, modelo)`, sem a visão nem `embeddingSourceTotal`, que fica só no detalhe do provedor (`services/ai-requests.ts`).
4. Spec 024 (Embeddings): a marca do worker, o que desmarca e a troca aceita.

Testes (`test/capabilities.test.ts`, "embeddings por par", onde já estava o par registrado e não indexado com `building: true`): depois da passada completa, os dois pares com `complete_at`; o nome da entidade editado e sincronizado (sem calcular o vetor) volta a dar `building: true`, e a passada seguinte tira; o worker que reinicia (estado vazio, lote de 1) desmarca o par e a busca avisa até a indexação alcançar o fim, quando a marca volta. O `agents.test.ts` (embeddings) segue passando com a busca em `mode: 'embeddings'`.

Verificação: rápida, `pnpm verify:quick --base HEAD`.
