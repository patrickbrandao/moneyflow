-- Testes de 0072_mirror_unlink_settlement_legs (tarefa 148, complemento): desligar ou trocar o espelho de um título com
-- baixas ligadas exige soltar as pernas na mesma transação (settlements_mirror_title_check no COMMIT).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Roda o SQL, força as checagens do COMMIT e devolve "SQLSTATE constraint" (ou 'ok'). Em erro, desfaz. Para desfazer um
-- caso aceito, termine o SQL com "SELECT 1/0" (devolve '22012 -').
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE p_sql;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(nullif(cn, ''), '-');
END
$$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000072' || p)::uuid $$;

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Empresa');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true),
  (pg_temp.u('c002'), 'Empresa', 'general', pg_temp.u('e002'), true);
INSERT INTO categories (id, kind, name) VALUES (pg_temp.u('ca01'), 'expense', 'Despesa 72'), (pg_temp.u('ca02'), 'income', 'Receita 72');

-- Par P (7001 ↔ 7002) com uma baixa de duas pernas; par Q (7011 ↔ 7012) sem baixa; 7003, um título que poderia ser o
-- espelho novo de 7001.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  (pg_temp.u('7001'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'P', '2026-10-01', '2026-10-10', 1000,
   pg_temp.u('c002'), pg_temp.u('7002'), NULL),
  (pg_temp.u('7002'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'P', '2026-10-01', '2026-10-10', 1000,
   pg_temp.u('c001'), pg_temp.u('7001'), 'accepted'),
  (pg_temp.u('7011'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'Q', '2026-10-01', '2026-10-10', 500,
   pg_temp.u('c002'), pg_temp.u('7012'), NULL),
  (pg_temp.u('7012'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'Q', '2026-10-01', '2026-10-10', 500,
   pg_temp.u('c001'), pg_temp.u('7011'), 'accepted');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  (pg_temp.u('7003'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'P', '2026-10-01', '2026-10-10', 1000);
INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
  (pg_temp.u('d001'), pg_temp.u('7001'), '2026-10-10', 400, pg_temp.u('d002')),
  (pg_temp.u('d002'), pg_temp.u('7002'), '2026-10-10', 400, pg_temp.u('d001'));
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'dados base coerentes');

CREATE TEMP TABLE unlink_sql AS SELECT $$
  UPDATE titles SET counterparty_caixa_id = NULL, mirror_title_id = NULL, mirror_status = NULL
   WHERE id IN (pg_temp.u('7001'), pg_temp.u('7002'));
$$::text AS q;

-- Desligar o par --------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err((SELECT q FROM unlink_sql)), '23514 settlements_mirror_title_check',
          'desligar o par com as pernas da baixa ainda ligadas é recusado');
SELECT is(pg_temp.err((SELECT q FROM unlink_sql) || $$
                       UPDATE settlements SET mirror_settlement_id = NULL WHERE id IN (pg_temp.u('d001'), pg_temp.u('d002'));
                       SELECT 1/0$$),
          '22012 -', 'desligar o par e soltar as pernas na mesma transação passa');
SELECT is(pg_temp.err($$UPDATE titles SET counterparty_caixa_id = NULL, mirror_title_id = NULL, mirror_status = NULL
                         WHERE id IN (pg_temp.u('7011'), pg_temp.u('7012')); SELECT 1/0$$),
          '22012 -', 'par sem baixa desliga como antes');

-- Trocar o espelho de um lado ---------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE titles SET counterparty_caixa_id = NULL, mirror_title_id = NULL, mirror_status = NULL
                         WHERE id = pg_temp.u('7002');
                       UPDATE titles SET mirror_title_id = pg_temp.u('7003') WHERE id = pg_temp.u('7001');
                       UPDATE titles SET counterparty_caixa_id = pg_temp.u('c001'), mirror_title_id = pg_temp.u('7001'),
                                         mirror_status = 'accepted' WHERE id = pg_temp.u('7003')$$),
          '23514 settlements_mirror_title_check', 'trocar o espelho com a perna da baixa no espelho antigo é recusado');

-- Estornada também: a perna estornada continua ligada ao par.
UPDATE settlements SET reversed_at = now(), reversal_reason = 'teste' WHERE id IN (pg_temp.u('d001'), pg_temp.u('d002'));
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'estorno das duas pernas');
SELECT is(pg_temp.err((SELECT q FROM unlink_sql)), '23514 settlements_mirror_title_check',
          'baixa estornada com as pernas ligadas também impede desligar só o par');

-- O resto de titles_mirror_check continua valendo.
SELECT is(pg_temp.err($$UPDATE titles SET mirror_title_id = NULL, counterparty_caixa_id = NULL WHERE id = pg_temp.u('7011')$$),
          '23514 titles_mirror_reciprocal_check', 'desligar um lado só continua recusado');
SELECT is(pg_temp.err($$UPDATE titles SET amount_cents = 1100 WHERE id = pg_temp.u('7001')$$),
          '23514 titles_mirror_match_check', 'valor diferente no par continua recusado');

SELECT * FROM finish();
ROLLBACK;
