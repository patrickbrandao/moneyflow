-- migrate:up

-- Backup e restauração (Administração). O export JSON do admin leva todos os dados, inclusive os segredos
-- (decisão do produto). moneyflow_app continua sem SELECT nas colunas de segredo: os que ainda não tinham leitor
-- de admin ganham um aqui, no mesmo padrão de admin_ai_provider_api_key (ator admin ativo, senão 42501; registro
-- inexistente, P0002). Já existiam admin_reveal_password, admin_ai_provider_api_key e admin_mcp_server_headers.
-- app_schema_version() devolve a última migration aplicada (dbmate), para o arquivo de backup registrar de que
-- versão do schema veio, sem dar ao papel da aplicação SELECT em schema_migrations.

CREATE FUNCTION admin_message_destination_token(p_destination_id uuid, p_actor_user_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_message_destination_token: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.bot_token INTO k FROM public.message_destinations d WHERE d.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_message_destination_token: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN k;
END
$$;

REVOKE EXECUTE ON FUNCTION admin_message_destination_token(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_message_destination_token(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION admin_message_destination_token(uuid, uuid) IS
  'Bot token do destino para o export de backup do admin (única saída do token para fora do banco além do worker). '
  'Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o destino não existe.';

CREATE FUNCTION admin_api_token_hash(p_token_id uuid, p_actor_user_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_api_token_hash: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.token_hash INTO h FROM public.user_api_tokens t WHERE t.id = p_token_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_api_token_hash: token % not found', p_token_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN h;
END
$$;

REVOKE EXECUTE ON FUNCTION admin_api_token_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_api_token_hash(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION admin_api_token_hash(uuid, uuid) IS
  'SHA-256 (hex) do token pessoal para o export de backup do admin (restaurado, o token continua válido). '
  'Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o token não existe.';

CREATE FUNCTION app_schema_version() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v text;
BEGIN
  -- Bancos migrados sem dbmate (testes de integração da API) não têm a tabela: devolve NULL.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT max(version)::text FROM public.schema_migrations' INTO v;
  RETURN v;
END
$$;

REVOKE EXECUTE ON FUNCTION app_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_schema_version() TO moneyflow_app;

COMMENT ON FUNCTION app_schema_version() IS
  'Versão do schema = última migration aplicada pelo dbmate (max(version) de public.schema_migrations, ex.: 0031); '
  'NULL se a tabela não existe (banco migrado sem dbmate) ou está vazia. Registrada no arquivo de backup.';

-- migrate:down

DROP FUNCTION app_schema_version();
DROP FUNCTION admin_api_token_hash(uuid, uuid);
DROP FUNCTION admin_message_destination_token(uuid, uuid);
