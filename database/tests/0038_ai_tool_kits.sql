-- Testes de 0038_ai_tool_kits: kits de ferramentas (nome único, modo allow|ask, RESTRICT do kit em uso), o retrato
-- fixo das 49 tools da v0.1.7, a migração de enabled_tools/require_write_confirmation, a saída das duas colunas,
-- a auditoria e o papel da aplicação.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Executa um comando e devolve "SQLSTATE constraint" do erro (ou 'ok').
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

-- Nome do kit criado pela função da migração (em plpgsql: cada comando enxerga o que o anterior inseriu).
CREATE FUNCTION pg_temp.legacy_kit_name(p_agent text, p_tools text[], p_flag boolean) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  kid uuid := ai_tool_kit_from_legacy(p_agent, p_tools, p_flag);
BEGIN
  RETURN (SELECT name FROM ai_tool_kits WHERE id = kid);
END
$$;

-- Tools de um kit como texto ordenado "nome:modo,…".
CREATE FUNCTION pg_temp.kit_tools(p_kit uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(tool_name || ':' || mode, ',' ORDER BY tool_name), '')
    FROM ai_tool_kit_tools WHERE kit_id = p_kit
$$;

-- Estrutura ----------------------------------------------------------------------------------------------------
SELECT has_table('ai_tool_kits');
SELECT has_table('ai_tool_kit_tools');
SELECT columns_are('ai_tool_kits', ARRAY['id', 'name', 'description', 'created_by_user_id', 'created_at', 'updated_at']);
SELECT columns_are('ai_tool_kit_tools', ARRAY['kit_id', 'tool_name', 'mode', 'created_at', 'updated_at']);
SELECT col_is_pk('ai_tool_kit_tools', ARRAY['kit_id', 'tool_name']);
SELECT has_column('ai_agents', 'tool_kit_id');
SELECT col_is_null('ai_agents', 'tool_kit_id');
SELECT hasnt_column('ai_agents', 'enabled_tools');
SELECT hasnt_column('ai_agents', 'require_write_confirmation');
SELECT fk_ok('ai_tool_kit_tools', 'kit_id', 'ai_tool_kits', 'id');
SELECT fk_ok('ai_agents', 'tool_kit_id', 'ai_tool_kits', 'id');
SELECT fk_ok('ai_tool_kits', 'created_by_user_id', 'users', 'id');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'ai_tool_kit_tools'::regclass
            AND confrelid = 'ai_tool_kits'::regclass), 'c', 'tools do kit: CASCADE');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'ai_agents'::regclass
            AND confrelid = 'ai_tool_kits'::regclass), 'a', 'kit do agente restringe (NO ACTION: 23503, não 23001)');
SELECT has_index('ai_tool_kits', 'ai_tool_kits_name_key');
SELECT has_index('ai_tool_kits', 'ai_tool_kits_created_by_user_id_idx');
SELECT has_index('ai_agents', 'ai_agents_tool_kit_id_idx');
SELECT has_trigger('ai_tool_kits', t) FROM unnest(ARRAY['ai_tool_kits_audit', 'ai_tool_kits_set_updated_at']) t;
SELECT has_trigger('ai_tool_kit_tools', t) FROM unnest(ARRAY['ai_tool_kit_tools_audit', 'ai_tool_kit_tools_set_updated_at']) t;
SELECT has_function('ai_legacy_tool_registry', ARRAY[]::text[]);
SELECT has_function('ai_tool_kit_from_legacy', ARRAY['text', 'text[]', 'boolean']);
SELECT ok(has_function_privilege('moneyflow_app', 'ai_legacy_tool_registry()', 'EXECUTE'), 'app lê o retrato');
SELECT ok(NOT has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app não executa ' || f)
  FROM unnest(ARRAY['ai_tool_kit_from_legacy(text, text[], boolean)', 'ai_tool_kit_tools_audit_row()']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['ai_tool_kit_from_legacy(text, text[], boolean)', 'ai_tool_kit_tools_audit_row()']) f;
SELECT ok(has_table_privilege('moneyflow_app', t, p), 'app: ' || p || ' em ' || t)
  FROM unnest(ARRAY['ai_tool_kits', 'ai_tool_kit_tools']) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;

-- Retrato fixo da v0.1.7 ----------------------------------------------------------------------------------------
SELECT results_eq($$SELECT count(*)::int, count(*) FILTER (WHERE kind = 'read')::int, count(*) FILTER (WHERE kind = 'write')::int,
                           count(DISTINCT tool_name)::int FROM ai_legacy_tool_registry()$$,
                  $$VALUES (49, 25, 24, 49)$$, '49 tools: 25 leituras, 24 escritas, sem repetição');
SELECT results_eq($$SELECT tool_name, kind, confirm FROM ai_legacy_tool_registry() WHERE confirm <> 'agent' AND kind = 'write' ORDER BY 1$$,
                  $$VALUES ('notify_user', 'write', 'never'), ('send_telegram_message', 'write', 'always')$$,
                  'escritas com confirm fixo: notify_user never, send_telegram_message always');
SELECT is_empty($$SELECT 1 FROM ai_legacy_tool_registry() WHERE kind = 'read' AND confirm <> 'never'$$, 'leitura nunca confirma');
SELECT ok(ai_tool_list_valid((SELECT array_agg(tool_name) FROM ai_legacy_tool_registry())), 'nomes no formato de tool');

-- Dados base -----------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin');
INSERT INTO ai_tool_kits (id, name, description, created_by_user_id) VALUES
  ('00000000-0000-7000-8000-0000000b0001', 'Conciliação', 'Só conciliação.', '00000000-0000-7000-8000-0000000000a1'),
  ('00000000-0000-7000-8000-0000000b0002', 'Sem uso', NULL, NULL);
INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES
  ('00000000-0000-7000-8000-0000000b0001', 'list_statement_imports', 'allow'),
  ('00000000-0000-7000-8000-0000000b0001', 'match_statement_line', 'ask'),
  ('00000000-0000-7000-8000-0000000b0002', 'list_titles', 'ask');

-- Nome, descrição e modo ---------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kits (name) VALUES ('CONCILIAÇÃO')$$), '23505 ai_tool_kits_name_key',
          'nome único sem distinção de maiúsculas');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kits (name) VALUES ('   ')$$), '23514 ai_tool_kits_name_check', 'nome vazio');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kits (name) VALUES (repeat('k', 121))$$), '23514 ai_tool_kits_name_check',
          'nome até 120');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kits (name) VALUES (repeat('k', 120))$$), 'ok', '120 caracteres cabem');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kits (name, description) VALUES ('Longo', repeat('d', 2001))$$),
          '23514 ai_tool_kits_description_check', 'descrição até 2000');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0002', 'get_title', 'deny')$$),
          '23514 ai_tool_kit_tools_mode_check', 'modo allow|ask');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name) VALUES ('00000000-0000-7000-8000-0000000b0002', 'get_title')$$),
          '23502 ', 'modo obrigatório (sem padrão)');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0002', 'com espaço', 'allow')$$),
          '23514 ai_tool_kit_tools_tool_name_check', 'nome no formato de tool');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0002', repeat('t', 129), 'allow')$$),
          '23514 ai_tool_kit_tools_tool_name_check', 'nome até 128');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0002', 'list_titles', 'allow')$$),
          '23505 ai_tool_kit_tools_pkey', 'uma linha por tool no kit');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0fff', 'list_titles', 'allow')$$),
          '23503 ai_tool_kit_tools_kit_id_fkey', 'kit inexistente');
SELECT is(pg_temp.err($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0002', 'tool_futura', 'allow')$$),
          'ok', 'o banco não confere o registro (a aplicação confere)');
SELECT lives_ok($$UPDATE ai_tool_kit_tools SET mode = 'allow' WHERE kit_id = '00000000-0000-7000-8000-0000000b0001'
                   AND tool_name = 'match_statement_line'$$, 'troca o modo');

-- Kit em uso -----------------------------------------------------------------------------------------------------
INSERT INTO ai_agents (id, name, is_active, tool_kit_id) VALUES
  ('00000000-0000-7000-8000-0000000b1001', 'Conciliador', false, '00000000-0000-7000-8000-0000000b0001'),
  ('00000000-0000-7000-8000-0000000b1002', 'Conciliador antigo', false, '00000000-0000-7000-8000-0000000b0001');
SELECT is(pg_temp.err($$DELETE FROM ai_tool_kits WHERE id = '00000000-0000-7000-8000-0000000b0001'$$),
          '23503 ai_agents_tool_kit_id_fkey', 'kit em uso não é excluído');
UPDATE ai_agents SET tool_kit_id = NULL WHERE id = '00000000-0000-7000-8000-0000000b1001';
UPDATE ai_agents SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000b1002';
SELECT is(pg_temp.err($$DELETE FROM ai_tool_kits WHERE id = '00000000-0000-7000-8000-0000000b0001'$$),
          '23503 ai_agents_tool_kit_id_fkey', 'kit usado só por agente arquivado também não');
SELECT is(pg_temp.err($$INSERT INTO ai_agents (name, is_active, tool_kit_id) VALUES ('Fantasma', false, '00000000-0000-7000-8000-0000000b0fff')$$),
          '23503 ai_agents_tool_kit_id_fkey', 'agente aponta para kit existente');
SELECT lives_ok($$DELETE FROM ai_tool_kits WHERE id = '00000000-0000-7000-8000-0000000b0002'$$, 'kit sem agentes é excluído');
SELECT is_empty($$SELECT 1 FROM ai_tool_kit_tools WHERE kit_id = '00000000-0000-7000-8000-0000000b0002'$$, 'e leva as tools junto');

-- Migração de enabled_tools / require_write_confirmation -------------------------------------------------------
-- Caso 1: lista não nula, flag true. Nomes fora do retrato são descartados; notify_user fica allow, a mensagem ask.
SELECT is(pg_temp.kit_tools(ai_tool_kit_from_legacy('Caixa Casa',
            '{list_titles,create_title,send_telegram_message,notify_user,tool_removida}', true)),
          'create_title:ask,list_titles:allow,notify_user:allow,send_telegram_message:ask',
          'lista + flag true: as tools da lista, ask nas escritas que confirmavam');
SELECT is((SELECT description FROM ai_tool_kits WHERE name = 'Kit – Caixa Casa'),
          'Criado na migração para kits (F7) a partir da configuração do agente "Caixa Casa".', 'nome e descrição do kit');
SELECT is((SELECT created_by_user_id FROM ai_tool_kits WHERE name = 'Kit – Caixa Casa'), NULL, 'criado pela migração');

-- Lista não nula, flag false: só a mensagem do Telegram pede confirmação.
SELECT is(pg_temp.kit_tools(ai_tool_kit_from_legacy('Sem confirmação', '{list_titles,create_title,send_telegram_message}', false)),
          'create_title:allow,list_titles:allow,send_telegram_message:ask', 'lista + flag false: só o Telegram em ask');

-- Lista vazia: kit vazio (o agente continua sem tools).
SELECT ok(ai_tool_kit_from_legacy('Mudo', '{}', false) IS NOT NULL, 'lista vazia ganha kit');
SELECT is(pg_temp.kit_tools((SELECT id FROM ai_tool_kits WHERE name = 'Kit – Mudo')), '', 'kit vazio = nenhuma tool');

-- Caso 2: lista nula, flag true: todas as 49, ask nas 23 escritas que confirmavam.
CREATE TEMP TABLE legacy_all AS SELECT ai_tool_kit_from_legacy('Assistente geral', NULL, true) AS id;
SELECT results_eq($$
  SELECT count(*)::int, count(*) FILTER (WHERE t.mode = 'ask')::int,
         count(*) FILTER (WHERE t.mode = 'ask' AND r.kind = 'read')::int,
         bool_and(t.mode = 'allow') FILTER (WHERE t.tool_name = 'notify_user')
    FROM legacy_all k JOIN ai_tool_kit_tools t ON t.kit_id = k.id JOIN ai_legacy_tool_registry() r USING (tool_name)
$$, $$VALUES (49, 23, 0, true)$$, 'lista nula + flag true: 49 tools, 23 em ask (escritas menos notify_user)');

-- Caso 3: lista nula, flag false: sem kit.
SELECT is(ai_tool_kit_from_legacy('Livre', NULL, false), NULL, 'lista nula + flag false: sem kit');
SELECT is_empty($$SELECT 1 FROM ai_tool_kits WHERE name LIKE '%Livre%'$$, 'nenhum kit criado');

-- Comportamento: ninguém ganha nem perde poder (reproduz needsConfirmation da v0.1.7 em cada combinação).
CREATE TEMP TABLE legacy_cfg AS
  SELECT c.*, ai_tool_kit_from_legacy(c.agent, c.tools, c.flag) AS kit_id
    FROM (VALUES ('Cfg A', NULL::text[], true),
                 ('Cfg B', '{get_title,settle_title,notify_user,send_telegram_message,list_titles}'::text[], true),
                 ('Cfg C', '{get_title,settle_title,notify_user,send_telegram_message}'::text[], false),
                 ('Cfg D', '{}'::text[], true)) AS c (agent, tools, flag);
SELECT is_empty($$
  SELECT k.agent, r.tool_name
    FROM legacy_cfg k CROSS JOIN ai_legacy_tool_registry() r
    LEFT JOIN ai_tool_kit_tools t ON t.kit_id = k.kit_id AND t.tool_name = r.tool_name
   WHERE (t.tool_name IS NOT NULL) <> (k.tools IS NULL OR r.tool_name = ANY (k.tools))
      OR (t.tool_name IS NOT NULL AND (t.mode = 'ask') <> (r.confirm = 'always' OR (r.kind = 'write' AND r.confirm = 'agent' AND k.flag)))
$$, 'cada tool fica no kit se e só se estava liberada, e em ask se e só se pedia confirmação');

-- Nome do kit: truncado em 120 e com sufixo numérico se colidir (sem distinção de maiúsculas).
SELECT is(pg_temp.legacy_kit_name(repeat('a', 117) || 'XYZ', '{}', true),
          'Kit – ' || repeat('a', 114), 'nome truncado em 120');
SELECT is(pg_temp.legacy_kit_name(repeat('A', 117) || 'QRS', '{}', true),
          'Kit – ' || repeat('A', 110) || ' (2)', 'colisão depois de truncar: sufixo (2) dentro dos 120');
SELECT is(pg_temp.legacy_kit_name(repeat('a', 120), '{}', true),
          'Kit – ' || repeat('a', 110) || ' (3)', 'e (3) na seguinte');
SELECT is(pg_temp.legacy_kit_name('caixa casa', '{}', true),
          'Kit – caixa casa (2)', 'colisão sem distinção de maiúsculas');
SELECT is(pg_temp.legacy_kit_name('Fim com espaço' || repeat(' ', 2), '{}', true),
          'Kit – Fim com espaço', 'sem espaços nas pontas');

-- Auditoria ------------------------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_tool_kits' AND record_id = '00000000-0000-7000-8000-0000000b0001'
                    AND action = 'insert'), 'criar o kit é auditado');
SELECT results_eq($$SELECT action, new_data ->> 'tool_name' FROM audit_log
                     WHERE table_name = 'ai_tool_kit_tools' AND record_id = '00000000-0000-7000-8000-0000000b0001'
                     ORDER BY id$$,
                  $$VALUES ('insert', 'list_statement_imports'), ('insert', 'match_statement_line'), ('update', 'match_statement_line')$$,
                  'tools do kit auditadas com record_id = kit_id');
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'ai_tool_kit_tools' AND action = 'update'
            AND record_id = '00000000-0000-7000-8000-0000000b0001'), ARRAY['mode'], 'troca de modo: só mode');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_tool_kit_tools' AND action = 'delete'
                    AND record_id = '00000000-0000-7000-8000-0000000b0002' AND old_data ->> 'tool_name' = 'list_titles'),
          'a cascata da exclusão do kit é auditada');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_agents' AND record_id = '00000000-0000-7000-8000-0000000b1001'
                    AND changed_columns = ARRAY['tool_kit_id']), 'trocar o kit do agente é auditado');
UPDATE ai_tool_kit_tools SET updated_at = now() - interval '1 day' WHERE kit_id = '00000000-0000-7000-8000-0000000b0001';
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_tool_kit_tools' AND action = 'update'), 1,
          'só updated_at não gera linha');

-- O papel da aplicação ---------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO ai_tool_kits (id, name) VALUES ('00000000-0000-7000-8000-0000000b0003', 'Pelo app')$$, 'app: cria kit');
SELECT lives_ok($$INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode) VALUES ('00000000-0000-7000-8000-0000000b0003', 'get_title', 'ask')$$,
                'app: inclui tool');
SELECT lives_ok($$UPDATE ai_agents SET tool_kit_id = '00000000-0000-7000-8000-0000000b0003' WHERE id = '00000000-0000-7000-8000-0000000b1001'$$,
                'app: liga o kit ao agente');
SELECT lives_ok($$SELECT tool_name, kind, confirm FROM ai_legacy_tool_registry()$$, 'app: lê o retrato');
SELECT throws_ok($$SELECT ai_tool_kit_from_legacy('x', NULL, true)$$, '42501', NULL, 'app: não cria kit pela função da migração');
SELECT throws_ok($$DELETE FROM ai_tool_kits WHERE id = '00000000-0000-7000-8000-0000000b0003'$$, '23503', NULL,
                 'app: kit em uso devolve 23503');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
