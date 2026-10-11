-- migrate:up

-- Anexos (specs 001, 005, 008, 009, 010): o arquivo fica no próprio Postgres
-- (bytea), até 20 MB. Tamanho e SHA-256 são calculados pelo banco. Cada anexo
-- se liga aos registros por tabelas de ligação com FKs reais; o lote de import
-- de extrato (0014) e a NF-e (0012) apontam direto para o anexo do arquivo.
CREATE TABLE attachments (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  file_name           text        NOT NULL,
  mime_type           text        NOT NULL,
  content             bytea       NOT NULL,
  size_bytes          integer     NOT NULL GENERATED ALWAYS AS (octet_length(content)) STORED,
  sha256              text        NOT NULL GENERATED ALWAYS AS (encode(sha256(content), 'hex')) STORED,
  uploaded_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_file_name_check CHECK (
    btrim(file_name) <> '' AND length(file_name) <= 255 AND file_name !~ '[/\\[:cntrl:]]'
  ),
  CONSTRAINT attachments_mime_type_check CHECK (
    mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$' AND length(mime_type) <= 127
  ),
  CONSTRAINT attachments_size_check CHECK (octet_length(content) BETWEEN 1 AND 20971520)
);

CREATE INDEX attachments_sha256_idx ON attachments (sha256);
CREATE INDEX attachments_uploaded_by_user_id_idx ON attachments (uploaded_by_user_id);

CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- O conteúdo é imutável (o SHA-256 identifica o arquivo); renomear é permitido.
CREATE FUNCTION attachments_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'attachments: content of attachment % cannot change (upload a new file)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attachments_content_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER attachments_validate BEFORE UPDATE OF content ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_validate();

COMMENT ON TABLE attachments IS
  'Arquivos anexados (PDF, imagem, XML, OFX/CSV…), guardados em bytea, até 20 MB (spec 001). '
  'Ligados aos registros por tabelas *_attachments; o arquivo de um import de extrato e o XML da NF-e são referenciados direto.';
COMMENT ON COLUMN attachments.file_name IS 'Nome original do arquivo (sem caminho), até 255 caracteres.';
COMMENT ON COLUMN attachments.mime_type IS 'Tipo MIME em minúsculas, sem parâmetros (ex.: application/pdf).';
COMMENT ON COLUMN attachments.content IS 'Bytes do arquivo (1 byte a 20 MB). Imutável. Nunca selecione em listas: use as outras colunas.';
COMMENT ON COLUMN attachments.size_bytes IS 'Tamanho em bytes, calculado pelo banco (coluna gerada).';
COMMENT ON COLUMN attachments.sha256 IS 'SHA-256 do conteúdo em hex minúsculo, calculado pelo banco; serve para achar o mesmo arquivo já enviado.';

-- Ligações -----------------------------------------------------------------------------
CREATE TABLE title_attachments (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  title_id      uuid        NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT title_attachments_key UNIQUE (title_id, attachment_id)
);
CREATE INDEX title_attachments_attachment_id_idx ON title_attachments (attachment_id);
CREATE TRIGGER title_attachments_set_updated_at BEFORE UPDATE ON title_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE title_attachments IS 'Anexos de um título (boleto, nota, comprovante).';

CREATE TABLE settlement_attachments (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  settlement_id uuid        NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_attachments_key UNIQUE (settlement_id, attachment_id)
);
CREATE INDEX settlement_attachments_attachment_id_idx ON settlement_attachments (attachment_id);
CREATE TRIGGER settlement_attachments_set_updated_at BEFORE UPDATE ON settlement_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE settlement_attachments IS 'Anexos de uma baixa (comprovante de pagamento).';

CREATE TABLE movement_attachments (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  movement_id   uuid        NOT NULL REFERENCES movements (id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movement_attachments_key UNIQUE (movement_id, attachment_id)
);
CREATE INDEX movement_attachments_attachment_id_idx ON movement_attachments (attachment_id);
CREATE TRIGGER movement_attachments_set_updated_at BEFORE UPDATE ON movement_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE movement_attachments IS 'Anexos de um movimento (recibo de um ajuste, comprovante de transferência).';

CREATE TABLE entity_attachments (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id     uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_attachments_key UNIQUE (entity_id, attachment_id)
);
CREATE INDEX entity_attachments_attachment_id_idx ON entity_attachments (attachment_id);
CREATE TRIGGER entity_attachments_set_updated_at BEFORE UPDATE ON entity_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE entity_attachments IS 'Anexos de uma entidade (contrato, cartão CNPJ, documentos).';

-- Onde cada anexo está ligado (as migrations seguintes recriam a view com as novas ligações).
CREATE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments;

COMMENT ON VIEW attachment_links IS
  'Todas as ligações de anexos (target_kind + target_id). Anexo sem linha aqui e sem referência direta '
  '(import de extrato, NF-e) é órfão e pode ser apagado pela aplicação.';

-- migrate:down

DROP VIEW attachment_links;
DROP TABLE entity_attachments;
DROP TABLE movement_attachments;
DROP TABLE settlement_attachments;
DROP TABLE title_attachments;
DROP TABLE attachments;
DROP FUNCTION attachments_validate();
