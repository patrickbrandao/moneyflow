-- Testes de 0061_recurrence_occurrence_lock (tarefa 149): a ocorrência nova de uma série trava a regra (FOR SHARE) antes de
-- conferir o total de parcelas. O pgTAP roda numa sessão só: confere a trava pela marca na linha da regra e as regras de
-- ocorrência × total; a espera entre duas sessões foi conferida à mão (tasks/149).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000061' || p)::uuid $$;
-- Modos de trava da linha da regra (pgrowlocks, só nesta transação de teste). A FK do título já trava a regra com
-- FOR KEY SHARE; a ocorrência nova acrescenta FOR SHARE, que conflita com a redução do total (UPDATE/FOR UPDATE).
CREATE EXTENSION IF NOT EXISTS pgrowlocks;
CREATE FUNCTION pg_temp.rule_lock_modes(p_rule uuid) RETURNS text[]
LANGUAGE sql AS $$
  SELECT coalesce((SELECT l.modes FROM pgrowlocks('recurrence_rules') l
                    WHERE l.locked_row = (SELECT r.ctid FROM recurrence_rules r WHERE r.id = p_rule)), '{}')
$$;

INSERT INTO entities (id, kind, name) VALUES (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Escola');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true);
INSERT INTO categories (id, kind, name) VALUES (pg_temp.u('ca01'), 'expense', 'Escola 61');
INSERT INTO recurrence_rules (id, caixa_id, frequency, anchor_day, starts_on, installments_total) VALUES
  (pg_temp.u('d001'), pg_temp.u('c001'), 'monthly', 10, '2026-01-10', 3);
CREATE FUNCTION pg_temp.occ(p_n int) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, recurrence_rule_id, occurrence)
  VALUES (pg_temp.u('70' || lpad(p_n::text, 2, '0')), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'),
          'Escola', make_date(2026, p_n, 1), make_date(2026, p_n, 10), 1000, 'recurrence', pg_temp.u('d001'), p_n)
$$;
SELECT pg_temp.commit_check();
SELECT is(pg_temp.rule_lock_modes(pg_temp.u('d001')), '{}'::text[], 'antes da ocorrência, a regra não está travada');

SELECT lives_ok($$SELECT pg_temp.occ(1)$$, 'ocorrência 1 de 3');
SELECT ok('For Share' = ANY (pg_temp.rule_lock_modes(pg_temp.u('d001'))),
          'a ocorrência nova trava a regra com FOR SHARE (não só o FOR KEY SHARE da FK) até o fim da transação');
SELECT lives_ok($$SELECT pg_temp.occ(2); SELECT pg_temp.occ(3)$$, 'ocorrências 2 e 3');
SELECT throws_ok($$SELECT pg_temp.occ(4)$$, '23514', 'titles: occurrence 4 exceeds installments total 3',
                 'ocorrência acima do total continua recusada');
SELECT throws_ok($$UPDATE recurrence_rules SET installments_total = 2 WHERE id = pg_temp.u('d001')$$, '23514', NULL,
                 'reduzir o total abaixo de uma ocorrência continua recusado (a mesma transação não espera a própria trava)');
SELECT lives_ok($$UPDATE titles SET description = 'Escola (editada)' WHERE id = pg_temp.u('7001')$$,
                'editar a ocorrência sem mudar série nem número continua livre');
SELECT lives_ok($$UPDATE recurrence_rules SET installments_total = 5 WHERE id = pg_temp.u('d001')$$, 'aumentar o total');
SELECT lives_ok($$SELECT pg_temp.occ(4)$$, 'ocorrência 4 de 5');
SELECT pg_temp.commit_check();

SELECT * FROM finish();
ROLLBACK;
