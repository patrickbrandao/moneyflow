-- migrate:up

-- Tarefa 162: a requisição ao provedor nasce running e só o fim da chamada a fecha. Se o processo morre no meio (deploy
-- com SIGKILL, OOM, queda), ninguém a fecha: fica "em andamento" até a purga, e a saúde do provedor não conta a falha.
-- ai_requests_close_stale passa a error as running iniciadas há mais que o prazo (padrão 1 hora, mínimo 10 minutos,
-- acima do maior timeout de chamada da aplicação), em lotes. O worker a chama no laço de manutenção.

CREATE FUNCTION ai_requests_close_stale(p_after interval DEFAULT interval '1 hour', p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  IF p_after IS NULL OR p_after < interval '10 minutes' THEN
    RAISE EXCEPTION 'ai_requests_close_stale: after must be at least 10 minutes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'ai_requests_close_stale: limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH stale AS (
    SELECT r.id FROM ai_requests r
     WHERE r.status = 'running' AND r.started_at < clock_timestamp() - p_after
     ORDER BY r.started_at, r.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE ai_requests r
     SET status = 'error',
         finished_at = clock_timestamp(),
         error_message = 'interrupted: the process stopped before the request finished'
    FROM stale s
   WHERE r.id = s.id AND r.status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION ai_requests_close_stale(interval, integer) IS
  'Manutenção (spec 023, tarefa 162): fecha como error, com error_message = ''interrupted: the process stopped before '
  'the request finished'' e finished_at = agora, até '
  'p_limit (padrão 1000, máx. 100000) requisições running iniciadas há mais de p_after (padrão 1 hora, mínimo 10 '
  'minutos), as mais velhas primeiro, pulando as travadas; devolve quantas. São as chamadas que o processo não fechou '
  '(queda ou SIGKILL no meio do streaming): passam a contar como erro em ai_provider_health. O worker chama em lotes '
  'até devolver menos que o limite. Erro 22023 com prazo ou limite fora da faixa. SECURITY INVOKER (a aplicação já '
  'tem UPDATE em ai_requests).';

-- As em andamento são poucas: o índice parcial evita varrer a tabela a cada passada.
CREATE INDEX ai_requests_running_idx ON ai_requests (started_at) WHERE status = 'running';

-- migrate:down

DROP INDEX ai_requests_running_idx;
DROP FUNCTION ai_requests_close_stale(interval, integer);
