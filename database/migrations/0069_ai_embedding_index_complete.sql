-- migrate:up

-- Tarefa 161: para saber se o índice de embeddings do par está completo, a busca semântica contava a cada chamada todas
-- as fontes (títulos, compras, linhas de extrato, entidades, com as junções) e os vetores do par. Agora o worker marca o
-- par ao fim de uma passada completa (ai_embedding_index_mark) e a busca pergunta só ai_embedding_index_ready: marcado e
-- sem nenhum vetor na fila (needs_reindex, pelo índice parcial ai_embeddings_reindex_idx). A troca aceita: um registro
-- criado depois da marcação fica fora da busca vetorial até a próxima passada do worker (um ciclo de manutenção).

ALTER TABLE ai_embedding_indexes ADD COLUMN complete_at timestamptz;

COMMENT ON COLUMN ai_embedding_indexes.complete_at IS
  'Fim da última passada completa do worker no par (nenhuma fonte nova a sincronizar e nenhum vetor na fila), gravado '
  'por ai_embedding_index_mark; nulo = ainda não completo, ou marcado incompleto. O índice está pronto para a busca com '
  'complete_at preenchido e nenhum vetor em needs_reindex (ai_embedding_index_ready; tarefa 161).';

CREATE FUNCTION ai_embedding_index_mark(p_provider_id uuid, p_model text, p_complete boolean)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  done boolean;
BEGIN
  IF p_complete IS NULL THEN
    RAISE EXCEPTION 'ai_embedding_index_mark: complete must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE ai_embedding_indexes x
     SET complete_at = CASE
                         WHEN p_complete AND NOT EXISTS (SELECT 1 FROM ai_embeddings e
                                                          WHERE e.provider_id = x.provider_id AND e.model = x.model
                                                            AND e.needs_reindex)
                         THEN now()
                       END
   WHERE x.provider_id = p_provider_id AND x.model = p_model
  RETURNING x.complete_at IS NOT NULL INTO done;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_embedding_index_mark: pair %/% is not registered', p_provider_id, p_model
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN done;
END
$$;

COMMENT ON FUNCTION ai_embedding_index_mark(uuid, text, boolean) IS
  'Worker (tarefa 161): com p_complete = true, ao fim de uma passada sem fontes novas nem vetores pendentes, grava '
  'complete_at = agora, desde que o par não tenha vetor em needs_reindex (senão grava nulo); com false, limpa. Devolve '
  'se o par ficou completo. P0002 se o par não está em ai_embedding_indexes; 22023 com p_complete nulo.';

CREATE FUNCTION ai_embedding_index_ready(p_provider_id uuid, p_model text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM ai_embedding_indexes x
                  WHERE x.provider_id = p_provider_id AND x.model = p_model AND x.complete_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM ai_embeddings e
                      WHERE e.provider_id = p_provider_id AND e.model = p_model AND e.needs_reindex)
$$;

COMMENT ON FUNCTION ai_embedding_index_ready(uuid, text) IS
  'Busca semântica (tarefa 161): true se o par foi marcado completo (complete_at) e não tem vetor na fila '
  '(needs_reindex, pelo índice parcial ai_embeddings_reindex_idx). Não conta as fontes: um registro criado depois da '
  'marcação fica fora até a próxima passada do worker. Par não registrado = false.';

CREATE OR REPLACE VIEW ai_embedding_index_stats WITH (security_invoker = true) AS
 SELECT x.provider_id,
    x.model,
    x.last_in_use_at,
    (EXISTS ( SELECT 1
           FROM ai_embedding_pairs_in_use u
          WHERE ((u.provider_id = x.provider_id) AND (u.model = x.model)))) AS in_use,
    (count(e.id))::integer AS vectors,
    (count(e.id) FILTER (WHERE (NOT e.needs_reindex)))::integer AS indexed,
    (count(e.id) FILTER (WHERE e.needs_reindex))::integer AS pending,
    x.complete_at
   FROM (ai_embedding_indexes x
     LEFT JOIN ai_embeddings e ON (((e.provider_id = x.provider_id) AND (e.model = x.model))))
  GROUP BY x.provider_id, x.model, x.last_in_use_at, x.complete_at;

COMMENT ON VIEW ai_embedding_index_stats IS
  'Progresso de cada índice (detalhe do provedor): linhas (vectors), já indexadas com o texto atual (indexed) e na fila '
  '(pending), se o par está em uso e o fim da última passada completa do worker (complete_at).';

-- migrate:down

DROP VIEW ai_embedding_index_stats;
CREATE VIEW ai_embedding_index_stats WITH (security_invoker = true) AS
 SELECT x.provider_id,
    x.model,
    x.last_in_use_at,
    (EXISTS ( SELECT 1
           FROM ai_embedding_pairs_in_use u
          WHERE ((u.provider_id = x.provider_id) AND (u.model = x.model)))) AS in_use,
    (count(e.id))::integer AS vectors,
    (count(e.id) FILTER (WHERE (NOT e.needs_reindex)))::integer AS indexed,
    (count(e.id) FILTER (WHERE e.needs_reindex))::integer AS pending
   FROM (ai_embedding_indexes x
     LEFT JOIN ai_embeddings e ON (((e.provider_id = x.provider_id) AND (e.model = x.model))))
  GROUP BY x.provider_id, x.model, x.last_in_use_at;

COMMENT ON VIEW ai_embedding_index_stats IS
  'Progresso de cada índice (detalhe do provedor): linhas (vectors), já indexadas com o texto atual (indexed) e na fila '
  '(pending), mais se o par está em uso.';

DROP FUNCTION ai_embedding_index_ready(uuid, text);
DROP FUNCTION ai_embedding_index_mark(uuid, text, boolean);
ALTER TABLE ai_embedding_indexes DROP COLUMN complete_at;
