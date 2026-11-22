-- migrate:up

-- Tarefa 103: tabelas operacionais que cresciam sem purga. operational_purge apaga, em lotes e pulando linhas travadas, o
-- que passou do prazo em cada uma (prazos fixos no banco, acima das janelas de deduplicação dos produtores):
--   * attachments sem nenhum vínculo em attachment_links, criados há mais de 7 dias (upload do chat que não virou
--     mensagem, upload_file do /mcp não usado, leitura de documento abandonada);
--   * message_outbox sent/canceled/failed criadas há mais de 180 dias (o maior olhar para trás de um produtor é o de
--     contract_charge_missing, 120 dias; a chave de dedup sobrevive a ele);
--   * notifications lidas, criadas há mais de 180 dias (as não lidas ficam);
--   * note_reminder_firings lidas, disparadas pela última vez há mais de 180 dias;
--   * telegram_pairing_codes usados ou vencidos há mais de 1 dia;
--   * ai_scheduled_task_runs criados há mais de 1 ano e ai_reconcile_recipe_runs terminados (completed, skipped,
--     failed) há mais de 1 ano.
-- SECURITY DEFINER: a aplicação não tem DELETE em note_reminder_firings nem em ai_reconcile_recipe_runs.
-- E dois índices parciais para a lista de destinos (último envio e falhas por destino), que lia o histórico inteiro.

CREATE FUNCTION operational_purge(p_limit integer DEFAULT 1000)
RETURNS TABLE (target text, deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n   integer;
  ids uuid[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'operational_purge: limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Anexos órfãos: trava os candidatos e, num segundo comando (snapshot novo), apaga só os que continuam sem vínculo; um
  -- vínculo criado depois espera a trava e falha na FK, nunca é apagado em CASCADE.
  SELECT array_agg(x.id) INTO ids FROM (
    SELECT a.id FROM public.attachments a
     WHERE a.created_at < clock_timestamp() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.attachment_links l WHERE l.attachment_id = a.id)
     ORDER BY a.created_at, a.id
     LIMIT p_limit
     FOR UPDATE OF a SKIP LOCKED) x;
  DELETE FROM public.attachments a
   WHERE a.id = ANY (coalesce(ids, '{}'))
     AND NOT EXISTS (SELECT 1 FROM public.attachment_links l WHERE l.attachment_id = a.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'attachments'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT o.id FROM public.message_outbox o
     WHERE o.status IN ('sent', 'canceled', 'failed') AND o.created_at < clock_timestamp() - interval '180 days'
     ORDER BY o.created_at, o.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.message_outbox o USING doomed d WHERE o.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'message_outbox'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT x.id FROM public.notifications x
     WHERE x.read_at IS NOT NULL AND x.created_at < clock_timestamp() - interval '180 days'
     ORDER BY x.created_at, x.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.notifications x USING doomed d WHERE x.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'notifications'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT f.id FROM public.note_reminder_firings f
     WHERE f.read_at IS NOT NULL AND f.last_fired_at < clock_timestamp() - interval '180 days'
     ORDER BY f.last_fired_at, f.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.note_reminder_firings f USING doomed d WHERE f.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'note_reminder_firings'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT c.id FROM public.telegram_pairing_codes c
     WHERE c.used_at < clock_timestamp() - interval '1 day' OR c.expires_at < clock_timestamp() - interval '1 day'
     ORDER BY c.created_at, c.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.telegram_pairing_codes c USING doomed d WHERE c.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'telegram_pairing_codes'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT r.id FROM public.ai_scheduled_task_runs r
     WHERE r.created_at < clock_timestamp() - interval '1 year'
     ORDER BY r.created_at, r.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.ai_scheduled_task_runs r USING doomed d WHERE r.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'ai_scheduled_task_runs'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT r.id FROM public.ai_reconcile_recipe_runs r
     WHERE r.status IN ('completed', 'skipped', 'failed')
       AND coalesce(r.finished_at, r.created_at) < clock_timestamp() - interval '1 year'
     ORDER BY r.created_at, r.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.ai_reconcile_recipe_runs r USING doomed d WHERE r.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  target := 'ai_reconcile_recipe_runs'; deleted := n; RETURN NEXT;
END
$$;

COMMENT ON FUNCTION operational_purge(integer) IS
  'Manutenção (tarefa 103): apaga até p_limit linhas (padrão 1000, máx. 100000; fora da faixa, 22023) de cada tabela '
  'operacional que passou do prazo, as mais velhas primeiro, pulando as travadas, e devolve (target, deleted) por '
  'tabela. Prazos: attachments sem vínculo em attachment_links criados há mais de 7 dias; message_outbox '
  'sent/canceled/failed criadas há mais de 180 dias; notifications lidas criadas há mais de 180 dias; '
  'note_reminder_firings lidas com o último disparo há mais de 180 dias; telegram_pairing_codes usados ou vencidos há '
  'mais de 1 dia; ai_scheduled_task_runs criados há mais de 1 ano; ai_reconcile_recipe_runs completed/skipped/failed '
  'terminados há mais de 1 ano. O worker chama numa transação sem app.user_id (a exclusão dos anexos e dos códigos é '
  'auditada como system) e repete enquanto alguma tabela devolver o limite. SECURITY DEFINER.';

CREATE INDEX message_outbox_destination_sent_idx ON message_outbox (destination_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX message_outbox_destination_failed_idx ON message_outbox (destination_id) WHERE status = 'failed';

COMMENT ON INDEX message_outbox_destination_sent_idx IS
  'Último envio por destino (max(sent_at) da lista de destinos, sem ler o histórico inteiro; tarefa 103).';
COMMENT ON INDEX message_outbox_destination_failed_idx IS 'Falhas por destino (contagem da lista de destinos; tarefa 103).';

-- migrate:down

DROP INDEX message_outbox_destination_failed_idx;
DROP INDEX message_outbox_destination_sent_idx;
DROP FUNCTION operational_purge(integer);
