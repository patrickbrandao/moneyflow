-- migrate:up

-- Tarefa 054: restauração do dump pelo dono do banco (docs/016, Segurança). O pg_dump grava os GRANTs de cada objeto
-- em relação ao padrão embutido do Postgres (acldefault), sem os privilégios padrão do banco. Com --clean, o
-- pg_restore recria as tabelas num banco que já tem o ALTER DEFAULT PRIVILEGES da 0001, e elas nascem com SELECT,
-- INSERT, UPDATE e DELETE para moneyflow_app na tabela inteira: o SELECT por coluna que blinda users.password,
-- message_destinations.bot_token, ai_providers.api_key… deixa de valer. Esta função zera, para o papel que a chama
-- (o dono), os privilégios padrão deste banco; chamada no início da MESMA transação da restauração, os objetos
-- recriados nascem com o padrão embutido, recebem exatamente os GRANTs do dump, e os privilégios padrão voltam no fim
-- (as entradas DEFAULT ACL do próprio dump). Fora dessa transação, deixaria as migrations seguintes sem os GRANTs.
CREATE FUNCTION restore_reset_default_privileges() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  me    oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  r     record;
  g     record;
  kw    text;
  scope text;
BEGIN
  FOR r IN SELECT defaclnamespace, defaclobjtype, defaclacl FROM pg_default_acl WHERE defaclrole = me LOOP
    kw := CASE r.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                               WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END;
    scope := CASE WHEN r.defaclnamespace = 0 THEN '' ELSE format('IN SCHEMA %I', r.defaclnamespace::regnamespace) END;
    FOR g IN SELECT DISTINCT grantee FROM aclexplode(r.defaclacl) WHERE grantee <> me LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %s', current_user, scope, kw,
                     CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.grantee::regrole::text) END);
    END LOOP;
    IF r.defaclnamespace = 0 THEN
      -- Entrada global: volta ao padrão embutido (o dono com tudo; PUBLIC executa funções e usa tipos).
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON %s TO %I', current_user, kw, current_user);
      IF r.defaclobjtype = 'f' THEN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC', current_user);
      ELSIF r.defaclobjtype = 'T' THEN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON TYPES TO PUBLIC', current_user);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_default_acl WHERE defaclrole = me) THEN
    RAISE EXCEPTION 'restore_reset_default_privileges: privilégios padrão de % não zerados', current_user;
  END IF;
END
$$;

COMMENT ON FUNCTION restore_reset_default_privileges() IS
  'Restauração do dump (spec 019, tarefa 054): zera os privilégios padrão do papel que chama (o dono) neste banco. '
  'Chame só na mesma transação do restore, antes dele (psql --single-transaction com o SQL do pg_restore): os objetos '
  'recriados recebem só os GRANTs do dump e os privilégios padrão voltam pelas entradas DEFAULT ACL do dump.';

-- Só o dono (ou o superusuário) chama; a aplicação não.
REVOKE EXECUTE ON FUNCTION restore_reset_default_privileges() FROM moneyflow_app, PUBLIC;

-- migrate:down

DROP FUNCTION restore_reset_default_privileges();
