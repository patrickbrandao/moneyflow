-- migrate:up

-- Tarefa 109: o 429 do Telegram (limite por chat) era tratado como falha comum: message_outbox_mark_failed devolvia a
-- mensagem a pending, mas a tentativa já tinha sido contada na reserva, e numa rajada para o mesmo chat as do fim da fila
-- viravam failed sem ter saído. message_outbox_release devolve a mensagem reservada à fila SEM gastar tentativa (desfaz
-- o attempts + 1 da reserva), com next_attempt_at = agora + retry_after; serve ao 429 e às outras reservadas do mesmo
-- destino que o worker libera sem enviar. Cada liberação conta em deferrals; no teto (100) a liberação passa a contar a
-- tentativa como uma falha comum, para a mensagem não girar para sempre.

ALTER TABLE message_outbox ADD COLUMN deferrals smallint NOT NULL DEFAULT 0;
ALTER TABLE message_outbox ADD CONSTRAINT message_outbox_deferrals_check CHECK (deferrals >= 0 AND deferrals <= 100);

COMMENT ON COLUMN message_outbox.deferrals IS
  'Quantas vezes a mensagem reservada voltou à fila sem gastar tentativa (message_outbox_release: 429 do Telegram ou '
  'liberada sem envio pelo limite do chat). Teto 100: dali em diante a liberação conta a tentativa (tarefa 109).';

CREATE FUNCTION message_outbox_release(p_message_id uuid, p_retry_after interval DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  m          message_outbox;
  max_deferrals constant smallint := 100;
  wait       interval;
  new_status text;
BEGIN
  IF p_retry_after < interval '0' THEN
    RAISE EXCEPTION 'message_outbox_release: retry_after must not be negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO m FROM message_outbox WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'sending' THEN
    RAISE EXCEPTION 'message_outbox: message % is not being sent', p_message_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
  END IF;
  wait := least(greatest(coalesce(p_retry_after, interval '30 seconds'), interval '1 second'), interval '1 day');

  IF m.deferrals < max_deferrals THEN
    UPDATE message_outbox o
       SET status = 'pending',
           locked_at = NULL,
           attempts = greatest(o.attempts - 1, 0),
           deferrals = o.deferrals + 1,
           last_error = coalesce(left(nullif(btrim(p_error), ''), 2000), o.last_error),
           next_attempt_at = clock_timestamp() + wait
     WHERE o.id = p_message_id;
    RETURN 'pending';
  END IF;

  -- No teto: conta a tentativa (já somada na reserva), como message_outbox_mark_failed.
  new_status := CASE WHEN m.attempts >= m.max_attempts THEN 'failed' ELSE 'pending' END;
  UPDATE message_outbox o
     SET status = new_status,
         locked_at = NULL,
         last_error = left(coalesce(nullif(btrim(p_error), ''), 'rate limited: deferred ' || max_deferrals || ' times'), 2000),
         next_attempt_at = CASE WHEN new_status = 'pending' THEN clock_timestamp() + wait ELSE o.next_attempt_at END
   WHERE o.id = p_message_id;
  RETURN new_status;
END
$$;

COMMENT ON FUNCTION message_outbox_release(uuid, interval, text) IS
  'Devolve à fila uma mensagem em sending sem gastar tentativa (tarefa 109): 429 do Telegram, ou reservada do mesmo '
  'destino que o worker libera sem enviar depois de um 429. status = pending, attempts − 1 (desfaz a reserva), '
  'deferrals + 1, next_attempt_at = agora + p_retry_after (padrão 30 s, entre 1 s e 1 dia), last_error = p_error '
  '(vazio mantém o anterior). Com deferrals no teto (100), conta a tentativa como message_outbox_mark_failed: failed se '
  'esgotou max_attempts. Devolve o novo status. 23514 (message_outbox_transition_check) se ela não está em sending; '
  '22023 com p_retry_after negativo.';

COMMENT ON FUNCTION message_outbox_mark_failed(uuid, text, interval, boolean) IS
  'Registra a falha de uma tentativa de uma mensagem em sending. Volta a pending com next_attempt_at = agora + '
  'p_retry_after ou backoff 30 s × 2^(tentativa−1), máximo 1 h; vira failed se p_permanent (ex.: chat não existe, token '
  'inválido) ou se esgotou max_attempts. A tentativa conta: para o 429 do Telegram, que só adia, use '
  'message_outbox_release (tarefa 109). Devolve o novo status. Erro 23514 (message_outbox_transition_check) se ela não '
  'está em sending.';

-- migrate:down

COMMENT ON FUNCTION message_outbox_mark_failed(uuid, text, interval, boolean) IS
  'Registra a falha de uma tentativa de uma mensagem em sending. Volta a pending com next_attempt_at = agora + '
  'p_retry_after (ex.: retry_after do Telegram 429) ou backoff 30 s × 2^(tentativa−1), máximo 1 h; vira failed se '
  'p_permanent (ex.: chat não existe, token inválido) ou se esgotou max_attempts. Devolve o novo status. Erro 23514 '
  '(message_outbox_transition_check) se ela não está em sending.';

DROP FUNCTION message_outbox_release(uuid, interval, text);
ALTER TABLE message_outbox DROP COLUMN deferrals;
