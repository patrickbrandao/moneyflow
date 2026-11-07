-- migrate:up

-- Tarefa 064: o webhook do Telegram marca o update_id em autocommit ANTES de processar (o processamento baixa
-- arquivos e responde pela Bot API, o que não cabe numa transação) e apaga a marca se o processamento falhar
-- (docs/029, modelo "marca antes, desfaz no erro"). Só o comentário muda; a função e os GRANTs (moneyflow_app tem
-- DELETE em telegram_updates_seen desde a 0045) ficam como estão.
COMMENT ON FUNCTION telegram_update_seen(uuid, bigint) IS
  'Marca o update_id do destino como recebido. Devolve false na primeira vez (processe) e true se já tinha sido visto '
  '(ignore). Modelo "marca antes, desfaz no erro" (spec 029, tarefa 064): a aplicação chama em autocommit antes de '
  'processar, sem a marca na transação do processamento (que baixa arquivos e responde pela Bot API), e apaga a linha '
  'de telegram_updates_seen se o processamento falhar, para o Telegram reentregar. Uma reentrega depois de erro no '
  'meio pode repetir parte do já gravado; se o processo cair entre a marca e o fim, o update se perde.';

-- migrate:down

COMMENT ON FUNCTION telegram_update_seen(uuid, bigint) IS
  'Marca o update_id do destino como recebido. Devolve false na primeira vez (processe) e true se já tinha sido visto '
  '(ignore). Chame na mesma transação que processa a atualização, para uma falha não marcar o que não foi feito.';
