-- migrate:up

-- Tarefa 164: o aviso do ai_run_event_append (NOTIFY no canal ai_run_events) só trazia run_id e seq. Sem stream aberto
-- daquela execução, o hub da API consultava o banco a cada aviso, inclusive a cada text_delta, só para descobrir o tipo
-- e descartar o que não é done nem status. Agora o aviso traz também o tipo do evento e, nos eventos status e done, o
-- status do payload; o JSON é montado por ai_run_event_notice (IMMUTABLE, testável no pgTAP, que não recebe o NOTIFY).
-- Avisos sem type (gravados por uma versão anterior durante o deploy) seguem o caminho antigo na aplicação.

CREATE FUNCTION ai_run_event_notice(p_run_id uuid, p_seq integer, p_event_type text, p_payload jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT json_strip_nulls(json_build_object(
           'run_id', p_run_id, 'seq', p_seq, 'type', p_event_type,
           'status', CASE WHEN p_event_type IN ('status', 'done') THEN left(p_payload ->> 'status', 40) END))::text
$$;

COMMENT ON FUNCTION ai_run_event_notice(uuid, integer, text, jsonb) IS
  'Payload do NOTIFY de ai_run_events: {"run_id", "seq", "type"} e, nos eventos status e done com status no payload, '
  '"status" (até 40 caracteres). Sem o resto do payload: os dados do evento continuam só na tabela (tarefa 164).';

CREATE OR REPLACE FUNCTION ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  s integer;
BEGIN
  UPDATE ai_runs r SET last_event_seq = r.last_event_seq + 1 WHERE r.id = p_run_id RETURNING r.last_event_seq INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_event_append: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO ai_run_events (run_id, seq, event_type, payload) VALUES (p_run_id, s, p_event_type, coalesce(p_payload, '{}'));
  PERFORM pg_notify('ai_run_events', ai_run_event_notice(p_run_id, s, p_event_type, p_payload));
  RETURN s;
END
$$;

COMMENT ON FUNCTION ai_run_event_append(uuid, text, jsonb) IS
  'Grava o próximo evento da execução (seq = last_event_seq + 1, trava a linha da execução) e avisa por NOTIFY no canal '
  'ai_run_events com ai_run_event_notice: {"run_id", "seq", "type"} e, em status/done, "status" (entregue no COMMIT; '
  'tarefa 164). A API escuta (LISTEN), lê WHERE run_id = … AND seq > último enviado e, sem stream aberto, só consulta '
  'o banco pelos eventos que importam (done, status). Devolve o seq. P0002 se a execução não existe.';

-- migrate:down

CREATE OR REPLACE FUNCTION ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  s integer;
BEGIN
  UPDATE ai_runs r SET last_event_seq = r.last_event_seq + 1 WHERE r.id = p_run_id RETURNING r.last_event_seq INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_event_append: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO ai_run_events (run_id, seq, event_type, payload) VALUES (p_run_id, s, p_event_type, coalesce(p_payload, '{}'));
  PERFORM pg_notify('ai_run_events', json_build_object('run_id', p_run_id, 'seq', s)::text);
  RETURN s;
END
$$;

COMMENT ON FUNCTION ai_run_event_append(uuid, text, jsonb) IS
  'Grava o próximo evento da execução (seq = last_event_seq + 1, trava a linha da execução) e avisa por NOTIFY no canal '
  'ai_run_events com {"run_id", "seq"} (entregue no COMMIT). A API escuta (LISTEN) e lê WHERE run_id = … AND seq > '
  'último enviado. Devolve o seq. P0002 se a execução não existe.';

DROP FUNCTION ai_run_event_notice(uuid, integer, text, jsonb);
