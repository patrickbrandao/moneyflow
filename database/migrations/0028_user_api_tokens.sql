-- migrate:up

-- Agentes de IA (spec 011), parte 5: tokens pessoais de API para o servidor MCP próprio (/mcp). O endpoint expõe
-- as mesmas tools dos agentes, com as permissões do dono do token.
--
-- O banco guarda só o SHA-256 do token (hex), nunca o token: a aplicação gera o token, mostra-o UMA vez ao
-- usuário e grava o hash e um prefixo visível. Mesmo o hash é blindado: moneyflow_app grava mas não lê
-- token_hash; a autenticação é por api_token_authenticate(hash) (SECURITY DEFINER).

CREATE TABLE user_api_tokens (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  token_hash   text        NOT NULL,
  token_prefix text        NOT NULL,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  last_used_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_api_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT user_api_tokens_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT user_api_tokens_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_api_tokens_token_prefix_check CHECK (token_prefix ~ '^[A-Za-z0-9_-]{4,16}$'),
  CONSTRAINT user_api_tokens_expires_at_check CHECK (expires_at > created_at)
);

CREATE INDEX user_api_tokens_user_id_idx ON user_api_tokens (user_id, created_at);
-- Nome único entre os tokens não revogados do usuário.
CREATE UNIQUE INDEX user_api_tokens_name_key ON user_api_tokens (user_id, lower(name)) WHERE revoked_at IS NULL;

CREATE TRIGGER user_api_tokens_set_updated_at BEFORE UPDATE ON user_api_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE user_api_tokens IS
  'Tokens pessoais de API (spec 011: autenticação do servidor MCP próprio /mcp, com as permissões do dono). Só o hash '
  'é guardado. Revogar = revoked_at (irreversível); usuário desativado não autentica.';
COMMENT ON COLUMN user_api_tokens.token_hash IS
  'SHA-256 (hex minúsculo) do token inteiro. moneyflow_app grava mas NÃO lê esta coluna: autentique com '
  'api_token_authenticate(hash). Nunca vai para o audit_log.';
COMMENT ON COLUMN user_api_tokens.token_prefix IS 'Começo do token (4–16 caracteres, ex.: mf_3k9X), para o usuário reconhecer qual é.';
COMMENT ON COLUMN user_api_tokens.expires_at IS 'Expiração (nula = não expira).';
COMMENT ON COLUMN user_api_tokens.revoked_at IS 'Revogado em (irreversível; nulo = válido).';
COMMENT ON COLUMN user_api_tokens.last_used_at IS 'Último uso (atualizado pela autenticação no máximo uma vez por minuto).';
COMMENT ON COLUMN user_api_tokens.last_used_ip IS 'IP do último uso.';

-- Blindagem do hash: SELECT por coluna. Coluna nova nesta tabela precisa de GRANT SELECT explícito.
REVOKE SELECT ON user_api_tokens FROM moneyflow_app;
GRANT SELECT (id, user_id, name, token_prefix, expires_at, revoked_at, last_used_at, last_used_ip, created_at, updated_at)
  ON user_api_tokens TO moneyflow_app;

-- Hash e dono imutáveis; revogação irreversível.
CREATE FUNCTION user_api_tokens_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash <> OLD.token_hash OR NEW.token_prefix <> OLD.token_prefix OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'user_api_tokens: token, prefix and owner of token % are immutable (create a new token)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_api_tokens_immutable_check';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'user_api_tokens: token % is revoked', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_api_tokens_revoked_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_api_tokens_validate BEFORE UPDATE ON user_api_tokens
  FOR EACH ROW EXECUTE FUNCTION user_api_tokens_validate();

CREATE FUNCTION api_token_authenticate(p_token_hash text, p_ip inet DEFAULT NULL)
RETURNS TABLE (user_id uuid, token_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t public.user_api_tokens;
BEGIN
  SELECT k.* INTO t
    FROM public.user_api_tokens k
    JOIN public.users u ON u.id = k.user_id AND u.is_active
   WHERE k.token_hash = lower(p_token_hash)
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp());
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF t.last_used_at IS NULL OR t.last_used_at < clock_timestamp() - interval '1 minute'
     OR t.last_used_ip IS DISTINCT FROM coalesce(p_ip, t.last_used_ip) THEN
    UPDATE public.user_api_tokens k
       SET last_used_at = clock_timestamp(), last_used_ip = coalesce(p_ip, k.last_used_ip)
     WHERE k.id = t.id;
  END IF;
  RETURN QUERY SELECT t.user_id, t.id;
END
$$;

REVOKE EXECUTE ON FUNCTION api_token_authenticate(text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_token_authenticate(text, inet) TO moneyflow_app;

COMMENT ON FUNCTION api_token_authenticate(text, inet) IS
  'Autentica um token pessoal pelo SHA-256 (hex) do token apresentado: devolve (user_id, token_id) se o token existe, '
  'não está revogado nem expirado e o dono está ativo; senão nenhuma linha. Atualiza last_used_at/ip (no máximo uma vez '
  'por minuto, ou quando o IP muda).';

-- Auditoria (configuração): sem o hash; o uso sozinho não gera linha.
CREATE TRIGGER user_api_tokens_audit AFTER INSERT OR UPDATE OR DELETE ON user_api_tokens
  FOR EACH ROW EXECUTE FUNCTION audit_row('last_used_at,last_used_ip');

-- migrate:down

DROP FUNCTION api_token_authenticate(text, inet);
DROP TABLE user_api_tokens;
DROP FUNCTION user_api_tokens_validate();
