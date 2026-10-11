-- migrate:up

-- Notificações in-app (sino): avisos por usuário, como "agente concluiu" (spec 011),
-- espelho aguardando aceite (spec 006), fatura fechada e lembretes (spec 013).
CREATE TABLE notifications (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  title      text        NOT NULL,
  body       text,
  link       text,
  caixa_id   uuid        REFERENCES caixas (id) ON DELETE SET NULL,
  data       jsonb       NOT NULL DEFAULT '{}',
  dedup_key  text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system')),
  CONSTRAINT notifications_title_check CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT notifications_link_check CHECK (link ~ '^/[^/]' OR link = '/'),
  CONSTRAINT notifications_data_check CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT notifications_dedup_key_check CHECK (btrim(dedup_key) <> '' AND length(dedup_key) <= 300)
);

CREATE INDEX notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_caixa_id_idx ON notifications (caixa_id);
CREATE UNIQUE INDEX notifications_dedup_key ON notifications (user_id, dedup_key);

CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE notifications IS
  'Notificações do sino, por usuário. Estado de interface: fora da auditoria. Contador de não lidas: '
  'count(*) WHERE read_at IS NULL (índice parcial). Criar com ON CONFLICT (user_id, dedup_key) DO NOTHING quando o '
  'evento puder repetir.';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed ou system.';
COMMENT ON COLUMN notifications.link IS 'Caminho relativo do console (começa com "/"), ex.: /titles/<id>. Nunca URL externa.';
COMMENT ON COLUMN notifications.data IS 'Dados extras para a tela (ids, valores). Nunca senha nem token.';
COMMENT ON COLUMN notifications.dedup_key IS 'Chave do evento, única por usuário (nulo = sem dedup).';
COMMENT ON COLUMN notifications.read_at IS 'Quando foi lida (nulo = não lida).';

-- migrate:down

DROP TABLE notifications;
