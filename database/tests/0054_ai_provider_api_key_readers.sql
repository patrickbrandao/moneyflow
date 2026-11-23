-- Testes de 0054_ai_provider_api_key_readers (tarefa 069): o comentário de ai_providers.api_key cita os cinco leitores
-- da chave, e a lista secrets do audit_row vigente traz todos os segredos blindados.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT ok(col_description('ai_providers'::regclass,
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'ai_providers'::regclass AND attname = 'api_key'))
          ~ format('%s', r), 'o comentário de api_key cita ' || r)
  FROM unnest(ARRAY['ai_run_provider_credentials', 'ai_capability_credentials', 'ai_embedding_credentials',
                    'ai_transcription_credentials', 'admin_ai_provider_api_key']) r;

-- Toda função que devolve p.api_key está no comentário (um leitor novo precisa entrar lá).
SELECT is(
  (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc ~ '\mp\.api_key\M'
      AND col_description('ai_providers'::regclass,
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'ai_providers'::regclass AND attname = 'api_key'))
          !~ p.proname),
  NULL, 'nenhuma função lê p.api_key sem estar no comentário');

-- A lista única dos segredos fora do audit_log é audit_secret_columns(), aplicada em audit_write (0065, tarefa 159).
SELECT ok(s = ANY (audit_secret_columns()), 'audit_write tira ' || s || ' do audit_log')
  FROM unnest(ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash', 'webhook_secret_hash',
                    'code_hash']) s;

SELECT * FROM finish();
ROLLBACK;
