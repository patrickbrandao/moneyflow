-- Testes de 0030_audit_agent_run: o ator agente na auditoria aponta para uma execução do mesmo usuário.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-abcdefgh');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5');
INSERT INTO ai_conversations (id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick');

-- Agente agindo pela execução do próprio usuário
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a2', true),
       set_config('app.actor_kind', 'agent', true),
       set_config('app.agent_run_id', '00000000-0000-7000-8000-0000000B2001', true);
UPDATE entities SET notes = 'via agente' WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT results_eq($$SELECT actor_kind, user_id, agent_run_id FROM audit_log
                     WHERE table_name = 'entities' AND changed_columns @> ARRAY['notes']$$,
                  $$VALUES ('agent', '00000000-0000-7000-8000-0000000000a2'::uuid, '00000000-0000-7000-8000-0000000b2001')$$,
                  'agente com a execução do usuário (id normalizado em minúsculas)');

-- Execução de outro usuário, inexistente ou id inválido
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$, '23514', NULL,
                 'execução de outro usuário');
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a2', true),
       set_config('app.agent_run_id', '00000000-0000-7000-8000-0000000b2fff', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$, '23514', NULL,
                 'execução inexistente');
SELECT set_config('app.agent_run_id', 'run-42', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$, '23514', NULL,
                 'agent_run_id precisa ser uuid');

-- agent_run_id só com actor_kind = agent
SELECT set_config('app.actor_kind', 'human', true),
       set_config('app.agent_run_id', '00000000-0000-7000-8000-0000000b2001', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$, '23514', NULL,
                 'humano não informa execução');

-- Agente externo do /mcp: sem execução
SELECT set_config('app.actor_kind', 'agent', true),
       set_config('app.agent_run_id', '', true);
UPDATE entities SET notes = 'via mcp' WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT results_eq($$SELECT actor_kind, agent_run_id FROM audit_log
                     WHERE table_name = 'entities' AND new_data ->> 'notes' = 'via mcp'$$,
                  $$VALUES ('agent', NULL::text)$$, 'agente sem execução (cliente externo do /mcp)');

SELECT * FROM finish();
ROLLBACK;
