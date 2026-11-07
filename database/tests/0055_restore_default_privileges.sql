-- Testes de 0055_restore_default_privileges e do dono do banco (tarefa 054, docs/016): o moneyflow_owner existe sem
-- superusuário, sem CREATEROLE e sem CREATEDB, é dono do banco e do schema public e dos objetos das migrations;
-- moneyflow_app não toca na schema_migrations; restore_reset_default_privileges() zera os privilégios padrão do dono
-- (só na transação), não é da aplicação, e um objeto criado depois dela nasce sem GRANT para moneyflow_app.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_role('moneyflow_owner');
SELECT is(rolsuper, false, 'o dono não é superusuário') FROM pg_roles WHERE rolname = 'moneyflow_owner';
SELECT is(rolcreaterole, false, 'o dono não cria papéis') FROM pg_roles WHERE rolname = 'moneyflow_owner';
SELECT is(rolcreatedb, false, 'o dono não cria bancos') FROM pg_roles WHERE rolname = 'moneyflow_owner';
SELECT is(rolreplication OR rolbypassrls, false, 'o dono não replica nem ignora RLS')
  FROM pg_roles WHERE rolname = 'moneyflow_owner';
SELECT is(rolcanlogin, true, 'o dono faz login') FROM pg_roles WHERE rolname = 'moneyflow_owner';
SELECT is((SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
            WHERE m.member = 'moneyflow_owner'::regrole), 0, 'o dono não é membro de nenhum papel');

SELECT is((SELECT datdba::regrole::text FROM pg_database WHERE datname = current_database()), 'moneyflow_owner',
          'o banco é do dono');
SELECT is((SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public'), 'moneyflow_owner',
          'o schema public é do dono');
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
              AND c.relowner <> 'moneyflow_owner'::regrole
              AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                               AND d.deptype = 'e')), 0, 'tabelas, visões e sequences são do dono');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proowner <> 'moneyflow_owner'::regrole
              AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                               AND d.deptype = 'e')), 0, 'as funções das migrations são do dono');

SELECT is(has_table_privilege('moneyflow_app', 'schema_migrations', 'SELECT')
          OR has_table_privilege('moneyflow_app', 'schema_migrations', 'INSERT')
          OR has_table_privilege('moneyflow_app', 'schema_migrations', 'UPDATE')
          OR has_table_privilege('moneyflow_app', 'schema_migrations', 'DELETE'), false,
          'moneyflow_app não lê nem altera a schema_migrations');

SELECT is(has_function_privilege('moneyflow_app', 'restore_reset_default_privileges()', 'EXECUTE'), false,
          'a aplicação não chama restore_reset_default_privileges');

-- Como o dono, dentro desta transação.
SET LOCAL ROLE moneyflow_owner;
SELECT ok((SELECT count(*) FROM pg_default_acl WHERE defaclrole = 'moneyflow_owner'::regrole) >= 4,
          'o dono tem os privilégios padrão da 0001');
CREATE TABLE pg_temp_before (x int);
SELECT ok(has_table_privilege('moneyflow_app', 'pg_temp_before', 'SELECT'), 'antes: tabela nova vai ao app');
CREATE FUNCTION f_before() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT is(has_function_privilege('public', 'f_before()', 'EXECUTE'), false, 'antes: função nova sem PUBLIC');

SELECT lives_ok('SELECT restore_reset_default_privileges()', 'o dono zera os privilégios padrão');
SELECT is((SELECT count(*)::int FROM pg_default_acl WHERE defaclrole = 'moneyflow_owner'::regrole), 0,
          'sem privilégios padrão do dono');
CREATE TABLE pg_temp_after (x int);
SELECT is(has_table_privilege('moneyflow_app', 'pg_temp_after', 'SELECT')
          OR has_table_privilege('moneyflow_app', 'pg_temp_after', 'INSERT'), false,
          'depois: tabela recriada nasce sem GRANT ao app (só os do dump)');
CREATE FUNCTION f_after() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT is(has_function_privilege('public', 'f_after()', 'EXECUTE'), true,
          'depois: função nasce com o padrão embutido (o dump traz o REVOKE de PUBLIC)');
SELECT lives_ok('SELECT restore_reset_default_privileges()', 'chamar de novo não falha');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
