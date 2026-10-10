-- Testes de 0001_base: extensões, papel da aplicação, set_updated_at e validação de CPF/CNPJ.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Extensões
SELECT has_extension('vector');
SELECT has_extension('pg_trgm');
SELECT has_extension('citext');

-- Papel da aplicação e privilégios padrão
SELECT has_role('moneyflow_app');
SELECT ok(NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'moneyflow_app'),
          'moneyflow_app não é superuser nem cria bancos/papéis');
SELECT ok(has_schema_privilege('moneyflow_app', 'public', 'USAGE'), 'moneyflow_app usa o schema public');
SELECT ok(NOT has_schema_privilege('moneyflow_app', 'public', 'CREATE'), 'moneyflow_app não cria objetos (sem DDL)');
SELECT ok(NOT has_database_privilege('moneyflow_app', current_database(), 'CREATE'), 'moneyflow_app não cria schemas');

-- Funções
SELECT has_function('set_updated_at', '{}'::name[]);
SELECT has_function('is_valid_cpf', ARRAY['text']);
SELECT has_function('is_valid_cnpj', ARRAY['text']);
SELECT volatility_is('is_valid_cpf', ARRAY['text'], 'immutable');
SELECT volatility_is('is_valid_cnpj', ARRAY['text'], 'immutable');
SELECT is_strict('is_valid_cpf', ARRAY['text']);
SELECT is_strict('is_valid_cnpj', ARRAY['text']);
SELECT ok(has_function_privilege('moneyflow_app', 'is_valid_cpf(text)', 'EXECUTE'), 'app executa is_valid_cpf');
SELECT ok(has_function_privilege('moneyflow_app', 'is_valid_cnpj(text)', 'EXECUTE'), 'app executa is_valid_cnpj');

-- Privilégios padrão: uma tabela e uma função novas herdam os GRANTs para o app.
CREATE TABLE __t_default_privs (id serial PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION __t_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT table_privs_are('__t_default_privs', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
                       'tabela nova: DML para moneyflow_app (sem TRUNCATE/REFERENCES/TRIGGER)');
SELECT sequence_privs_are('__t_default_privs_id_seq', 'moneyflow_app', ARRAY['USAGE'],
                          'sequence nova: USAGE para moneyflow_app');
SELECT ok(has_function_privilege('moneyflow_app', '__t_fn()', 'EXECUTE'), 'função nova: EXECUTE para moneyflow_app');
SELECT ok(NOT has_function_privilege('public', '__t_fn()', 'EXECUTE'), 'função nova: sem EXECUTE para PUBLIC');

-- set_updated_at
CREATE TRIGGER __t_set_updated_at BEFORE UPDATE ON __t_default_privs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO __t_default_privs (updated_at) VALUES ('2000-01-01');
UPDATE __t_default_privs SET updated_at = '1999-01-01';
SELECT is((SELECT updated_at FROM __t_default_privs), now(), 'set_updated_at grava now() no UPDATE');

-- CPF válidos
SELECT ok(is_valid_cpf('52998224725'), 'CPF 529.982.247-25 é válido');
SELECT ok(is_valid_cpf('11144477735'), 'CPF 111.444.777-35 é válido');
SELECT ok(is_valid_cpf('39053344705'), 'CPF 390.533.447-05 é válido');
SELECT ok(is_valid_cpf('12345678909'), 'CPF 123.456.789-09 é válido');
SELECT ok(is_valid_cpf('00000000191'), 'CPF 000.000.001-91 é válido (zeros à esquerda)');
-- CPF inválidos
SELECT ok(NOT is_valid_cpf('52998224724'), 'CPF com 2º DV errado é inválido');
SELECT ok(NOT is_valid_cpf('52998224735'), 'CPF com 1º DV errado é inválido');
SELECT ok(NOT is_valid_cpf('11111111111'), 'CPF repetido 111… é inválido');
SELECT ok(NOT is_valid_cpf('00000000000'), 'CPF repetido 000… é inválido');
SELECT ok(NOT is_valid_cpf('529.982.247-25'), 'CPF formatado é inválido (precisa vir normalizado)');
SELECT ok(NOT is_valid_cpf('5299822472'), 'CPF com 10 dígitos é inválido');
SELECT ok(NOT is_valid_cpf('529982247250'), 'CPF com 12 dígitos é inválido');
SELECT ok(NOT is_valid_cpf('5299822472A'), 'CPF com letra é inválido');
SELECT ok(NOT is_valid_cpf(''), 'CPF vazio é inválido');
SELECT ok(NOT is_valid_cpf(' 52998224725'), 'CPF com espaço é inválido');
SELECT is(is_valid_cpf(NULL), NULL, 'is_valid_cpf(NULL) é NULL');

-- CNPJ numéricos válidos
SELECT ok(is_valid_cnpj('11222333000181'), 'CNPJ 11.222.333/0001-81 é válido');
SELECT ok(is_valid_cnpj('00000000000191'), 'CNPJ 00.000.000/0001-91 (Banco do Brasil) é válido');
SELECT ok(is_valid_cnpj('18236120000158'), 'CNPJ 18.236.120/0001-58 (Nu Pagamentos) é válido');
-- CNPJ alfanuméricos válidos (DVs calculados com ASCII-48, pesos 2..9 e módulo 11)
SELECT ok(is_valid_cnpj('12ABC34501DE35'), 'CNPJ alfanumérico 12.ABC.345/01DE-35 (exemplo da RFB) é válido');
SELECT ok(is_valid_cnpj('A1B2C3D4E5F668'), 'CNPJ alfanumérico A1.B2C.3D4/E5F6-68 é válido');
SELECT ok(is_valid_cnpj('MONEYFLOW00147'), 'CNPJ alfanumérico MO.NEY.FLO/W001-47 é válido');
-- CNPJ inválidos
SELECT ok(NOT is_valid_cnpj('11222333000182'), 'CNPJ com 2º DV errado é inválido');
SELECT ok(NOT is_valid_cnpj('11222333000191'), 'CNPJ com 1º DV errado é inválido');
SELECT ok(NOT is_valid_cnpj('12ABC34501DE36'), 'CNPJ alfanumérico com DV errado é inválido');
SELECT ok(NOT is_valid_cnpj('12abc34501de35'), 'CNPJ alfanumérico em minúsculas é inválido (precisa vir normalizado)');
SELECT ok(NOT is_valid_cnpj('12ABC34501DE3A'), 'CNPJ com letra no DV é inválido');
SELECT ok(NOT is_valid_cnpj('11.222.333/0001-81'), 'CNPJ formatado é inválido');
SELECT ok(NOT is_valid_cnpj('1122233300018'), 'CNPJ com 13 caracteres é inválido');
SELECT ok(NOT is_valid_cnpj('112223330001810'), 'CNPJ com 15 caracteres é inválido');
SELECT ok(NOT is_valid_cnpj('00000000000000'), 'CNPJ repetido 000… é inválido');
SELECT ok(NOT is_valid_cnpj('11111111111111'), 'CNPJ repetido 111… é inválido');
SELECT ok(NOT is_valid_cnpj('12ABC345-1DE35'), 'CNPJ com símbolo é inválido');
SELECT ok(NOT is_valid_cnpj(''), 'CNPJ vazio é inválido');
SELECT is(is_valid_cnpj(NULL), NULL, 'is_valid_cnpj(NULL) é NULL');

SELECT * FROM finish();
ROLLBACK;
