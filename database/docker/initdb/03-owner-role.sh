#!/bin/bash
# Dono do banco SEM superusuário (tarefa 054, docs/016): o papel moneyflow_owner é dono dos bancos e do schema
# public, roda as migrations e faz o dump/restauração do backup (DATABASE_OWNER_URL). O superusuário da imagem
# (POSTGRES_USER) fica só para a administração do cluster: criar bancos, papéis e as extensões.
#
# Roda no primeiro boot do volume (docker-entrypoint-initdb.d) e é idempotente: `make owner` o executa de novo num
# volume antigo, passando a posse dos objetos já criados pelo superusuário ao dono. Bancos tratados: OWNER_DBS
# (padrão: "$POSTGRES_DB ${POSTGRES_DB}_test"), cada um precisa existir.
set -euo pipefail
owner_password="${OWNER_DB_PASSWORD:-moneyflow_owner}"
owner_dbs="${OWNER_DBS:-$POSTGRES_DB ${POSTGRES_DB}_test}"
super="${POSTGRES_USER}"

psql -X -q -v ON_ERROR_STOP=1 --username "$super" --dbname postgres -v pw="$owner_password" <<'SQL'
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_owner') AS create_owner \gset
\if :create_owner
  CREATE ROLE moneyflow_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :'pw';
\else
  -- Já existe: só garante os atributos (a senha de um papel existente não é trocada aqui).
  ALTER ROLE moneyflow_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
\endif
SQL

for db in $owner_dbs; do
  psql -X -q -v ON_ERROR_STOP=1 --username "$super" --dbname postgres -v db="$db" <<'SQL'
ALTER DATABASE :"db" OWNER TO moneyflow_owner;
SQL
  psql -X -q -v ON_ERROR_STOP=1 --username "$super" --dbname "$db" -v super="$super" <<'SQL'
BEGIN;
ALTER SCHEMA public OWNER TO moneyflow_owner;

-- Extensões: só o superusuário cria a vector (não é trusted); pg_trgm e citext ficam com ele também, para as três
-- terem o mesmo dono. A migration 0001 as encontra (IF NOT EXISTS). Por isso a restauração do dump pelo dono não
-- pode apagar nem recriar extensões (veja docs/016, Segurança).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- Volume antigo: objetos do schema public criados pelo superusuário passam ao dono (fora os das extensões e as
-- sequences presas a uma coluna, que acompanham a tabela). Os GRANTs ficam (o concedente passa a ser o dono).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relkind, format('%I.%I', n.nspname, c.relname) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relowner <> 'moneyflow_owner'::regrole
       AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                        AND d.deptype IN ('e', 'a', 'i'))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO moneyflow_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.name);
  END LOOP;

  FOR r IN
    SELECT p.oid, p.prokind
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proowner <> 'moneyflow_owner'::regrole
       AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO moneyflow_owner',
      CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      r.oid::regprocedure);
  END LOOP;

  -- Tipos próprios (domínios, enums, compostos avulsos, ranges); não os de tabela nem os arrays.
  FOR r IN
    SELECT t.oid, t.typtype
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typowner <> 'moneyflow_owner'::regrole
       AND t.typtype IN ('d', 'e', 'c', 'r') AND t.typelem = 0
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid
                        AND d.deptype IN ('e', 'i'))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO moneyflow_owner',
      CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.oid::regtype);
  END LOOP;
END
$$;

-- Privilégios padrão (os da migration 0001) para o que o dono criar daqui em diante, só num banco já migrado: num
-- banco novo quem os define é a própria 0001, depois de o dbmate criar a schema_migrations (que fica sem GRANT para
-- moneyflow_app).
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS migrated \gset
\if :migrated
ALTER DEFAULT PRIVILEGES FOR ROLE moneyflow_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO moneyflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE moneyflow_owner IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO moneyflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE moneyflow_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE moneyflow_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO moneyflow_app;

-- Os privilégios padrão antigos, do superusuário (migrations de antes do dono), voltam ao padrão do Postgres: senão o
-- dump do dono levaria um ALTER DEFAULT PRIVILEGES FOR ROLE <superusuário> que ele não pode restaurar.
ALTER DEFAULT PRIVILEGES FOR ROLE :"super" IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM moneyflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"super" IN SCHEMA public
  REVOKE USAGE ON SEQUENCES FROM moneyflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"super" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM moneyflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"super"
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
\endif
COMMIT;
SQL
done
