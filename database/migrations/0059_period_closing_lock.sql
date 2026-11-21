-- migrate:up

-- Tarefa 145: fechar o mês espera as escritas em andamento na caixa, e quem escreve depois espera o fechamento e então
-- o vê. Uma trava consultiva por caixa (não por mês, para não encher a tabela de locks numa importação ou restauração):
-- compartilhada pelos escritores (os triggers de mês fechado e as linhas de lote provisório) e exclusiva para quem fecha
-- (INSERT em period_closings, antes da checagem do provisório). A leitura do fechamento vem numa instrução depois da
-- trava: no READ COMMITTED, cada instrução de uma função VOLATILE tira um snapshot novo e enxerga o fechamento
-- confirmado enquanto esperava.

CREATE FUNCTION period_lock_key(p_caixa_id uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('period_closing:' || p_caixa_id::text, 0)
$$;

COMMENT ON FUNCTION period_lock_key(uuid) IS
  'Chave do advisory lock do fechamento de mês da caixa (tarefa 145): compartilhado por quem escreve no período, '
  'exclusivo para quem fecha.';

CREATE FUNCTION period_lock_shared(p_caixa_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_caixa_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(period_lock_key(p_caixa_id));
  END IF;
END
$$;

COMMENT ON FUNCTION period_lock_shared(uuid) IS
  'Trava compartilhada (até o fim da transação) do fechamento de mês da caixa: quem escreve num período espera um '
  'fechamento em andamento na caixa e, depois, o enxerga na próxima instrução (tarefa 145). Escritores não se esperam.';

-- O assert passa a VOLATILE: a trava numa instrução e a leitura do fechamento na seguinte (snapshot novo).
CREATE OR REPLACE FUNCTION period_assert_open(p_caixa_id uuid, p_on date, p_what text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_caixa_id IS NULL OR p_on IS NULL THEN
    RETURN;
  END IF;
  PERFORM period_lock_shared(p_caixa_id);
  IF EXISTS (SELECT 1 FROM period_closings pc
              WHERE pc.caixa_id = p_caixa_id AND pc.month = date_trunc('month', p_on)::date) THEN
    RAISE EXCEPTION '%: month % is closed in caixa %', p_what, to_char(p_on, 'YYYY-MM'), p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
END
$$;

COMMENT ON FUNCTION period_assert_open(uuid, date, text) IS
  'Erro 23514 (period_closings_locked_check) se o mês da data está fechado na caixa. Antes de ler, toma a trava '
  'compartilhada do fechamento da caixa (period_lock_shared): um fechamento em andamento termina antes, e é visto.';

CREATE OR REPLACE FUNCTION financial_accounts_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM period_lock_shared(OLD.caixa_id);
  IF EXISTS (SELECT 1 FROM period_closings pc
              WHERE pc.caixa_id = OLD.caixa_id
                AND pc.month >= date_trunc('month', least(OLD.opening_date, NEW.opening_date))::date) THEN
    RAISE EXCEPTION 'financial_accounts: opening of account % falls in or before a closed month of caixa %',
      OLD.id, OLD.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
  RETURN NEW;
END
$$;

-- Quem fecha: trava exclusiva antes da checagem do provisório (period_closings_lock vem antes de
-- period_closings_provisional_check na ordem alfabética dos triggers BEFORE INSERT).
CREATE FUNCTION period_closings_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(period_lock_key(NEW.caixa_id));
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION period_closings_lock() IS
  'Trigger de period_closings (INSERT): trava exclusiva do fechamento da caixa até o fim da transação. Espera as '
  'escritas em andamento na caixa (que têm a trava compartilhada) e faz as seguintes esperarem o fechamento (tarefa 145).';

CREATE TRIGGER period_closings_lock BEFORE INSERT ON period_closings
  FOR EACH ROW EXECUTE FUNCTION period_closings_lock();

-- Lote provisório: a linha inserida num provisório ativo e o lote que vira provisório também esperam o fechamento
-- (a checagem do mês fechado delas está em statement_lines_supersede_validate e statement_imports_supersede_validate,
-- que vêm depois na ordem alfabética dos triggers BEFORE).
CREATE FUNCTION statement_lines_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  caixa uuid;
BEGIN
  SELECT a.caixa_id INTO caixa
    FROM statement_imports i JOIN financial_accounts a ON a.id = i.financial_account_id
   WHERE i.id = NEW.statement_import_id AND i.provisional AND i.superseded_by_import_id IS NULL;
  PERFORM period_lock_shared(caixa);
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION statement_lines_period_lock() IS
  'Trigger de statement_lines (INSERT): a linha de lote provisório ativo toma a trava compartilhada do fechamento da '
  'caixa da conta antes da checagem do mês fechado (tarefa 145).';

CREATE TRIGGER statement_lines_period_lock BEFORE INSERT ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION statement_lines_period_lock();

CREATE FUNCTION statement_imports_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM period_lock_shared(a.caixa_id) FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION statement_imports_period_lock() IS
  'Trigger de statement_imports (UPDATE que marca o lote como provisório): trava compartilhada do fechamento da caixa '
  'da conta antes da checagem das linhas em mês fechado (tarefa 145).';

CREATE TRIGGER statement_imports_period_lock BEFORE UPDATE OF provisional ON statement_imports
  FOR EACH ROW WHEN (NEW.provisional AND NOT OLD.provisional) EXECUTE FUNCTION statement_imports_period_lock();

-- migrate:down

DROP TRIGGER statement_imports_period_lock ON statement_imports;
DROP FUNCTION statement_imports_period_lock();
DROP TRIGGER statement_lines_period_lock ON statement_lines;
DROP FUNCTION statement_lines_period_lock();
DROP TRIGGER period_closings_lock ON period_closings;
DROP FUNCTION period_closings_lock();

CREATE OR REPLACE FUNCTION financial_accounts_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM period_closings pc
              WHERE pc.caixa_id = OLD.caixa_id
                AND pc.month >= date_trunc('month', least(OLD.opening_date, NEW.opening_date))::date) THEN
    RAISE EXCEPTION 'financial_accounts: opening of account % falls in or before a closed month of caixa %',
      OLD.id, OLD.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION period_assert_open(p_caixa_id uuid, p_on date, p_what text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_caixa_id IS NOT NULL AND p_on IS NOT NULL AND period_is_closed(p_caixa_id, p_on) THEN
    RAISE EXCEPTION '%: month % is closed in caixa %', p_what, to_char(p_on, 'YYYY-MM'), p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
END
$$;

COMMENT ON FUNCTION period_assert_open(uuid, date, text) IS
  'Erro 23514 (period_closings_locked_check) se o mês da data está fechado na caixa.';

DROP FUNCTION period_lock_shared(uuid);
DROP FUNCTION period_lock_key(uuid);
