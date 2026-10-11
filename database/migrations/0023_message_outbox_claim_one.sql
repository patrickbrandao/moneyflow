-- migrate:up

-- "Enviar teste" (spec 013): a aplicação enfileira uma mensagem test e tenta entregá-la na hora.
-- Em vez de repetir o UPDATE do claim na aplicação, reserva só aquela mensagem com a mesma
-- transição do message_outbox_claim (pending → sending, locked_at, attempts + 1).
CREATE FUNCTION message_outbox_claim_one(p_message_id uuid)
RETURNS SETOF message_outbox
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN QUERY
  UPDATE message_outbox o
     SET status = 'sending', locked_at = clock_timestamp(), attempts = o.attempts + 1
   WHERE o.id IN (SELECT x.id FROM message_outbox x
                   WHERE x.id = p_message_id AND x.status = 'pending' AND x.attempts < x.max_attempts
                   FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
END
$$;

COMMENT ON FUNCTION message_outbox_claim_one(uuid) IS
  'Reserva UMA mensagem pendente (ex.: o "enviar teste" logo após enfileirar), com a mesma transição do '
  'message_outbox_claim: status = sending, locked_at = agora, attempts + 1. Ignora next_attempt_at. Devolve a linha, '
  'ou nada se ela não existe, não está pending, esgotou as tentativas ou está travada por outro worker (SKIP LOCKED).';

-- migrate:down

DROP FUNCTION message_outbox_claim_one(uuid);
