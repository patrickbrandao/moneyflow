-- Testes de 0062_classification_rule_normalized (tarefa 076): classification_rule_for com a descrição normalizada opcional.
-- A regra aprendida (padrão normalizado) casa com a linha de onde nasceu; a crua continua valendo; a ordem não muda.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000062' || p)::uuid $$;
CREATE FUNCTION pg_temp.rule(p_desc text, p_amount bigint, p_norm text DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$ SELECT classification_rule_for(pg_temp.u('a001'), NULL, p_desc, p_amount, p_norm) $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('classification_rule_for', ARRAY['uuid', 'uuid', 'text', 'bigint', 'text']);
SELECT hasnt_function('classification_rule_for', ARRAY['uuid', 'uuid', 'text', 'bigint']);
SELECT ok(has_function_privilege('moneyflow_app', 'classification_rule_for(uuid, uuid, text, bigint, text)', 'EXECUTE'),
          'app executa classification_rule_for');
SELECT ok(NOT has_function_privilege('public', 'classification_rule_for(uuid, uuid, text, bigint, text)', 'EXECUTE'),
          'PUBLIC não executa classification_rule_for');

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Cliente Ômega'),
  (pg_temp.u('e003'), 'company', 'Farmácia'), (pg_temp.u('e004'), 'company', 'Energia');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true);
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  (pg_temp.u('a001'), pg_temp.u('c001'), 'checking', 'Corrente', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES (pg_temp.u('ca01'), 'expense', 'Saúde 62'), (pg_temp.u('ca10'), 'income', 'Vendas 62');
INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id, priority, origin) VALUES
  -- Aprendidas da correção: o padrão é a descrição normalizada.
  (pg_temp.u('b001'), pg_temp.u('c001'), pg_temp.u('a001'), 'contains', 'pix recebido cliente omega', 'in', pg_temp.u('e002'), 100, 'correction'),
  (pg_temp.u('b002'), pg_temp.u('c001'), pg_temp.u('a001'), 'contains', 'pag boleto cia energia', 'out', pg_temp.u('e004'), 100, 'correction'),
  -- Manuais com acento e pela descrição crua.
  (pg_temp.u('b003'), pg_temp.u('c001'), pg_temp.u('a001'), 'contains', 'Farmácia', 'out', pg_temp.u('e003'), 100, 'manual'),
  (pg_temp.u('b004'), pg_temp.u('c001'), pg_temp.u('a001'), 'exact', 'rendimento poupanca', 'in', pg_temp.u('e001'), 100, 'manual'),
  (pg_temp.u('b005'), pg_temp.u('c001'), pg_temp.u('a001'), 'starts_with', 'compra cartao', 'out', pg_temp.u('e003'), 100, 'manual'),
  (pg_temp.u('b006'), pg_temp.u('c001'), pg_temp.u('a001'), 'regex', '^pix recebido cliente omega$', 'in', pg_temp.u('e002'), 50, 'manual');

-- A regra aprendida casa com a própria linha só com a normalizada -------------------------------------------------------------
SELECT is(pg_temp.rule('PIX RECEBIDO Cliente Ômega', 1000), NULL, 'sem a normalizada, como antes: o padrão normalizado não casa');
SELECT is(pg_temp.rule('PIX RECEBIDO Cliente Ômega', 1000, 'pix recebido cliente omega'), pg_temp.u('b001'),
          'com a normalizada, a regra aprendida casa com a linha de onde nasceu (contains)');
SELECT is(pg_temp.rule('PAG BOLETO 0001234 CIA ENERGIA', -15000, 'pag boleto cia energia'), pg_temp.u('b002'),
          'número de documento no meio: casa pela normalizada');
SELECT is(pg_temp.rule('Rendimento poupança', 500, 'rendimento poupanca'), pg_temp.u('b004'), 'exact pela normalizada');
SELECT is(pg_temp.rule('COMPRA CARTAO - SUPERMERCADO X', -2000, 'compra cartao supermercado x'), pg_temp.u('b005'),
          'starts_with pela normalizada');
SELECT is(pg_temp.rule('COMPRA CARTAO - SUPERMERCADO X', -2000), pg_temp.u('b005'), 'starts_with pela crua continua');

-- A crua continua valendo e a ordem não muda ------------------------------------------------------------------------------------
SELECT is(pg_temp.rule('FARMÁCIA SÃO JOÃO', -3000, 'farmacia sao joao'), pg_temp.u('b003'),
          'regra manual com acento casa pela crua, mesmo passando a normalizada (que não tem o acento)');
SELECT is(pg_temp.rule('pix recebido cliente omega', 1000, 'pix recebido cliente omega'), pg_temp.u('b006'),
          'prioridade menor vence (a regex pela crua, antes da aprendida pela normalizada)');
SELECT is(pg_temp.rule('PIX RECEBIDO Cliente Ômega', 1000, 'pix recebido cliente omega'), pg_temp.u('b001'),
          'regex só na crua: a normalizada não faz a regex casar');
SELECT is(pg_temp.rule('PIX RECEBIDO Cliente Ômega', -1000, 'pix recebido cliente omega'), NULL, 'a direção continua filtrando');
SELECT throws_ok($$SELECT classification_rule_for(NULL, NULL, 'X', -1, 'x')$$, '22023', NULL, 'sem alvo');

SET LOCAL ROLE moneyflow_app;
SELECT is(classification_rule_for(pg_temp.u('a001'), NULL, 'PIX RECEBIDO Cliente Ômega', 1000, 'pix recebido cliente omega'),
          pg_temp.u('b001'), 'a aplicação chama com a normalizada');
SELECT is(classification_rule_for(pg_temp.u('a001'), NULL, 'FARMÁCIA SÃO JOÃO', -3000), pg_temp.u('b003'),
          'a chamada de quatro argumentos continua valendo');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
