-- Testes de 0039_ai_prompts_and_instructions: instruções e caixa principal do usuário (user_ai_settings), versões do
-- prompt do agente (número pelo banco, inclusive com gravações concorrentes; imutáveis; a versão manda no system_prompt;
-- a versão 1 nasce no COMMIT; importação do backup), instructions dos servidores MCP, auditoria e o papel da aplicação.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS dblink;
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

-- Versões de um agente como texto "n:conteúdo,…".
CREATE FUNCTION pg_temp.versions(p_agent uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(version || ':' || content, ',' ORDER BY version), '')
    FROM ai_agent_prompt_versions WHERE agent_id = p_agent
$$;

-- Estrutura ----------------------------------------------------------------------------------------------------
SELECT has_table('user_ai_settings');
SELECT has_table('ai_agent_prompt_versions');
SELECT columns_are('user_ai_settings', ARRAY['user_id', 'instructions', 'primary_caixa_id', 'created_at', 'updated_at']);
SELECT columns_are('ai_agent_prompt_versions', ARRAY['id', 'agent_id', 'version', 'content', 'note', 'created_by_user_id',
                                                     'restored_from_version_id', 'created_at', 'updated_at']);
SELECT col_is_pk('user_ai_settings', 'user_id');
SELECT col_is_pk('ai_agent_prompt_versions', 'id');
SELECT col_default_is('user_ai_settings', 'instructions', '');
SELECT col_not_null('ai_agent_prompt_versions', c) FROM unnest(ARRAY['agent_id', 'version', 'content']) c;
SELECT fk_ok('user_ai_settings', 'user_id', 'users', 'id');
SELECT fk_ok('user_ai_settings', 'primary_caixa_id', 'caixas', 'id');
SELECT fk_ok('ai_agent_prompt_versions', 'agent_id', 'ai_agents', 'id');
SELECT fk_ok('ai_agent_prompt_versions', 'created_by_user_id', 'users', 'id');
SELECT fk_ok('ai_agent_prompt_versions', ARRAY['restored_from_version_id', 'agent_id'],
             'ai_agent_prompt_versions', ARRAY['id', 'agent_id']);
SELECT results_eq($$SELECT conname::text COLLATE "default", confdeltype::text FROM pg_constraint
                     WHERE contype = 'f' AND conrelid IN ('user_ai_settings'::regclass, 'ai_agent_prompt_versions'::regclass)
                     ORDER BY 1$$,
                  $$VALUES ('ai_agent_prompt_versions_agent_id_fkey', 'c'),
                           ('ai_agent_prompt_versions_created_by_user_id_fkey', 'n'),
                           ('ai_agent_prompt_versions_restored_from_version_id_fkey', 'a'),
                           ('user_ai_settings_primary_caixa_id_fkey', 'n'),
                           ('user_ai_settings_user_id_fkey', 'c')$$,
                  'FKs: CASCADE do agente e do usuário, SET NULL do autor e da caixa');
SELECT has_index('user_ai_settings', 'user_ai_settings_primary_caixa_id_idx');
SELECT has_index('ai_agent_prompt_versions', i) FROM unnest(ARRAY['ai_agent_prompt_versions_created_by_user_id_idx',
  'ai_agent_prompt_versions_restored_from_version_id_idx', 'ai_agent_prompt_versions_agent_version_key']) i;
SELECT has_trigger('user_ai_settings', t)
  FROM unnest(ARRAY['user_ai_settings_audit', 'user_ai_settings_set_updated_at', 'user_ai_settings_validate']) t;
SELECT has_trigger('ai_agent_prompt_versions', t)
  FROM unnest(ARRAY['ai_agent_prompt_versions_audit', 'ai_agent_prompt_versions_set_updated_at',
                    'ai_agent_prompt_versions_before_insert', 'ai_agent_prompt_versions_apply',
                    'ai_agent_prompt_versions_guard']) t;
SELECT has_trigger('ai_agents', t) FROM unnest(ARRAY['ai_agents_system_prompt_guard', 'ai_agents_prompt_version_init']) t;
SELECT results_eq($$SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'ai_agents_prompt_version_init'$$,
                  $$VALUES (true, true)$$, 'a versão 1 nasce no COMMIT (constraint trigger adiado)');
SELECT has_column('mcp_servers', c) FROM unnest(ARRAY['instructions_mode', 'instructions_cache']) c;
SELECT col_not_null('mcp_servers', 'instructions_mode');
SELECT col_default_is('mcp_servers', 'instructions_mode', 'ignore');
SELECT col_is_null('mcp_servers', 'instructions_cache');
SELECT has_column('effective_agent_mcp_servers', c) FROM unnest(ARRAY['instructions_mode', 'instructions_cache']) c;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' não executa ' || f)
  FROM unnest(ARRAY['public', 'moneyflow_app']) r,
       unnest(ARRAY['user_ai_settings_audit_row()', 'ai_agent_prompt_versions_audit_row()']) f;
SELECT ok(has_table_privilege('moneyflow_app', t, p), 'app: ' || p || ' em ' || t)
  FROM unnest(ARRAY['user_ai_settings', 'ai_agent_prompt_versions']) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
SELECT ok(has_column_privilege('moneyflow_app', 'mcp_servers', c, p), 'app: ' || p || ' em mcp_servers.' || c)
  FROM unnest(ARRAY['instructions_mode', 'instructions_cache']) c, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;
SELECT ok(NOT has_column_privilege('moneyflow_app', 'mcp_servers', 'secret_headers', 'SELECT'), 'app continua sem ler secret_headers');

-- Versões concorrentes (duas sessões de verdade, por dblink) ------------------------------------------------------
-- O agente é gravado fora desta transação (sessão c0, autocommit) e excluído no fim desta seção.
SELECT dblink_connect(c, format('dbname=%s user=%s', current_database(), current_user))
  FROM unnest(ARRAY['c0', 'c1', 'c2']) c;
SELECT dblink_exec('c0', $$INSERT INTO ai_agents (id, name, system_prompt, is_active)
                          VALUES ('00000000-0000-7000-8000-0000000d0f01', 'Concorrente 0039', 'base', false)$$);
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0f01'), '1:base', 'agente gravado em outra sessão nasce com a versão 1');
SELECT dblink_exec('c1', 'BEGIN');
SELECT dblink_exec('c1', $$INSERT INTO ai_agent_prompt_versions (agent_id, content) VALUES ('00000000-0000-7000-8000-0000000d0f01', 'A')$$);
SELECT dblink_send_query('c2', $$INSERT INTO ai_agent_prompt_versions (agent_id, content) VALUES ('00000000-0000-7000-8000-0000000d0f01', 'B')$$);
SELECT pg_sleep(0.3);
SELECT is(dblink_is_busy('c2'), 1, 'a segunda gravação espera a trava do agente');
SELECT dblink_exec('c1', 'COMMIT');
SELECT is((SELECT status FROM dblink_get_result('c2') AS r (status text)), 'INSERT 0 1', 'e grava depois do COMMIT da primeira');
SELECT is_empty($$SELECT * FROM dblink_get_result('c2') AS r (status text)$$, 'sem mais resultados');
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0f01'), '1:base,2:A,3:B', 'versões em sequência, sem colisão');
SELECT is((SELECT system_prompt FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0f01'), 'B',
          'system_prompt = a última versão gravada');
SELECT dblink_exec('c0', $$DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0f01'$$);
SELECT is_empty($$SELECT 1 FROM ai_agent_prompt_versions WHERE agent_id = '00000000-0000-7000-8000-0000000d0f01'$$,
                'excluir o agente leva as versões');
SELECT dblink_disconnect(c) FROM unnest(ARRAY['c0', 'c1', 'c2']) c;

-- Dados base -----------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000b2', 'bia', 'bia@example.com', 'segredo', 'user');
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Ana'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Banco Cartões');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Reserva', 'general', '00000000-0000-7000-8000-00000000e001', false);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Cartão', 'credit_card', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-0000000c0001', 100000, 3, 10, '1234');

-- Instruções e caixa principal do usuário --------------------------------------------------------------------------
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id, instructions, primary_caixa_id)
                        VALUES ('00000000-0000-7000-8000-0000000000a1', 'Responda curto.', '00000000-0000-7000-8000-0000000c0001')$$),
          'ok', 'instruções e caixa principal general');
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id) VALUES ('00000000-0000-7000-8000-0000000000a1')$$),
          '23505 user_ai_settings_pkey', 'uma linha por usuário');
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id, primary_caixa_id)
                        VALUES ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000c0010')$$),
          '23514 user_ai_settings_primary_caixa_check', 'caixa principal não pode ser cartão');
SELECT is(pg_temp.err($$UPDATE user_ai_settings SET primary_caixa_id = '00000000-0000-7000-8000-0000000c0010'
                         WHERE user_id = '00000000-0000-7000-8000-0000000000a1'$$),
          '23514 user_ai_settings_primary_caixa_check', 'nem ao trocar');
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id, primary_caixa_id)
                        VALUES ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000c0fff')$$),
          '23503 user_ai_settings_primary_caixa_id_fkey', 'caixa inexistente');
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id, instructions) VALUES ('00000000-0000-7000-8000-0000000000b2', repeat('i', 20001))$$),
          '23514 user_ai_settings_instructions_check', 'instruções até 20 mil');
SELECT is(pg_temp.err($$INSERT INTO user_ai_settings (user_id, instructions, primary_caixa_id)
                        VALUES ('00000000-0000-7000-8000-0000000000b2', repeat('i', 20000), '00000000-0000-7000-8000-0000000c0002')$$),
          'ok', '20 mil cabem');
SELECT is((SELECT instructions FROM user_ai_settings WHERE user_id = '00000000-0000-7000-8000-0000000000a1'), 'Responda curto.',
          'instruções gravadas');
SELECT lives_ok($$UPDATE user_ai_settings SET instructions = 'Responda curto e em tópicos.'
                   WHERE user_id = '00000000-0000-7000-8000-0000000000a1'$$, 'troca as instruções');
DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0002';
SELECT is((SELECT primary_caixa_id FROM user_ai_settings WHERE user_id = '00000000-0000-7000-8000-0000000000b2'), NULL,
          'caixa excluída: a escolha fica nula');

-- Auditoria (record_id = user_id, com o ator).
SELECT results_eq($$SELECT action, actor_kind, user_id FROM audit_log
                     WHERE table_name = 'user_ai_settings' AND record_id = '00000000-0000-7000-8000-0000000000a1' ORDER BY id$$,
                  $$VALUES ('insert', 'human', '00000000-0000-7000-8000-0000000000a1'::uuid),
                           ('update', 'human', '00000000-0000-7000-8000-0000000000a1'::uuid)$$,
                  'auditadas com record_id = user_id');
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'user_ai_settings' AND action = 'update'
            AND record_id = '00000000-0000-7000-8000-0000000000a1'), ARRAY['instructions'], 'troca das instruções: só instructions');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'user_ai_settings' AND action = 'update'
                    AND record_id = '00000000-0000-7000-8000-0000000000b2' AND changed_columns = ARRAY['primary_caixa_id']),
          'o SET NULL da caixa é auditado');
SELECT set_config('app.user_id', '', true);

-- A versão 1 nasce com o agente ---------------------------------------------------------------------------------
INSERT INTO ai_agents (id, name, system_prompt, is_active, created_by_user_id) VALUES
  ('00000000-0000-7000-8000-0000000d0001', 'Redator', 'Prompt inicial', false, '00000000-0000-7000-8000-0000000000b2'),
  ('00000000-0000-7000-8000-0000000d0002', 'Editado antes', 'Rascunho', false, NULL),
  ('00000000-0000-7000-8000-0000000d0003', 'Com nota', 'Com nota v1', false, NULL),
  ('00000000-0000-7000-8000-0000000d0004', 'Efêmero', 'x', false, NULL);
SELECT is_empty($$SELECT 1 FROM ai_agent_prompt_versions WHERE agent_id::text LIKE '00000000-0000-7000-8000-0000000d000_'$$,
                'antes do COMMIT o agente ainda não tem versão');
SELECT is(pg_temp.err($$UPDATE ai_agents SET system_prompt = 'Rascunho revisto' WHERE id = '00000000-0000-7000-8000-0000000d0002'$$),
          'ok', 'agente sem versão aceita trocar o prompt direto');
INSERT INTO ai_agent_prompt_versions (agent_id, content, note) VALUES
  ('00000000-0000-7000-8000-0000000d0003', 'Com nota v1', 'Criado pela tela');
DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0004';
SET CONSTRAINTS ai_agents_prompt_version_init IMMEDIATE;
SET CONSTRAINTS ai_agents_prompt_version_init DEFERRED;
SELECT results_eq($$SELECT agent_id, version, content, note, created_by_user_id FROM ai_agent_prompt_versions
                     WHERE agent_id::text LIKE '00000000-0000-7000-8000-0000000d000_' ORDER BY agent_id, version$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000d0001'::uuid, 1, 'Prompt inicial', NULL::text,
                            '00000000-0000-7000-8000-0000000000b2'::uuid),
                           ('00000000-0000-7000-8000-0000000d0002'::uuid, 1, 'Rascunho revisto', NULL, NULL),
                           ('00000000-0000-7000-8000-0000000d0003'::uuid, 1, 'Com nota v1', 'Criado pela tela', NULL)$$,
                  'no COMMIT: versão 1 com o prompt final e o autor do agente; a criada pela aplicação fica; o excluído, nada');

-- Número pelo banco e a versão manda --------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, content, created_by_user_id)
                        VALUES ('00000000-0000-7000-8000-0000000d0001', 'Prompt 2', '00000000-0000-7000-8000-0000000000a1')$$),
          'ok', 'versão nova sem número');
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0001'), '1:Prompt inicial,2:Prompt 2', 'recebe o próximo número');
SELECT is((SELECT system_prompt FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0001'), 'Prompt 2',
          'a versão nova vira o system_prompt');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, version, content) VALUES ('00000000-0000-7000-8000-0000000d0001', 2, 'x')$$),
          '23514 ai_agent_prompt_versions_version_check', 'número informado repetido é recusado');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, version, content) VALUES ('00000000-0000-7000-8000-0000000d0001', 4, 'x')$$),
          '23514 ai_agent_prompt_versions_version_check', 'número informado com buraco é recusado');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (id, agent_id, version, content, note, restored_from_version_id)
                        SELECT '00000000-0000-7000-8000-0000000d1003', '00000000-0000-7000-8000-0000000d0001', 3, v.content,
                               'Restaurada da versão 1', v.id
                          FROM ai_agent_prompt_versions v
                         WHERE v.agent_id = '00000000-0000-7000-8000-0000000d0001' AND v.version = 1$$),
          'ok', 'restaurar = versão nova (número informado = o próximo) apontando para a antiga');
SELECT is((SELECT system_prompt FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0001'), 'Prompt inicial',
          'o conteúdo restaurado volta ao agente');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, content, restored_from_version_id)
                        SELECT '00000000-0000-7000-8000-0000000d0001', 'x', v.id FROM ai_agent_prompt_versions v
                         WHERE v.agent_id = '00000000-0000-7000-8000-0000000d0002'$$),
          '23503 ai_agent_prompt_versions_restored_from_version_id_fkey', 'restaurar só do mesmo agente');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (id, agent_id, content, restored_from_version_id)
                        VALUES ('00000000-0000-7000-8000-0000000d1fff', '00000000-0000-7000-8000-0000000d0001', 'x',
                                '00000000-0000-7000-8000-0000000d1fff')$$),
          '23514 ai_agent_prompt_versions_restored_self_check', 'não restaura de si mesma');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, content) VALUES ('00000000-0000-7000-8000-0000000d0001', repeat('p', 200001))$$),
          '23514 ai_agent_prompt_versions_content_check', 'conteúdo até 200 mil');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, content, note) VALUES ('00000000-0000-7000-8000-0000000d0001', 'x', repeat('n', 501))$$),
          '23514 ai_agent_prompt_versions_note_check', 'nota até 500');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_prompt_versions (agent_id, content) VALUES ('00000000-0000-7000-8000-0000000d0fff', 'x')$$),
          '23503 ai_agent_prompt_versions_agent_id_fkey', 'agente inexistente');

-- system_prompt só muda pela versão.
SELECT is(pg_temp.err($$UPDATE ai_agents SET system_prompt = 'Direto' WHERE id = '00000000-0000-7000-8000-0000000d0001'$$),
          '23514 ai_agents_system_prompt_version_check', 'UPDATE direto do prompt é recusado');
SELECT is(pg_temp.err($$UPDATE ai_agents SET system_prompt = 'Prompt inicial', name = 'Redator chefe'
                         WHERE id = '00000000-0000-7000-8000-0000000d0001'$$),
          'ok', 'regravar o mesmo prompt junto com outros campos passa');
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0001'), '1:Prompt inicial,2:Prompt 2,3:Prompt inicial',
          'e não cria versão');

-- Imutáveis.
SELECT is(pg_temp.err($$UPDATE ai_agent_prompt_versions SET content = 'y' WHERE id = '00000000-0000-7000-8000-0000000d1003'$$),
          '23514 ai_agent_prompt_versions_immutable_check', 'conteúdo imutável');
SELECT is(pg_temp.err($$UPDATE ai_agent_prompt_versions SET note = 'outra' WHERE id = '00000000-0000-7000-8000-0000000d1003'$$),
          '23514 ai_agent_prompt_versions_immutable_check', 'nota imutável');
SELECT is(pg_temp.err($$UPDATE ai_agent_prompt_versions SET version = 9 WHERE id = '00000000-0000-7000-8000-0000000d1003'$$),
          '23514 ai_agent_prompt_versions_immutable_check', 'número imutável');
SELECT is(pg_temp.err($$UPDATE ai_agent_prompt_versions SET created_by_user_id = '00000000-0000-7000-8000-0000000000a1'
                         WHERE id = '00000000-0000-7000-8000-0000000d1003'$$),
          '23514 ai_agent_prompt_versions_immutable_check', 'autor imutável');
SELECT is(pg_temp.err($$DELETE FROM ai_agent_prompt_versions WHERE id = '00000000-0000-7000-8000-0000000d1003'$$),
          '23514 ai_agent_prompt_versions_immutable_check', 'não se exclui uma versão');

-- Importação do backup: o agente e as versões do arquivo entram juntos (ids e números preservados).
INSERT INTO ai_agents (id, name, system_prompt, is_active, created_by_user_id) VALUES
  ('00000000-0000-7000-8000-0000000d0005', 'Importado', 'Arquivo v2', false, '00000000-0000-7000-8000-0000000000a1'),
  ('00000000-0000-7000-8000-0000000d0006', 'Arquivo antigo', 'Sem histórico', false, '00000000-0000-7000-8000-0000000000a1');
INSERT INTO ai_agent_prompt_versions (id, agent_id, version, content, note, created_by_user_id, created_at) VALUES
  ('00000000-0000-7000-8000-0000000d5001', '00000000-0000-7000-8000-0000000d0005', 1, 'Arquivo v1', NULL,
   '00000000-0000-7000-8000-0000000000a1', '2026-01-02 10:00-03');
INSERT INTO ai_agent_prompt_versions (id, agent_id, version, content, note, created_by_user_id, restored_from_version_id, created_at) VALUES
  ('00000000-0000-7000-8000-0000000d5002', '00000000-0000-7000-8000-0000000d0005', 2, 'Arquivo v2', 'Ajuste',
   '00000000-0000-7000-8000-0000000000b2', NULL, '2026-02-03 10:00-03');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT results_eq($$SELECT id, version, content FROM ai_agent_prompt_versions
                     WHERE agent_id = '00000000-0000-7000-8000-0000000d0005' ORDER BY version$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000d5001'::uuid, 1, 'Arquivo v1'),
                           ('00000000-0000-7000-8000-0000000d5002'::uuid, 2, 'Arquivo v2')$$,
                  'importação: as versões do arquivo ficam, sem a versão 1 do banco');
SELECT is((SELECT system_prompt FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0005'), 'Arquivo v2',
          'importação: system_prompt = a última versão do arquivo');
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0006'), '1:Sem histórico',
          'arquivo sem versões: o agente ganha a versão 1 do prompt');

-- Autor excluído: a versão fica, sem autor.
DELETE FROM user_ai_settings WHERE user_id = '00000000-0000-7000-8000-0000000000b2';
UPDATE ai_agents SET created_by_user_id = NULL WHERE created_by_user_id = '00000000-0000-7000-8000-0000000000b2';
SELECT lives_ok($$DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000b2'$$, 'autor excluído');
SELECT is((SELECT count(*)::int FROM ai_agent_prompt_versions WHERE created_by_user_id IS NULL
            AND id IN ('00000000-0000-7000-8000-0000000d5002')), 1, 'a versão perde só o autor');
SELECT is(pg_temp.versions('00000000-0000-7000-8000-0000000d0001'), '1:Prompt inicial,2:Prompt 2,3:Prompt inicial',
          'o histórico do agente continua inteiro');

-- Auditoria das versões: sem o content.
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_agent_prompt_versions' AND action = 'insert'
            AND (new_data ->> 'agent_id')::uuid = '00000000-0000-7000-8000-0000000d0001'), 3, 'cada versão é auditada');
SELECT is_empty($$SELECT 1 FROM audit_log WHERE table_name = 'ai_agent_prompt_versions'
                    AND (old_data ? 'content' OR new_data ? 'content')$$, 'sem o content no audit_log');
SELECT is((SELECT (new_data ->> 'content_chars')::int FROM audit_log WHERE table_name = 'ai_agent_prompt_versions'
            AND record_id = '00000000-0000-7000-8000-0000000d1003'), length('Prompt inicial'), 'com content_chars');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_agents' AND record_id = '00000000-0000-7000-8000-0000000d0001'
                    AND changed_columns = ARRAY['system_prompt'] AND new_data ->> 'system_prompt' = 'Prompt 2'),
          'a troca do system_prompt pela versão fica na auditoria do agente');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_agent_prompt_versions' AND action = 'update'
                    AND record_id = '00000000-0000-7000-8000-0000000d5002' AND changed_columns = ARRAY['created_by_user_id']),
          'o SET NULL do autor é auditado');

-- Agente excluído leva as versões (inclusive as restauradas, que apontam para outras).
SELECT lives_ok($$DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0001'$$, 'agente sem uso é excluído');
SELECT is_empty($$SELECT 1 FROM ai_agent_prompt_versions WHERE agent_id = '00000000-0000-7000-8000-0000000d0001'$$,
                'com as versões');

-- Instructions dos servidores MCP -----------------------------------------------------------------------------------
INSERT INTO mcp_servers (id, name, url, visibility) VALUES
  ('00000000-0000-7000-8000-0000000c1001', 'docs', 'https://docs.example.com/mcp', 'global');
SELECT is((SELECT instructions_mode FROM mcp_servers WHERE id = '00000000-0000-7000-8000-0000000c1001'), 'ignore', 'modo padrão ignore');
SELECT is(pg_temp.err($$UPDATE mcp_servers SET instructions_mode = 'assistant' WHERE id = '00000000-0000-7000-8000-0000000c1001'$$),
          '23514 mcp_servers_instructions_mode_check', 'modo ignore|system|user');
SELECT is(pg_temp.err($$UPDATE mcp_servers SET instructions_mode = NULL WHERE id = '00000000-0000-7000-8000-0000000c1001'$$),
          '23502 ', 'modo obrigatório');
SELECT is(pg_temp.err($$UPDATE mcp_servers SET instructions_cache = repeat('c', 50001) WHERE id = '00000000-0000-7000-8000-0000000c1001'$$),
          '23514 mcp_servers_instructions_cache_check', 'cache até 50 mil');
SELECT is(pg_temp.err($$UPDATE mcp_servers SET tools_cache = '[]', tools_cached_at = now(), instructions_cache = repeat('c', 50000)
                         WHERE id = '00000000-0000-7000-8000-0000000c1001'$$), 'ok', '50 mil cabem');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'mcp_servers' AND action = 'update'
            AND record_id = '00000000-0000-7000-8000-0000000c1001'), 0, 'atualizar o cache não gera auditoria');
UPDATE mcp_servers SET instructions_mode = 'system' WHERE id = '00000000-0000-7000-8000-0000000c1001';
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'mcp_servers' AND action = 'update'
            AND record_id = '00000000-0000-7000-8000-0000000c1001'), ARRAY['instructions_mode'], 'trocar o modo é auditado');
SELECT results_eq($$SELECT instructions_mode, length(instructions_cache) FROM effective_agent_mcp_servers
                     WHERE agent_id = '00000000-0000-7000-8000-0000000d0005' AND mcp_server_id = '00000000-0000-7000-8000-0000000c1001'$$,
                  $$VALUES ('system', 50000)$$, 'a visão efetiva traz o modo e o cache');

-- O papel da aplicação ---------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO user_ai_settings (user_id, instructions) VALUES ('00000000-0000-7000-8000-0000000000a1', 'x')
                  ON CONFLICT (user_id) DO UPDATE SET instructions = EXCLUDED.instructions$$, 'app: grava as instruções (upsert)');
SELECT lives_ok($$SELECT user_id, instructions, primary_caixa_id FROM user_ai_settings$$, 'app: lê as configurações');
SELECT lives_ok($$INSERT INTO ai_agent_prompt_versions (agent_id, content, note)
                  VALUES ('00000000-0000-7000-8000-0000000d0005', 'Pelo app', 'Nota')$$, 'app: cria versão');
SELECT is((SELECT system_prompt FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000d0005'), 'Pelo app', 'app: o prompt acompanha');
SELECT throws_ok($$UPDATE ai_agents SET system_prompt = 'Direto' WHERE id = '00000000-0000-7000-8000-0000000d0005'$$,
                 '23514', NULL, 'app: UPDATE direto do prompt devolve 23514');
SELECT throws_ok($$DELETE FROM ai_agent_prompt_versions WHERE agent_id = '00000000-0000-7000-8000-0000000d0005'$$,
                 '23514', NULL, 'app: não exclui versão');
SELECT lives_ok($$SELECT id, name, instructions_mode, instructions_cache FROM mcp_servers$$, 'app: lê as colunas novas do MCP');
SELECT lives_ok($$UPDATE mcp_servers SET instructions_mode = 'user', instructions_cache = 'Use a busca.'
                   WHERE id = '00000000-0000-7000-8000-0000000c1001'$$, 'app: grava modo e cache');
SELECT throws_ok($$SELECT secret_headers FROM mcp_servers$$, '42501', NULL, 'app: cabeçalhos continuam negados');
SELECT lives_ok($$SELECT agent_id, instructions_mode, instructions_cache FROM effective_agent_mcp_servers$$, 'app: lê a visão efetiva');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
