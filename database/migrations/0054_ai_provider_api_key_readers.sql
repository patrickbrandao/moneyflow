-- migrate:up

-- Tarefa 069: o comentário de ai_providers.api_key passa a citar todos os leitores da chave (faltava
-- ai_transcription_credentials, da 0042). Só documentação; nenhum privilégio muda.
COMMENT ON COLUMN ai_providers.api_key IS
  'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, '
  'ai_capability_credentials, ai_embedding_credentials, ai_transcription_credentials e admin_ai_provider_api_key. '
  'Nula só com base_url (servidor local sem chave). Nunca vai para o audit_log, respostas da API, logs ou tools de '
  'agente. Na edição, campo vazio mantém a atual.';

-- migrate:down

COMMENT ON COLUMN ai_providers.api_key IS
  'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, '
  'ai_capability_credentials, ai_embedding_credentials e admin_ai_provider_api_key. Nula só com base_url (servidor '
  'local sem chave). Nunca vai para o audit_log, respostas da API, logs ou tools de agente. Na edição, campo vazio '
  'mantém a atual.';
