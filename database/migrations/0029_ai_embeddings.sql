-- migrate:up

-- Agentes de IA (spec 011), parte 6: embeddings (pgvector) para a busca semântica dos agentes.
--
-- Dimensão FIXA de 1536: o modelo padrão é o text-embedding-3-small da OpenAI (ou um compatível de 1536
-- dimensões), configurado em ai_providers.embedding_model (no máximo um provedor ativo). Sem provedor de
-- embeddings, a busca dos agentes cai para trigram (índices pg_trgm já existentes nos nomes/descrições).
--
-- A aplicação grava (objeto, modelo, texto-fonte); o banco calcula o hash do texto. needs_reindex fica true
-- quando o vetor falta ou foi calculado de outro texto (embedded_hash <> source_hash); o worker recalcula.

-- convert_to é STABLE (depende da codificação do banco, que é fixa: UTF8); o invólucro IMMUTABLE permite usá-lo
-- em coluna gerada.
CREATE FUNCTION ai_text_sha256(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$;

COMMENT ON FUNCTION ai_text_sha256(text) IS 'SHA-256 (hex minúsculo) do texto em UTF-8. Igual ao sha256 de Node sobre a string.';

CREATE TABLE ai_embeddings (
  id            uuid         PRIMARY KEY DEFAULT uuidv7(),
  object_type   text         NOT NULL,
  object_id     uuid         NOT NULL,
  caixa_id      uuid         REFERENCES caixas (id) ON DELETE CASCADE,
  model         text         NOT NULL,
  source_text   text         NOT NULL,
  source_hash   text         NOT NULL GENERATED ALWAYS AS (ai_text_sha256(source_text)) STORED,
  embedding     vector(1536),
  embedded_hash text,
  embedded_at   timestamptz,
  needs_reindex boolean      NOT NULL GENERATED ALWAYS AS (
                  embedding IS NULL OR embedded_hash IS DISTINCT FROM ai_text_sha256(source_text)) STORED,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ai_embeddings_object_key UNIQUE (object_type, object_id, model),
  CONSTRAINT ai_embeddings_object_type_check CHECK (object_type IN (
    'entity', 'caixa', 'financial_account', 'category', 'title', 'card_purchase', 'statement_line', 'nfe_document',
    'attachment', 'classification_rule')),
  CONSTRAINT ai_embeddings_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_embeddings_source_text_check CHECK (btrim(source_text) <> '' AND length(source_text) <= 32000),
  CONSTRAINT ai_embeddings_embedded_check CHECK (
    (embedding IS NULL) = (embedded_hash IS NULL) AND (embedding IS NULL) = (embedded_at IS NULL)
  ),
  CONSTRAINT ai_embeddings_embedded_hash_check CHECK (embedded_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX ai_embeddings_embedding_idx ON ai_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ai_embeddings_reindex_idx ON ai_embeddings (model, updated_at) WHERE needs_reindex;
CREATE INDEX ai_embeddings_caixa_id_idx ON ai_embeddings (caixa_id);
CREATE INDEX ai_embeddings_object_idx ON ai_embeddings (object_type, object_id);

CREATE TRIGGER ai_embeddings_set_updated_at BEFORE UPDATE ON ai_embeddings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_embeddings IS
  'Embeddings dos registros para a busca semântica dos agentes (vector(1536), HNSW por cosseno). Um por objeto e modelo. '
  'Sem FK para o objeto (polimórfico): ai_embeddings_purge_orphans limpa os de objetos excluídos. Derivado: fora da '
  'auditoria. A busca SEMPRE filtra pelas caixas que o usuário lê (caixa_id) e a aplicação revalida o objeto.';
COMMENT ON COLUMN ai_embeddings.object_type IS
  'Tipo do objeto: entity, caixa, financial_account, category, title, card_purchase, statement_line, nfe_document, '
  'attachment, classification_rule.';
COMMENT ON COLUMN ai_embeddings.caixa_id IS
  'Caixa do objeto, para filtrar por permissão (nulo = cadastro global: entidades, categorias, regras globais).';
COMMENT ON COLUMN ai_embeddings.model IS 'Modelo de embeddings (ex.: text-embedding-3-small). Busque sempre com o mesmo modelo do vetor de consulta.';
COMMENT ON COLUMN ai_embeddings.source_text IS 'Texto que gerou (ou vai gerar) o vetor, montado pela aplicação (até 32 mil caracteres).';
COMMENT ON COLUMN ai_embeddings.source_hash IS 'SHA-256 (hex) de source_text, gerado pelo banco.';
COMMENT ON COLUMN ai_embeddings.embedding IS 'Vetor de 1536 dimensões (nulo = ainda não calculado).';
COMMENT ON COLUMN ai_embeddings.embedded_hash IS 'source_hash do texto usado para calcular o vetor atual. Diferente de source_hash = vetor velho.';
COMMENT ON COLUMN ai_embeddings.needs_reindex IS 'true = falta o vetor ou o texto mudou depois dele (gerado). Fila do worker (índice parcial).';

CREATE FUNCTION ai_embedding_store(p_embedding_id uuid, p_source_hash text, p_embedding vector(1536)) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  UPDATE ai_embeddings e
     SET embedding = p_embedding, embedded_hash = p_source_hash, embedded_at = clock_timestamp()
   WHERE e.id = p_embedding_id AND e.source_hash = p_source_hash;
  RETURN FOUND;
END
$$;

COMMENT ON FUNCTION ai_embedding_store(uuid, text, vector) IS
  'Worker: grava o vetor calculado para o texto de hash p_source_hash (lido junto com source_text). Se o texto mudou '
  'nesse meio-tempo, não grava e devolve false (a linha continua em needs_reindex).';

CREATE FUNCTION ai_embeddings_search(
  p_query        vector(1536),
  p_model        text,
  p_caixa_ids    uuid[],
  p_object_types text[] DEFAULT NULL,
  p_limit        int DEFAULT 20
)
RETURNS TABLE (object_type text, object_id uuid, caixa_id uuid, source_text text, distance double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_query IS NULL OR p_model IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'ai_embeddings_search: query vector, model and limit 1..200 are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT e.object_type, e.object_id, e.caixa_id, e.source_text, (e.embedding <=> p_query)::double precision
    FROM ai_embeddings e
   WHERE e.model = p_model AND e.embedding IS NOT NULL
     AND (e.caixa_id IS NULL OR e.caixa_id = ANY (coalesce(p_caixa_ids, '{}')))
     AND (p_object_types IS NULL OR e.object_type = ANY (p_object_types))
   ORDER BY e.embedding <=> p_query
   LIMIT p_limit;
END
$$;

COMMENT ON FUNCTION ai_embeddings_search(vector, text, uuid[], text[], int) IS
  'Vizinhos mais próximos (distância de cosseno, menor = mais parecido) do vetor de consulta, no mesmo modelo, só de '
  'objetos globais (caixa_id nulo) ou das caixas listadas (as que o usuário lê), opcionalmente por tipos. Vetores velhos '
  '(needs_reindex) ainda entram. Erro 22023 sem vetor/modelo ou com limite fora de 1..200.';

CREATE FUNCTION ai_embeddings_purge_orphans() RETURNS bigint
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM ai_embeddings e
   WHERE NOT CASE e.object_type
     WHEN 'entity' THEN EXISTS (SELECT 1 FROM entities x WHERE x.id = e.object_id)
     WHEN 'caixa' THEN EXISTS (SELECT 1 FROM caixas x WHERE x.id = e.object_id)
     WHEN 'financial_account' THEN EXISTS (SELECT 1 FROM financial_accounts x WHERE x.id = e.object_id)
     WHEN 'category' THEN EXISTS (SELECT 1 FROM categories x WHERE x.id = e.object_id)
     WHEN 'title' THEN EXISTS (SELECT 1 FROM titles x WHERE x.id = e.object_id)
     WHEN 'card_purchase' THEN EXISTS (SELECT 1 FROM card_purchases x WHERE x.id = e.object_id)
     WHEN 'statement_line' THEN EXISTS (SELECT 1 FROM statement_lines x WHERE x.id = e.object_id)
     WHEN 'nfe_document' THEN EXISTS (SELECT 1 FROM nfe_documents x WHERE x.id = e.object_id)
     WHEN 'attachment' THEN EXISTS (SELECT 1 FROM attachments x WHERE x.id = e.object_id)
     WHEN 'classification_rule' THEN EXISTS (SELECT 1 FROM classification_rules x WHERE x.id = e.object_id)
     ELSE false
   END;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION ai_embeddings_purge_orphans() IS
  'Apaga os embeddings cujo objeto não existe mais e devolve quantos. O worker chama periodicamente (ou a aplicação '
  'apaga o embedding na mesma transação em que exclui o objeto).';

-- migrate:down

DROP FUNCTION ai_embeddings_purge_orphans();
DROP FUNCTION ai_embeddings_search(vector, text, uuid[], text[], int);
DROP FUNCTION ai_embedding_store(uuid, text, vector);
DROP TABLE ai_embeddings;
DROP FUNCTION ai_text_sha256(text);
