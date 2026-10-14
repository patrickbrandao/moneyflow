-- Testes de 0046_telegram_inbound_bot_token (spec 029, tarefa 034): leitura do bot token para a entrada do Telegram
-- (destino ativo, não arquivado e com o hash do segredo do webhook; o hash gravado na mesma transação vale), 42501
-- nos outros casos, P0002 se o destino não existe, e moneyflow_app continua sem SELECT em bot_token.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

CREATE FUNCTION pg_temp.errmsg(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  m text;
  d text;
  h text;
BEGIN
  EXECUTE cmd;
  RETURN '';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
  RETURN concat_ws(' ', m, d, h);
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.errmsg(text) TO moneyflow_app;

-- Estrutura e privilégios --------------------------------------------------------------------------------------------
SELECT has_function('telegram_inbound_bot_token', ARRAY['uuid']);
SELECT function_returns('telegram_inbound_bot_token', ARRAY['uuid'], 'text');
SELECT is_definer('telegram_inbound_bot_token', ARRAY['uuid']);
SELECT volatility_is('telegram_inbound_bot_token', ARRAY['uuid'], 'stable');
SELECT ok((SELECT proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
             FROM pg_proc WHERE oid = 'telegram_inbound_bot_token(uuid)'::regprocedure),
          'search_path fixo');
SELECT ok(has_function_privilege('moneyflow_app', 'telegram_inbound_bot_token(uuid)', 'EXECUTE'),
          'app executa telegram_inbound_bot_token');
SELECT ok(NOT has_function_privilege('public', 'telegram_inbound_bot_token(uuid)', 'EXECUTE'),
          'public não executa telegram_inbound_bot_token');
SELECT ok(obj_description('telegram_inbound_bot_token(uuid)'::regprocedure, 'pg_proc') ~ 'spec 029',
          'comentário cita a spec 029');
SELECT ok(NOT has_column_privilege('moneyflow_app', 'message_destinations', 'bot_token', 'SELECT'),
          'app continua sem SELECT em bot_token');
SELECT ok(NOT has_column_privilege('moneyflow_app', 'message_destinations', 'webhook_secret_hash', 'SELECT'),
          'app continua sem SELECT em webhook_secret_hash');

-- Dados base ---------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000046a1', 'bia46', 'bia46@example.com', 'segredo', 'user', true);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000046f1', 'Provedor 46', 'anthropic', 'sk-ant-api03-aaaaaaaa');
INSERT INTO ai_agents (id, name, provider_id, model, is_active) VALUES
  ('00000000-0000-7000-8000-0000000046b1', 'Agente 46', '00000000-0000-7000-8000-0000000046f1', 'claude-sonnet-4-5', true);

-- d1: a ligar (sem hash ainda); d2: hash de uma ligação anterior, entrada desligada; d3: inativo com hash;
-- d4: arquivado com hash; d5: nunca ligado.
INSERT INTO message_destinations (id, name, owner_user_id, bot_token, chat_id, is_active, archived_at, webhook_secret_hash)
VALUES
  ('00000000-0000-7000-8000-0000000046d1', 'Ligando', '00000000-0000-7000-8000-0000000046a1',
   '460001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '111', true, NULL, NULL),
  ('00000000-0000-7000-8000-0000000046d2', 'Já ligado', '00000000-0000-7000-8000-0000000046a1',
   '460002:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '222', true, NULL, telegram_secret_hash('antigo')),
  ('00000000-0000-7000-8000-0000000046d3', 'Inativo', '00000000-0000-7000-8000-0000000046a1',
   '460003:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', '333', false, NULL, telegram_secret_hash('inativo')),
  ('00000000-0000-7000-8000-0000000046d4', 'Arquivado', '00000000-0000-7000-8000-0000000046a1',
   '460004:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', '444', false, now(), telegram_secret_hash('arquivado')),
  ('00000000-0000-7000-8000-0000000046d5', 'Nunca ligado', '00000000-0000-7000-8000-0000000046a1',
   '460005:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', '555', true, NULL, NULL);

-- Como a aplicação --------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;

SELECT is(pg_temp.err($$SELECT bot_token FROM message_destinations$$), '42501 ', 'app não lê bot_token direto');

-- Ligar: antes do hash é 42501; gravado o hash na mesma transação, a leitura enxerga.
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d1')$$), '42501 ',
          'antes de gravar o hash: 42501');
UPDATE message_destinations
   SET inbound_enabled = true, inbound_agent_id = '00000000-0000-7000-8000-0000000046b1',
       webhook_secret_hash = telegram_secret_hash('novo-segredo')
 WHERE id = '00000000-0000-7000-8000-0000000046d1';
SELECT is(telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d1'), '460001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          'entrada ligada: devolve o token (hash gravado na mesma transação)');

SELECT is(telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d2'), '460002:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          'entrada desligada com o hash de antes: devolve o token (deleteWebhook)');
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d3')$$), '42501 ',
          'destino inativo: 42501');
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d4')$$), '42501 ',
          'destino arquivado: 42501');
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d5')$$), '42501 ',
          'nunca ligado (sem hash): 42501');
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d9')$$), 'P0002 ',
          'destino inexistente: P0002');
SELECT ok(pg_temp.errmsg($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d5')$$)
            !~ 'EEEEEEEEEE', 'o erro não traz o token');

-- Desligar e desativar: a aplicação lê o token antes do UPDATE; depois de desativar, 42501.
SELECT is(telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d1'), '460001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          'lido antes de desativar');
UPDATE message_destinations SET inbound_enabled = false, is_active = false
 WHERE id = '00000000-0000-7000-8000-0000000046d1';
SELECT is(pg_temp.err($$SELECT telegram_inbound_bot_token('00000000-0000-7000-8000-0000000046d1')$$), '42501 ',
          'depois de desativar na mesma transação: 42501');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
