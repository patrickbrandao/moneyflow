-- Testes de 0056_telegram_update_seen_comment (tarefa 064): o comentário de telegram_update_seen descreve o modelo
-- "marca antes, desfaz no erro" e o papel da aplicação pode apagar a marca.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(obj_description('telegram_update_seen(uuid, bigint)'::regprocedure, 'pg_proc') ~ 'autocommit antes de',
          'o comentário manda marcar em autocommit antes de processar');
SELECT ok(obj_description('telegram_update_seen(uuid, bigint)'::regprocedure, 'pg_proc')
            ~ 'apaga a linha de telegram_updates_seen se o processamento falhar',
          'o comentário manda apagar a marca no erro');
SELECT ok(obj_description('telegram_update_seen(uuid, bigint)'::regprocedure, 'pg_proc') !~ 'mesma transação',
          'o comentário não pede mais a mesma transação do processamento');
SELECT ok(has_table_privilege('moneyflow_app', 'telegram_updates_seen', 'DELETE'), 'app apaga a marca no erro');
SELECT ok(has_function_privilege('moneyflow_app', 'telegram_update_seen(uuid, bigint)', 'EXECUTE'),
          'app chama telegram_update_seen');

SELECT * FROM finish();
ROLLBACK;
