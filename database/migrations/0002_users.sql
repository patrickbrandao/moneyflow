-- migrate:up

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  username      citext      NOT NULL,
  email         citext      NOT NULL,
  password      text        NOT NULL,
  role          text        NOT NULL DEFAULT 'user',
  is_active     boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'user')),
  -- Sem '@' nem espaços: o login aceita username OU email, então os dois
  -- espaços de nomes nunca podem colidir.
  CONSTRAINT users_username_format_check CHECK (username ~ '^[^@[:space:]]{3,64}$'),
  CONSTRAINT users_email_format_check CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length(email) <= 254),
  CONSTRAINT users_password_check CHECK (password <> '')
);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS 'Usuários do sistema (spec 002).';
COMMENT ON COLUMN users.username IS 'Login; sem distinção de maiúsculas; não pode conter @ nem espaços.';
COMMENT ON COLUMN users.email IS 'Login alternativo; sem distinção de maiúsculas.';
COMMENT ON COLUMN users.password IS
  'Senha em TEXTO PURO por decisão do produto (spec 002). moneyflow_app não tem SELECT nesta coluna: '
  'use auth_login() para autenticar e admin_reveal_password() para revelar.';
COMMENT ON COLUMN users.role IS 'Papel global: admin (todos os poderes) ou user.';
COMMENT ON COLUMN users.is_active IS 'false = desativado: não autentica e as sessões são apagadas na hora.';

-- Sessões ---------------------------------------------------------------------
CREATE TABLE sessions (
  id           text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text,
  CONSTRAINT sessions_id_check CHECK (length(id) BETWEEN 32 AND 128),
  CONSTRAINT sessions_expires_at_check CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

COMMENT ON TABLE sessions IS
  'Sessões de login (cookie httpOnly). Não tem updated_at: a única mutação é last_seen_at.';
COMMENT ON COLUMN sessions.id IS
  'Identificador opaco gerado pela aplicação (32 a 128 caracteres; ex.: hash SHA-256 em hex do token do cookie).';

-- Desativar o usuário revoga as sessões na hora.
CREATE FUNCTION users_revoke_sessions_on_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER users_revoke_sessions_on_deactivate
  AFTER UPDATE OF is_active ON users
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active)
  EXECUTE FUNCTION users_revoke_sessions_on_deactivate();

-- Blindagem da senha ------------------------------------------------------------
-- O privilégio padrão (0001) deu SELECT/INSERT/UPDATE na tabela inteira; troca-se
-- por privilégios por coluna, sem SELECT em password.
REVOKE SELECT, INSERT, UPDATE ON users FROM moneyflow_app;
GRANT SELECT (id, username, email, role, is_active, last_login_at, created_at, updated_at)
  ON users TO moneyflow_app;
GRANT INSERT (id, username, email, password, role, is_active)
  ON users TO moneyflow_app;
GRANT UPDATE (username, email, password, role, is_active, last_login_at)
  ON users TO moneyflow_app;

CREATE FUNCTION auth_login(login text, password text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid uuid;
BEGIN
  UPDATE public.users u
     SET last_login_at = now()
   WHERE (u.username = auth_login.login::citext OR u.email = auth_login.login::citext)
     AND u.is_active
     AND u.password = auth_login.password
  RETURNING u.id INTO uid;
  RETURN uid;
END
$$;

COMMENT ON FUNCTION auth_login(text, text) IS
  'Autentica por username OU email (sem distinção de maiúsculas) e senha (exata). '
  'Retorna o id do usuário ativo e atualiza last_login_at, ou NULL se não conferir.';

CREATE FUNCTION admin_reveal_password(target_user_id uuid, actor_user_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pw text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
     WHERE a.id = actor_user_id AND a.role = 'admin' AND a.is_active
  ) THEN
    RAISE EXCEPTION 'admin_reveal_password: actor % is not an active admin', actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT u.password INTO pw FROM public.users u WHERE u.id = target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_reveal_password: user % not found', target_user_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pw;
END
$$;

COMMENT ON FUNCTION admin_reveal_password(uuid, uuid) IS
  'Revela a senha de target_user_id se actor_user_id for admin ativo; senão erro 42501. '
  'actor_user_id vem da sessão autenticada na aplicação (o banco confia nele).';

REVOKE EXECUTE ON FUNCTION auth_login(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_reveal_password(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login(text, text) TO moneyflow_app;
GRANT EXECUTE ON FUNCTION admin_reveal_password(uuid, uuid) TO moneyflow_app;

-- migrate:down

DROP FUNCTION admin_reveal_password(uuid, uuid);
DROP FUNCTION auth_login(text, text);
DROP TABLE sessions;
DROP TABLE users;
DROP FUNCTION users_revoke_sessions_on_deactivate();
