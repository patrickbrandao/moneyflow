-- migrate:up

-- Chave de acesso da NF-e com CNPJ alfanumérico (NT 2025.001; tarefa 014; specs 003, 010 e 016).
-- As posições 7 a 20 da chave são o CNPJ do emitente, que pode ser alfanumérico: os 12 primeiros caracteres dele
-- (posições 7 a 18) aceitam [0-9A-Z] e os DVs do CNPJ (19 e 20) continuam numéricos. O DV da chave (posição 44) é o
-- módulo 11 sobre os 43 primeiros caracteres, cada um valendo ascii(c) − 48, pesos 2..9 a partir da direita e resto
-- 0 ou 1 => 0. Para chaves só de dígitos o resultado é idêntico ao anterior.

CREATE OR REPLACE FUNCTION is_valid_nfe_access_key(access_key text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  s  int := 0;
  w  int := 2;
  r  int;
BEGIN
  IF access_key !~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE 43..1 LOOP
    s := s + (ascii(substr(access_key, i, 1)) - 48) * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  RETURN (CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END) = ascii(substr(access_key, 44, 1)) - 48;
END
$$;

COMMENT ON FUNCTION is_valid_nfe_access_key(text) IS
  'Valida a chave de acesso de NF-e/NFC-e (NT 2025.001), JÁ NORMALIZADA: 44 caracteres ^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$ '
  '(o CNPJ do emitente, posições 7–20, pode ser alfanumérico; só maiúsculas) e DV módulo 11 sobre os 43 primeiros, '
  'cada caractere = ASCII − 48, pesos 2..9 da direita, resto 0 ou 1 => 0. NULL => NULL.';

COMMENT ON COLUMN nfe_documents.access_key IS
  'Chave de acesso de 44 caracteres (NT 2025.001: CNPJ do emitente alfanumérico nas posições 7–20), normalizada '
  '(maiúsculas, sem espaços), com DV válido. Única.';

-- migrate:down

CREATE OR REPLACE FUNCTION is_valid_nfe_access_key(access_key text) RETURNS boolean
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

COMMENT ON COLUMN nfe_documents.access_key IS 'Chave de acesso de 44 dígitos, normalizada, com DV válido. Única.';
