---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
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

## Resolução (executor)
