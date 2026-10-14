-- migrate:up
-- Telegram de entrada (spec 029, tarefa 034): leitura do bot token fora da outbox.
--   * setWebhook ao ligar "Receber mensagens" e deleteWebhook ao desligar, desativar ou arquivar o destino;
--   * no webhook: answerCallbackQuery, getFile, o download do arquivo e as respostas diretas ao chat privado;
--   * no worker: sendChatAction e a resposta final (com os botões de aprovação) ao chat privado pareado.
-- Só de destino telegram ativo, não arquivado e com webhook_secret_hash (a entrada está ou já foi ligada).

CREATE FUNCTION telegram_inbound_bot_token(p_destination_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d record;
BEGIN
  SELECT x.channel, x.is_active, x.archived_at, x.webhook_secret_hash IS NOT NULL AS has_secret, x.bot_token
    INTO d
    FROM public.message_destinations x
   WHERE x.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telegram_inbound_bot_token: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF d.channel <> 'telegram' OR NOT d.is_active OR d.archived_at IS NOT NULL OR NOT d.has_secret THEN
    RAISE EXCEPTION 'telegram_inbound_bot_token: destination % is inactive, archived or has no inbound webhook',
      p_destination_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN d.bot_token;
END
$$;

REVOKE EXECUTE ON FUNCTION telegram_inbound_bot_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telegram_inbound_bot_token(uuid) TO moneyflow_app;

COMMENT ON FUNCTION telegram_inbound_bot_token(uuid) IS
  'Leitura do bot token para a ENTRADA do Telegram (spec 029): setWebhook/deleteWebhook, answerCallbackQuery, getFile '
  'e download de arquivo, sendChatAction e respostas diretas ao chat privado pareado. Devolve o token só de destino '
  'telegram ativo, não arquivado e com webhook_secret_hash (entrada ligada ou já ligada); enxerga o hash gravado na '
  'mesma transação. 42501 em qualquer outro caso; P0002 se o destino não existe. O token nunca vai para logs, '
  'respostas da API, auditoria, eventos ou tools.';

-- migrate:down
DROP FUNCTION telegram_inbound_bot_token(uuid);
