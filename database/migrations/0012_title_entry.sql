-- migrate:up

-- Entrada de títulos (spec 010): boleto (código de barras), PIX copia-e-cola
-- (BR Code) e NF-e (chave de acesso, emitente, itens).

-- Boleto ------------------------------------------------------------------------------
CREATE FUNCTION is_valid_boleto_barcode(code text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  body text;
  s    int := 0;
  w    int := 2;
  p    int;
  r    int;
  dv   int;
BEGIN
  IF code !~ '^[0-9]{44}$' THEN
    RETURN false;
  END IF;

  IF left(code, 1) <> '8' THEN
    -- Bancário: DV geral na posição 5, módulo 11 (pesos 2..9 da direita); 0, 10 e 11 viram 1.
    body := left(code, 4) || substr(code, 6);
    FOR i IN REVERSE 43..1 LOOP
      s := s + substr(body, i, 1)::int * w;
      w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
    END LOOP;
    dv := 11 - s % 11;
    IF dv IN (0, 10, 11) THEN
      dv := 1;
    END IF;
    RETURN dv = substr(code, 5, 1)::int;
  END IF;

  -- Convênio (arrecadação, começa com 8): DV na posição 4; o 3º dígito diz o módulo.
  body := left(code, 3) || substr(code, 5);
  IF substr(code, 3, 1) IN ('6', '7') THEN
    FOR i IN REVERSE 43..1 LOOP
      p := substr(body, i, 1)::int * w;
      s := s + p / 10 + p % 10;
      w := 3 - w;
    END LOOP;
    dv := (10 - s % 10) % 10;
  ELSIF substr(code, 3, 1) IN ('8', '9') THEN
    FOR i IN REVERSE 43..1 LOOP
      s := s + substr(body, i, 1)::int * w;
      w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
    END LOOP;
    r := s % 11;
    dv := CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END;
  ELSE
    RETURN false;
  END IF;
  RETURN dv = substr(code, 4, 1)::int;
END
$$;

COMMENT ON FUNCTION is_valid_boleto_barcode(text) IS
  'Valida o código de barras de boleto (44 dígitos, JÁ NORMALIZADO, sem espaços/pontos). Bancário: DV na posição 5, '
  'módulo 11. Convênio (começa com 8): DV na posição 4, módulo 10 (3º dígito 6/7) ou 11 (8/9). '
  'A linha digitável (47/48 dígitos) é convertida para o código de barras pela aplicação. NULL => NULL.';

-- PIX copia-e-cola (BR Code, EMV QRCPS) -----------------------------------------------
CREATE FUNCTION is_valid_brcode(payload text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  bytes bytea;
  crc   int := 65535;  -- CRC-16/CCITT-FALSE: polinômio 0x1021, inicial 0xFFFF.
BEGIN
  IF length(payload) NOT BETWEEN 30 AND 512
     OR payload !~ '^000201'
     OR payload !~ '6304[0-9A-Fa-f]{4}$'
     OR position('br.gov.bcb.pix' IN lower(payload)) = 0 THEN
    RETURN false;
  END IF;

  bytes := convert_to(left(payload, length(payload) - 4), 'UTF8');
  FOR i IN 0..length(bytes) - 1 LOOP
    crc := crc # (get_byte(bytes, i) << 8);
    FOR b IN 1..8 LOOP
      IF crc & 32768 <> 0 THEN
        crc := ((crc << 1) # 4129) & 65535;
      ELSE
        crc := (crc << 1) & 65535;
      END IF;
    END LOOP;
  END LOOP;

  RETURN upper(right(payload, 4)) = lpad(upper(to_hex(crc)), 4, '0');
END
$$;

COMMENT ON FUNCTION is_valid_brcode(text) IS
  'Valida um PIX copia-e-cola (BR Code): começa com 000201, tem o GUI br.gov.bcb.pix, 30 a 512 caracteres e termina '
  'no campo 63 (CRC) com o CRC-16/CCITT-FALSE correto do payload. Não interpreta os demais campos. NULL => NULL.';

-- NF-e ---------------------------------------------------------------------------------
CREATE FUNCTION is_valid_nfe_access_key(access_key text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  s  int := 0;
  w  int := 2;
  r  int;
BEGIN
  IF access_key !~ '^[0-9]{44}$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE 43..1 LOOP
    s := s + substr(access_key, i, 1)::int * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  RETURN (CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END) = substr(access_key, 44, 1)::int;
END
$$;

COMMENT ON FUNCTION is_valid_nfe_access_key(text) IS
  'Valida a chave de acesso de NF-e/NFC-e: 44 dígitos (JÁ NORMALIZADA) e DV módulo 11 (pesos 2..9; resto 0 ou 1 => 0). NULL => NULL.';

CREATE TABLE nfe_documents (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  access_key          text        NOT NULL,
  issuer_entity_id    uuid        NOT NULL REFERENCES entities (id),
  recipient_entity_id uuid        REFERENCES entities (id),
  number              integer     NOT NULL,
  series              smallint    NOT NULL,
  issued_at           timestamptz NOT NULL,
  total_cents         bigint      NOT NULL,
  xml_attachment_id   uuid        REFERENCES attachments (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nfe_documents_access_key_key UNIQUE (access_key),
  CONSTRAINT nfe_documents_access_key_check CHECK (is_valid_nfe_access_key(access_key)),
  CONSTRAINT nfe_documents_number_check CHECK (number BETWEEN 1 AND 999999999),
  CONSTRAINT nfe_documents_series_check CHECK (series BETWEEN 0 AND 999),
  CONSTRAINT nfe_documents_total_cents_check CHECK (total_cents >= 0),
  CONSTRAINT nfe_documents_parties_check CHECK (recipient_entity_id <> issuer_entity_id)
);

CREATE INDEX nfe_documents_issuer_entity_id_idx ON nfe_documents (issuer_entity_id);
CREATE INDEX nfe_documents_recipient_entity_id_idx ON nfe_documents (recipient_entity_id);
CREATE INDEX nfe_documents_xml_attachment_id_idx ON nfe_documents (xml_attachment_id);

CREATE TRIGGER nfe_documents_set_updated_at BEFORE UPDATE ON nfe_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE nfe_documents IS
  'NF-e importada (XML, spec 010). Uma por chave de acesso no sistema inteiro; vários títulos podem apontar para ela '
  '(duplicatas/parcelas, e os dois lados de um espelho).';
COMMENT ON COLUMN nfe_documents.access_key IS 'Chave de acesso de 44 dígitos, normalizada, com DV válido. Única.';
COMMENT ON COLUMN nfe_documents.issuer_entity_id IS 'Emitente (vira entidade no import).';
COMMENT ON COLUMN nfe_documents.recipient_entity_id IS 'Destinatário, quando identificado.';
COMMENT ON COLUMN nfe_documents.total_cents IS 'Valor total da nota (vNF), em centavos.';
COMMENT ON COLUMN nfe_documents.xml_attachment_id IS 'Anexo com o XML original.';

CREATE TABLE nfe_items (
  id               uuid          PRIMARY KEY DEFAULT uuidv7(),
  nfe_document_id  uuid          NOT NULL REFERENCES nfe_documents (id) ON DELETE CASCADE,
  item_number      smallint      NOT NULL,
  product_code     text,
  description      text          NOT NULL,
  ncm              text,
  cfop             text,
  unit             text,
  quantity         numeric(15,4) NOT NULL,
  unit_price_cents numeric(23,8) NOT NULL,
  total_cents      bigint        NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT nfe_items_item_number_key UNIQUE (nfe_document_id, item_number),
  CONSTRAINT nfe_items_item_number_check CHECK (item_number BETWEEN 1 AND 990),
  CONSTRAINT nfe_items_description_check CHECK (btrim(description) <> ''),
  CONSTRAINT nfe_items_ncm_check CHECK (ncm ~ '^[0-9]{2}([0-9]{6})?$'),
  CONSTRAINT nfe_items_cfop_check CHECK (cfop ~ '^[1-7][0-9]{3}$'),
  CONSTRAINT nfe_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT nfe_items_amounts_check CHECK (unit_price_cents >= 0 AND total_cents >= 0)
);

CREATE TRIGGER nfe_items_set_updated_at BEFORE UPDATE ON nfe_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE nfe_items IS 'Itens (det/prod) de uma NF-e importada. Opcionais: a nota pode ser guardada sem itens.';
COMMENT ON COLUMN nfe_items.unit_price_cents IS 'Valor unitário (vUnCom) em centavos, com casas decimais (a NF-e admite até 10).';
COMMENT ON COLUMN nfe_items.total_cents IS 'Valor do item (vProd), em centavos.';

-- Campos do título ------------------------------------------------------------------------
ALTER TABLE titles
  ADD COLUMN boleto_barcode  text,
  ADD COLUMN pix_payload     text,
  ADD COLUMN nfe_document_id uuid REFERENCES nfe_documents (id),
  ADD CONSTRAINT titles_boleto_barcode_check CHECK (is_valid_boleto_barcode(boleto_barcode)),
  ADD CONSTRAINT titles_pix_payload_check CHECK (is_valid_brcode(pix_payload));

CREATE INDEX titles_nfe_document_id_idx ON titles (nfe_document_id);
-- O mesmo boleto não é lançado duas vezes na mesma caixa (cancelados não contam).
CREATE UNIQUE INDEX titles_caixa_boleto_barcode_key ON titles (caixa_id, boleto_barcode)
  WHERE boleto_barcode IS NOT NULL AND status <> 'canceled';

COMMENT ON COLUMN titles.boleto_barcode IS
  'Código de barras do boleto (44 dígitos, com DV válido). A linha digitável é derivada dele. '
  'Único por caixa entre os títulos não cancelados.';
COMMENT ON COLUMN titles.pix_payload IS 'PIX copia-e-cola (BR Code) completo, com CRC válido. Pode repetir (QR estático).';
COMMENT ON COLUMN titles.nfe_document_id IS 'NF-e de origem (import de XML). Vários títulos podem apontar para a mesma nota.';

-- Ligação de anexos: a view passa a mostrar também o XML das NF-e.
CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments
UNION ALL
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL;

-- migrate:down

CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments;

DROP INDEX titles_caixa_boleto_barcode_key;
DROP INDEX titles_nfe_document_id_idx;
ALTER TABLE titles
  DROP CONSTRAINT titles_pix_payload_check,
  DROP CONSTRAINT titles_boleto_barcode_check,
  DROP COLUMN nfe_document_id,
  DROP COLUMN pix_payload,
  DROP COLUMN boleto_barcode;

DROP TABLE nfe_items;
DROP TABLE nfe_documents;
DROP FUNCTION is_valid_nfe_access_key(text);
DROP FUNCTION is_valid_brcode(text);
DROP FUNCTION is_valid_boleto_barcode(text);
