-- migrate:up

-- Extensões ------------------------------------------------------------------
-- pgtap NÃO é criada aqui: cada arquivo de teste cria a extensão no banco de
-- testes, dentro de uma transação que termina em ROLLBACK.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- Papel da aplicação ---------------------------------------------------------
-- Em Docker o papel nasce com LOGIN e senha em docker/initdb/02-app-role.sh.
-- Em qualquer outro ambiente a migration garante que ele exista (NOLOGIN);
-- quem administra o ambiente define LOGIN/senha fora das migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_app') THEN
    CREATE ROLE moneyflow_app NOLOGIN;
  END IF;
END
$$;

-- Ninguém além do dono cria objetos em public (padrão do PG15+, explicitado
-- porque as funções SECURITY DEFINER dependem disso).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO moneyflow_app;

-- Privilégios padrão para tudo o que o dono criar daqui em diante em public:
-- DML em tabelas, USAGE em sequences, EXECUTE em funções (só para o app;
-- PUBLIC perde o EXECUTE automático).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO moneyflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO moneyflow_app;
-- (O REVOKE de PUBLIC precisa ser global: privilégios padrão por schema só somam.)
ALTER DEFAULT PRIVILEGES
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO moneyflow_app;

-- updated_at -----------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger BEFORE UPDATE: mantém updated_at = now() (início da transação).';

-- CPF ------------------------------------------------------------------------
CREATE FUNCTION is_valid_cpf(cpf text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  s  int;
  dv int;
BEGIN
  IF cpf !~ '^[0-9]{11}$' OR cpf = repeat(left(cpf, 1), 11) THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..9 LOOP
    s := s + substr(cpf, i, 1)::int * (11 - i);
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  IF dv <> substr(cpf, 10, 1)::int THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..10 LOOP
    s := s + substr(cpf, i, 1)::int * (12 - i);
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  RETURN dv = substr(cpf, 11, 1)::int;
END
$$;

COMMENT ON FUNCTION is_valid_cpf(text) IS
  'Valida os dígitos verificadores de um CPF. Recebe o valor JÁ NORMALIZADO: '
  'exatamente 11 dígitos, sem pontos/traço. Formatado ou com espaços => false. '
  'Rejeita sequências repetidas (000…0 a 999…9). NULL => NULL.';

-- CNPJ (numérico e alfanumérico) ---------------------------------------------
CREATE FUNCTION is_valid_cnpj(cnpj text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  w1 constant int[] := '{5,4,3,2,9,8,7,6,5,4,3,2}';
  w2 constant int[] := '{6,5,4,3,2,9,8,7,6,5,4,3,2}';
  s  int;
  dv int;
BEGIN
  IF cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' OR cnpj = repeat(left(cnpj, 1), 14) THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..12 LOOP
    s := s + (ascii(substr(cnpj, i, 1)) - 48) * w1[i];
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  IF dv <> substr(cnpj, 13, 1)::int THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..13 LOOP
    s := s + (ascii(substr(cnpj, i, 1)) - 48) * w2[i];
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  RETURN dv = substr(cnpj, 14, 1)::int;
END
$$;

COMMENT ON FUNCTION is_valid_cnpj(text) IS
  'Valida um CNPJ numérico ou alfanumérico (IN RFB, vigente desde jul/2026). '
  'Recebe o valor JÁ NORMALIZADO: 14 caracteres, os 12 primeiros [0-9A-Z] '
  '(letras MAIÚSCULAS) e os 2 últimos dígitos verificadores numéricos, sem '
  'pontos/barra/traço. Valor de cada caractere = ASCII - 48; pesos e módulo 11 '
  'do algoritmo clássico. Rejeita sequências repetidas. NULL => NULL.';

-- migrate:down

DROP FUNCTION is_valid_cnpj(text);
DROP FUNCTION is_valid_cpf(text);
DROP FUNCTION set_updated_at();

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM moneyflow_app;
ALTER DEFAULT PRIVILEGES
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE ON SEQUENCES FROM moneyflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM moneyflow_app;

REVOKE USAGE ON SCHEMA public FROM moneyflow_app;
-- REVOKE CREATE ON SCHEMA public FROM PUBLIC não é desfeito: é o padrão do
-- PostgreSQL 15+ e reabrir o schema seria inseguro. O papel moneyflow_app é
-- global ao cluster e também não é removido.

DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS vector;
