-- migrate:up
-- F21, anotações e lembretes (spec 035; tarefa 046).
--   * notes: anotação do autor (tipo info|good|bad|severe|reminder, escopo private|global, título, corpo markdown, data)
--     presa a exatamente um objeto (object_type + object_id; hoje só entity). A existência do objeto é uma FK real
--     pela coluna gerada entity_id (um tipo de objeto novo = um valor a mais e uma coluna gerada com a FK dele).
--     Excluir = arquivar (sem DELETE para a aplicação). Auditada.
--   * note_reminders (1:1 com a nota do tipo reminder, conferido no COMMIT junto com note_date = starts_on): horário,
--     repetição once|daily|every_n_days|monthly_day, vigência, som, segundos, Telegram, ativo e next_fire_at, mantido
--     pelo banco (note_reminder_next_fire, fuso de São Paulo, dia que o mês não tem = último dia). Auditada no
--     histórico da nota (record_id = note_id), sem o avanço do próximo disparo.
--   * note_reminder_firings: um disparo por (lembrete, horário previsto), com lido, adiado e o contador de adiamentos.
--     O worker reserva por note_reminder_claim (SKIP LOCKED; o disparo perdido vira um só; os adiados vencidos voltam).
--     Fora da auditoria (log operacional). Sem DELETE para a aplicação.
--   * user_reminder_settings: som e segundos padrão do usuário. Auditada (record_id = user_id).
--   * Calendário: note_reminder_occurrences (expande um lembrete), note_occurrences e note_calendar (notas visíveis
--     por dia e tipo, com as recorrências expandidas).
--   * Notificação e evento de mensagem note_reminder (o Telegram vai ao destino pessoal do autor, sem assinatura).

-- Anotações ----------------------------------------------------------------------------------------------------------
CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  author_id   uuid NOT NULL REFERENCES users (id),
  kind        text NOT NULL,
  scope       text NOT NULL DEFAULT 'private',
  title       text NOT NULL,
  body        text,
  note_date   date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  object_type text NOT NULL,
  object_id   uuid NOT NULL,
  entity_id   uuid GENERATED ALWAYS AS (CASE WHEN object_type = 'entity' THEN object_id END) STORED
              REFERENCES entities (id),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_kind_check CHECK (kind IN ('info', 'good', 'bad', 'severe', 'reminder')),
  CONSTRAINT notes_scope_check CHECK (scope IN ('private', 'global')),
  CONSTRAINT notes_title_check CHECK (btrim(title) <> '' AND length(title) <= 120),
  CONSTRAINT notes_body_check CHECK (length(body) <= 100000),
  CONSTRAINT notes_object_type_check CHECK (object_type IN ('entity')),
  CONSTRAINT notes_object_check CHECK ((object_type = 'entity') = (entity_id IS NOT NULL))
);

CREATE INDEX notes_author_id_idx ON notes (author_id);
CREATE INDEX notes_entity_id_idx ON notes (entity_id);
CREATE INDEX notes_object_idx ON notes (object_type, object_id, kind) WHERE archived_at IS NULL;
CREATE INDEX notes_note_date_idx ON notes (note_date) WHERE archived_at IS NULL;
CREATE INDEX notes_title_trgm_idx ON notes USING gin (title gin_trgm_ops);
CREATE INDEX notes_body_trgm_idx ON notes USING gin (body gin_trgm_ops);

CREATE FUNCTION notes_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.author_id <> OLD.author_id THEN
    RAISE EXCEPTION 'notes: author of note % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notes_author_immutable_check';
  END IF;
  -- Corpo em branco = sem corpo.
  IF NEW.body IS NOT NULL AND btrim(NEW.body, E' \t\r\n') = '' THEN
    NEW.body := NULL;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION notes_before_write() IS
  'Trigger de notes: autor imutável (notes_author_immutable_check) e corpo em branco gravado como nulo.';

CREATE TRIGGER notes_before_write BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_before_write();
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION audit_row();

REVOKE DELETE ON notes FROM moneyflow_app;
GRANT SELECT, INSERT, UPDATE ON notes TO moneyflow_app;

COMMENT ON TABLE notes IS
  'Anotações (spec 035): notas e lembretes do autor presos a um objeto do sistema (hoje, entidade). Visibilidade (o '
  'admin vê todas; os demais, as próprias e as globais) e edição (autor e admin) são da aplicação (Access). Excluir = '
  'arquivar: moneyflow_app não tem DELETE. O lembrete fica em note_reminders. Auditada.';
COMMENT ON COLUMN notes.author_id IS 'Autor (quem criou). Imutável (notes_author_immutable_check). Só ele é alarmado pelo lembrete.';
COMMENT ON COLUMN notes.kind IS
  'info (informação), good (nota boa), bad (nota ruim), severe (nota grave) ou reminder (lembrete, com a linha de '
  'note_reminders). A cor é o token --note-<kind> do front.';
COMMENT ON COLUMN notes.scope IS 'private (padrão: só o autor e o admin veem) ou global (todos veem; só o autor e o admin editam).';
COMMENT ON COLUMN notes.title IS 'Título curto (1–120): tabela, alarme, sino e Telegram.';
COMMENT ON COLUMN notes.body IS 'Corpo em markdown (opcional, até 100 mil caracteres). Em branco é gravado como nulo.';
COMMENT ON COLUMN notes.note_date IS
  'Data da nota no calendário (YYYY-MM-DD em São Paulo; padrão hoje, editável para fatos passados). No lembrete é '
  'igual a note_reminders.starts_on (note_reminders_note_date_check, no COMMIT) e o calendário usa as ocorrências.';
COMMENT ON COLUMN notes.object_type IS 'Tipo do objeto da nota: hoje só entity (notes_object_type_check).';
COMMENT ON COLUMN notes.object_id IS 'Id do objeto da nota; a existência é conferida pela FK da coluna gerada do tipo (entity_id).';
COMMENT ON COLUMN notes.entity_id IS
  'Gerada: object_id quando object_type = entity, senão nula. Tem a FK para entities (a entidade com notas não é '
  'excluída, 23503 notes_entity_id_fkey; arquivada, mantém as notas). Não se grava (coluna gerada).';
COMMENT ON COLUMN notes.archived_at IS 'Arquivada (a "exclusão"): sai do calendário e da tabela, salvo no filtro Arquivadas; o lembrete para de disparar.';

-- Cálculo das ocorrências do lembrete ---------------------------------------------------------------------------------
CREATE FUNCTION note_reminder_month_day(p_month date, p_day integer) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT date_trunc('month', p_month)::date
         + (least(p_day, extract(day FROM date_trunc('month', p_month) + interval '1 month - 1 day')::int) - 1)
$$;

COMMENT ON FUNCTION note_reminder_month_day(date, integer) IS
  'Interna: o dia p_day do mês de p_month, ou o último dia do mês se ele não tem esse dia (31 em fevereiro = 28/29).';

CREATE FUNCTION note_reminder_first_on_or_after(p_repeat text, p_starts_on date, p_ends_on date,
                                                p_every_n_days integer, p_month_day integer, p_day date)
RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  d date;
  r date;
BEGIN
  IF p_repeat IS NULL OR p_starts_on IS NULL OR p_day IS NULL THEN
    RETURN NULL;
  END IF;
  d := greatest(p_day, p_starts_on);
  CASE p_repeat
    WHEN 'once' THEN
      RETURN CASE WHEN d = p_starts_on THEN p_starts_on END;
    WHEN 'daily' THEN
      r := d;
    WHEN 'every_n_days' THEN
      IF p_every_n_days IS NULL OR p_every_n_days < 1 THEN
        RETURN NULL;
      END IF;
      r := p_starts_on + ((d - p_starts_on + p_every_n_days - 1) / p_every_n_days) * p_every_n_days;
    WHEN 'monthly_day' THEN
      IF p_month_day IS NULL OR p_month_day NOT BETWEEN 1 AND 31 THEN
        RETURN NULL;
      END IF;
      r := note_reminder_month_day(d, p_month_day);
      IF r < d THEN
        r := note_reminder_month_day((date_trunc('month', d) + interval '1 month')::date, p_month_day);
      END IF;
    ELSE
      RETURN NULL;
  END CASE;
  IF p_ends_on IS NOT NULL AND r > p_ends_on THEN
    RETURN NULL;
  END IF;
  RETURN r;
END
$$;

COMMENT ON FUNCTION note_reminder_first_on_or_after(text, date, date, integer, integer, date) IS
  'Primeiro dia de ocorrência do lembrete em p_day ou depois (once: o início; daily; every_n_days: início + k·n; '
  'monthly_day: o dia do mês, ou o último dia nos meses sem ele), respeitando o fim (ends_on). NULL se não há.';

CREATE FUNCTION note_reminder_last_on_or_before(p_repeat text, p_starts_on date, p_ends_on date,
                                                p_every_n_days integer, p_month_day integer, p_day date)
RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  d date := p_day;
  r date;
BEGIN
  IF p_repeat IS NULL OR p_starts_on IS NULL OR p_day IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_repeat <> 'once' AND p_ends_on IS NOT NULL THEN
    d := least(d, p_ends_on);
  END IF;
  IF d < p_starts_on THEN
    RETURN NULL;
  END IF;
  CASE p_repeat
    WHEN 'once' THEN
      r := p_starts_on;
    WHEN 'daily' THEN
      r := d;
    WHEN 'every_n_days' THEN
      IF p_every_n_days IS NULL OR p_every_n_days < 1 THEN
        RETURN NULL;
      END IF;
      r := p_starts_on + ((d - p_starts_on) / p_every_n_days) * p_every_n_days;
    WHEN 'monthly_day' THEN
      IF p_month_day IS NULL OR p_month_day NOT BETWEEN 1 AND 31 THEN
        RETURN NULL;
      END IF;
      r := note_reminder_month_day(d, p_month_day);
      IF r > d THEN
        r := note_reminder_month_day((date_trunc('month', d) - interval '1 month')::date, p_month_day);
      END IF;
      IF r < p_starts_on THEN
        RETURN NULL;
      END IF;
    ELSE
      RETURN NULL;
  END CASE;
  RETURN r;
END
$$;

COMMENT ON FUNCTION note_reminder_last_on_or_before(text, date, date, integer, integer, date) IS
  'Último dia de ocorrência do lembrete em p_day ou antes, entre o início e o fim. NULL se não há.';

CREATE FUNCTION note_reminder_next_fire(p_repeat text, p_time_of_day time, p_starts_on date, p_ends_on date,
                                        p_every_n_days integer, p_month_day integer, p_after timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  d date;
  t timestamptz;
BEGIN
  IF p_after IS NULL OR p_time_of_day IS NULL THEN
    RETURN NULL;
  END IF;
  d := note_reminder_first_on_or_after(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day,
                                       (p_after AT TIME ZONE 'America/Sao_Paulo')::date);
  IF d IS NULL THEN
    RETURN NULL;
  END IF;
  t := (d + p_time_of_day) AT TIME ZONE 'America/Sao_Paulo';
  IF t > p_after THEN
    RETURN t;
  END IF;
  d := note_reminder_first_on_or_after(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day, d + 1);
  RETURN CASE WHEN d IS NOT NULL THEN (d + p_time_of_day) AT TIME ZONE 'America/Sao_Paulo' END;
END
$$;

COMMENT ON FUNCTION note_reminder_next_fire(text, time, date, date, integer, integer, timestamptz) IS
  'Próximo disparo do lembrete estritamente depois de p_after: o dia da ocorrência no horário, em America/Sao_Paulo. '
  'once dispara uma vez (no início); daily; every_n_days a partir do início; monthly_day no dia do mês (último dia nos '
  'meses sem ele); nada depois do fim (ends_on). NULL se não há mais ocorrência. Pura (não lê tabelas).';

CREATE FUNCTION note_reminder_prev_fire(p_repeat text, p_time_of_day time, p_starts_on date, p_ends_on date,
                                        p_every_n_days integer, p_month_day integer, p_at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  d date;
  t timestamptz;
BEGIN
  IF p_at IS NULL OR p_time_of_day IS NULL THEN
    RETURN NULL;
  END IF;
  d := note_reminder_last_on_or_before(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day,
                                       (p_at AT TIME ZONE 'America/Sao_Paulo')::date);
  IF d IS NULL THEN
    RETURN NULL;
  END IF;
  t := (d + p_time_of_day) AT TIME ZONE 'America/Sao_Paulo';
  IF t <= p_at THEN
    RETURN t;
  END IF;
  d := note_reminder_last_on_or_before(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day, d - 1);
  RETURN CASE WHEN d IS NOT NULL THEN (d + p_time_of_day) AT TIME ZONE 'America/Sao_Paulo' END;
END
$$;

COMMENT ON FUNCTION note_reminder_prev_fire(text, time, date, date, integer, integer, timestamptz) IS
  'Último disparo previsto do lembrete em p_at ou antes (o "disparo perdido" mais recente), em America/Sao_Paulo. '
  'NULL se não há. Pura.';

CREATE FUNCTION note_reminder_occurrences(p_repeat text, p_starts_on date, p_ends_on date, p_every_n_days integer,
                                          p_month_day integer, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  d date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'note_reminder_occurrences: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  d := note_reminder_first_on_or_after(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day, p_from);
  WHILE d IS NOT NULL AND d <= p_to LOOP
    RETURN NEXT d;
    d := note_reminder_first_on_or_after(p_repeat, p_starts_on, p_ends_on, p_every_n_days, p_month_day, d + 1);
  END LOOP;
END
$$;

COMMENT ON FUNCTION note_reminder_occurrences(text, date, date, integer, integer, date, date) IS
  'Dias de ocorrência do lembrete entre p_from e p_to (inclusive), para o calendário. Período de até 1100 dias '
  '(22023).';

-- Lembretes -----------------------------------------------------------------------------------------------------------
CREATE TABLE note_reminders (
  note_id       uuid PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  time_of_day   time NOT NULL DEFAULT '09:00',
  repeat        text NOT NULL DEFAULT 'once',
  every_n_days  smallint,
  month_day     smallint,
  starts_on     date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  ends_on       date,
  sound         text,
  ring_seconds  smallint,
  send_telegram boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  next_fire_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_reminders_time_of_day_check CHECK (extract(second FROM time_of_day) = 0),
  CONSTRAINT note_reminders_repeat_check CHECK (repeat IN ('once', 'daily', 'every_n_days', 'monthly_day')),
  CONSTRAINT note_reminders_every_n_days_check CHECK (
    (repeat = 'every_n_days') = (every_n_days IS NOT NULL) AND every_n_days BETWEEN 2 AND 365),
  CONSTRAINT note_reminders_month_day_check CHECK (
    (repeat = 'monthly_day') = (month_day IS NOT NULL) AND month_day BETWEEN 1 AND 31),
  CONSTRAINT note_reminders_ends_on_check CHECK (ends_on IS NULL OR (repeat <> 'once' AND ends_on >= starts_on)),
  CONSTRAINT note_reminders_sound_check CHECK (sound ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT note_reminders_ring_seconds_check CHECK (ring_seconds BETWEEN 5 AND 600),
  CONSTRAINT note_reminders_next_fire_check CHECK (is_active OR next_fire_at IS NULL)
);

CREATE INDEX note_reminders_due_idx ON note_reminders (next_fire_at) WHERE is_active;

CREATE FUNCTION note_reminders_compute_next(r note_reminders, p_after timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN NOT r.is_active OR EXISTS (SELECT 1 FROM notes n WHERE n.id = r.note_id AND n.archived_at IS NOT NULL)
             THEN NULL
           ELSE note_reminder_next_fire(r.repeat, r.time_of_day, r.starts_on, r.ends_on, r.every_n_days, r.month_day,
                                        p_after)
         END
$$;

COMMENT ON FUNCTION note_reminders_compute_next(note_reminders, timestamptz) IS
  'Interna: próximo disparo do lembrete depois de p_after; NULL se desligado ou com a nota arquivada.';

CREATE FUNCTION note_reminders_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.note_id <> OLD.note_id THEN
    RAISE EXCEPTION 'note_reminders: note of reminder % is immutable', OLD.note_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'note_reminders_note_immutable_check';
  END IF;
  -- Próximo disparo: recalculado a partir de agora ao criar e a cada mudança da regra ou do ativo; o claim o avança
  -- sem mudar a regra, e o valor dele fica. Desligado ou com a nota arquivada, nulo.
  IF TG_OP = 'INSERT'
     OR (NEW.time_of_day, NEW.repeat, NEW.every_n_days, NEW.month_day, NEW.starts_on, NEW.ends_on, NEW.is_active)
        IS DISTINCT FROM
        (OLD.time_of_day, OLD.repeat, OLD.every_n_days, OLD.month_day, OLD.starts_on, OLD.ends_on, OLD.is_active) THEN
    NEW.next_fire_at := note_reminders_compute_next(NEW, now());
  ELSIF NOT NEW.is_active OR EXISTS (SELECT 1 FROM notes n WHERE n.id = NEW.note_id AND n.archived_at IS NOT NULL) THEN
    NEW.next_fire_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION note_reminders_before_write() IS
  'Trigger de note_reminders: nota imutável e next_fire_at recalculado (a partir de agora) ao criar e ao mudar a '
  'regra, a vigência ou o ativo; nulo se desligado ou com a nota arquivada.';

CREATE TRIGGER note_reminders_before_write BEFORE INSERT OR UPDATE ON note_reminders
  FOR EACH ROW EXECUTE FUNCTION note_reminders_before_write();
CREATE TRIGGER note_reminders_set_updated_at BEFORE UPDATE ON note_reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No COMMIT: o lembrete é de uma nota reminder e começa na data da nota.
CREATE FUNCTION note_reminder_assert(p_note_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n notes;
  r note_reminders;
BEGIN
  SELECT * INTO r FROM note_reminders WHERE note_id = p_note_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO n FROM notes WHERE id = p_note_id;
  IF n.kind <> 'reminder' THEN
    RAISE EXCEPTION 'note_reminders: note % is %, not reminder', p_note_id, n.kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'note_reminders_note_kind_check';
  END IF;
  IF n.note_date <> r.starts_on THEN
    RAISE EXCEPTION 'note_reminders: note % date % differs from reminder start %', p_note_id, n.note_date, r.starts_on
      USING ERRCODE = 'check_violation', CONSTRAINT = 'note_reminders_note_date_check';
  END IF;
END
$$;

COMMENT ON FUNCTION note_reminder_assert(uuid) IS
  'Interna (no COMMIT): o lembrete só existe em nota kind = reminder (note_reminders_note_kind_check) e a data da nota '
  'é o início do lembrete (note_reminders_note_date_check).';

CREATE FUNCTION note_reminders_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'notes' THEN
    PERFORM note_reminder_assert(NEW.id);
  ELSE
    PERFORM note_reminder_assert(NEW.note_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER note_reminders_integrity_check AFTER INSERT OR UPDATE OF starts_on ON note_reminders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION note_reminders_integrity_check();
CREATE CONSTRAINT TRIGGER notes_reminder_integrity_check AFTER UPDATE OF kind, note_date ON notes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION note_reminders_integrity_check();

-- Arquivar a nota para o lembrete; desarquivar volta a calcular a partir de agora.
CREATE FUNCTION notes_sync_reminder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE note_reminders r
     SET next_fire_at = note_reminders_compute_next(r, now())
   WHERE r.note_id = NEW.id;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION notes_sync_reminder() IS
  'Trigger de notes: ao arquivar ou desarquivar, recalcula o next_fire_at do lembrete (nulo se arquivada).';

CREATE TRIGGER notes_sync_reminder AFTER UPDATE OF archived_at ON notes
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL) <> (NEW.archived_at IS NULL))
  EXECUTE FUNCTION notes_sync_reminder();

-- Auditoria no histórico da nota, sem o avanço do próximo disparo.
CREATE FUNCTION note_reminders_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o       jsonb;
  n       jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE n -> k IS DISTINCT FROM o -> k AND k <> 'updated_at';
    IF changed IS NULL OR changed <@ ARRAY['next_fire_at'] THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'note_id', o ->> 'note_id')::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION note_reminders_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION note_reminders_audit_row() IS
  'Trigger de auditoria de note_reminders: record_id = note_id (no histórico da nota); só o next_fire_at mudando não '
  'gera linha.';

CREATE TRIGGER note_reminders_audit AFTER INSERT OR UPDATE OR DELETE ON note_reminders
  FOR EACH ROW EXECUTE FUNCTION note_reminders_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON note_reminders TO moneyflow_app;

COMMENT ON TABLE note_reminders IS
  'Lembrete de uma nota kind = reminder (spec 035), 1:1 (conferido no COMMIT: crie a nota e o lembrete na mesma '
  'transação; mudar a nota de tipo exige excluir o lembrete junto). Só o autor é alarmado. next_fire_at mantido pelo '
  'banco; disparos em note_reminder_firings por note_reminder_claim. Auditada no histórico da nota (record_id = '
  'note_id), sem o avanço do next_fire_at.';
COMMENT ON COLUMN note_reminders.time_of_day IS 'Horário (HH:MM, sem segundos) em America/Sao_Paulo; padrão 09:00.';
COMMENT ON COLUMN note_reminders.repeat IS
  'once (uma vez, no início), daily, every_n_days (a cada every_n_days dias a partir do início) ou monthly_day (todo '
  'dia month_day; nos meses sem ele, o último dia).';
COMMENT ON COLUMN note_reminders.every_n_days IS 'X de "a cada X dias" (2–365); só e sempre em every_n_days.';
COMMENT ON COLUMN note_reminders.month_day IS 'Dia do mês (1–31); só e sempre em monthly_day.';
COMMENT ON COLUMN note_reminders.starts_on IS 'Início da vigência (padrão hoje em São Paulo); igual a notes.note_date (no COMMIT).';
COMMENT ON COLUMN note_reminders.ends_on IS 'Fim da vigência (opcional, >= início; nulo = sem fim). Sempre nulo em once.';
COMMENT ON COLUMN note_reminders.sound IS
  'Chave do som no manifest do front (minúsculas, dígitos, - e _); nulo = o padrão do usuário (user_reminder_settings). '
  'Chave que sumiu do manifest cai no padrão (regra do front).';
COMMENT ON COLUMN note_reminders.ring_seconds IS 'Segundos do loop do som (5–600); nulo = o padrão do usuário.';
COMMENT ON COLUMN note_reminders.send_telegram IS 'Enviar também pelo destino Telegram pessoal do autor (outbox, evento note_reminder).';
COMMENT ON COLUMN note_reminders.is_active IS 'Desligado pausa os disparos (next_fire_at nulo) e mantém a nota.';
COMMENT ON COLUMN note_reminders.next_fire_at IS
  'Próximo disparo, mantido pelo banco: note_reminder_next_fire a partir de agora ao criar e ao mudar regra, vigência '
  'ou ativo, e ao desarquivar a nota; avançado por note_reminder_claim. Nulo se desligado, nota arquivada ou sem '
  'ocorrência futura (once já disparado, fim da vigência).';

-- Disparos ------------------------------------------------------------------------------------------------------------
CREATE TABLE note_reminder_firings (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  note_id       uuid NOT NULL REFERENCES note_reminders (note_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  last_fired_at timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  snoozed_until timestamptz,
  snooze_count  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_reminder_firings_note_scheduled_key UNIQUE (note_id, scheduled_for),
  CONSTRAINT note_reminder_firings_last_fired_check CHECK (last_fired_at >= fired_at),
  CONSTRAINT note_reminder_firings_snooze_count_check CHECK (snooze_count BETWEEN 0 AND 10000),
  CONSTRAINT note_reminder_firings_snooze_check CHECK (snoozed_until IS NULL OR read_at IS NULL)
);

CREATE INDEX note_reminder_firings_user_idx ON note_reminder_firings (user_id, last_fired_at DESC);
CREATE INDEX note_reminder_firings_unread_idx ON note_reminder_firings (user_id) WHERE read_at IS NULL;
CREATE INDEX note_reminder_firings_snoozed_idx ON note_reminder_firings (snoozed_until) WHERE snoozed_until IS NOT NULL;

CREATE FUNCTION note_reminder_firings_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  author uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT n.author_id INTO author FROM notes n WHERE n.id = NEW.note_id;
    NEW.user_id := coalesce(NEW.user_id, author);
    IF NEW.user_id IS DISTINCT FROM author THEN
      RAISE EXCEPTION 'note_reminder_firings: firing of note % must go to its author %', NEW.note_id, author
        USING ERRCODE = 'check_violation', CONSTRAINT = 'note_reminder_firings_user_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.note_id <> OLD.note_id OR NEW.user_id <> OLD.user_id OR NEW.scheduled_for <> OLD.scheduled_for
     OR NEW.fired_at <> OLD.fired_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'note_reminder_firings: note, user, scheduled time and first fire of % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'note_reminder_firings_immutable_check';
  END IF;
  -- O contador de adiamentos é do banco: soma um a cada adiamento novo (snoozed_until preenchido ou trocado).
  NEW.snooze_count := OLD.snooze_count
    + CASE WHEN NEW.snoozed_until IS NOT NULL AND NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION note_reminder_firings_before_write() IS
  'Trigger de note_reminder_firings: o disparo é do autor da nota (preenchido se omitido; note_reminder_firings_user_check), '
  'nota, usuário, horário previsto e primeiro disparo imutáveis, e o snooze_count mantido pelo banco.';

CREATE TRIGGER note_reminder_firings_before_write BEFORE INSERT OR UPDATE ON note_reminder_firings
  FOR EACH ROW EXECUTE FUNCTION note_reminder_firings_before_write();
CREATE TRIGGER note_reminder_firings_set_updated_at BEFORE UPDATE ON note_reminder_firings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

REVOKE DELETE ON note_reminder_firings FROM moneyflow_app;
GRANT SELECT, INSERT, UPDATE ON note_reminder_firings TO moneyflow_app;

COMMENT ON TABLE note_reminder_firings IS
  'Log de lembretes (spec 035): um disparo por (lembrete, horário previsto) (note_reminder_firings_note_scheduled_key), '
  'sempre para o autor da nota. Criado por note_reminder_claim (o worker); a aplicação marca lido (read_at) e adia '
  '(snoozed_until). Some com o lembrete (CASCADE). Fora da auditoria (log operacional, como as notificações); sem '
  'DELETE para a aplicação.';
COMMENT ON COLUMN note_reminder_firings.scheduled_for IS 'Horário previsto (a ocorrência que disparou). Imutável.';
COMMENT ON COLUMN note_reminder_firings.fired_at IS 'Quando disparou pela primeira vez (o horário real). Imutável.';
COMMENT ON COLUMN note_reminder_firings.last_fired_at IS
  'Último toque: fired_at ou o re-disparo de um adiamento. O front toca o som só para last_fired_at nos últimos 10 min.';
COMMENT ON COLUMN note_reminder_firings.read_at IS
  'Lido (Dispensar ou Marcar todos como lidos). Nulo = não lido. Não convive com snoozed_until '
  '(note_reminder_firings_snooze_check): ao marcar lido, limpe o adiamento.';
COMMENT ON COLUMN note_reminder_firings.snoozed_until IS
  'Adiado até (Adiar 5/10/30 min): note_reminder_claim dispara de novo nessa hora (mesmo registro) e o limpa. O '
  'próximo disparo da recorrência não muda.';
COMMENT ON COLUMN note_reminder_firings.snooze_count IS
  'Adiamentos: mantido pelo banco (+1 a cada snoozed_until novo). Use-o na dedup_key do sino e do Telegram do re-disparo.';

-- Preferências do usuário ---------------------------------------------------------------------------------------------
CREATE TABLE user_reminder_settings (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  sound        text,
  ring_seconds smallint NOT NULL DEFAULT 30,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_reminder_settings_sound_check CHECK (sound ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT user_reminder_settings_ring_seconds_check CHECK (ring_seconds BETWEEN 5 AND 600)
);

CREATE TRIGGER user_reminder_settings_set_updated_at BEFORE UPDATE ON user_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_reminder_settings_audit AFTER INSERT OR UPDATE OR DELETE ON user_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_keyed('user_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON user_reminder_settings TO moneyflow_app;

COMMENT ON TABLE user_reminder_settings IS
  'Minha conta → Lembretes (spec 035): som e segundos padrão do usuário. Sem linha = os padrões (som do sistema, 30 s). '
  'Tabela própria para não tocar em users. Auditada (record_id = user_id). Some com o usuário.';
COMMENT ON COLUMN user_reminder_settings.sound IS 'Chave do som no manifest do front; nulo = o som padrão do sistema (o primeiro do manifest).';
COMMENT ON COLUMN user_reminder_settings.ring_seconds IS 'Segundos do loop do som (5–600, padrão 30).';

-- Reserva dos disparos ------------------------------------------------------------------------------------------------
CREATE FUNCTION note_reminder_claim(p_limit integer DEFAULT 100)
RETURNS TABLE (firing_id uuid, note_id uuid, user_id uuid, title text, kind text, object_type text, object_id uuid,
               send_telegram boolean, scheduled_for timestamptz, fired_at timestamptz, is_snooze_refire boolean,
               snooze_count integer)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  r note_reminders;
  n notes;
  s timestamptz;
  fid uuid;
  f note_reminder_firings;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'note_reminder_claim: limit must be 1..1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lembretes vencidos: um disparo no horário previsto mais recente (vários perdidos viram um) e o próximo depois de
  -- agora. Autor inativo: avança sem disparar.
  FOR r IN SELECT x.* FROM note_reminders x
            WHERE x.is_active AND x.next_fire_at <= v_now
            ORDER BY x.next_fire_at, x.note_id
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO n FROM notes WHERE id = r.note_id;
    s := greatest(r.next_fire_at,
                  coalesce(note_reminder_prev_fire(r.repeat, r.time_of_day, r.starts_on, r.ends_on, r.every_n_days,
                                                   r.month_day, v_now), r.next_fire_at));
    fid := NULL;
    IF n.archived_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = n.author_id AND u.is_active) THEN
      INSERT INTO note_reminder_firings AS x (note_id, user_id, scheduled_for, fired_at, last_fired_at)
      VALUES (r.note_id, n.author_id, s, v_now, v_now)
      ON CONFLICT ON CONSTRAINT note_reminder_firings_note_scheduled_key DO NOTHING
      RETURNING x.id INTO fid;
    END IF;

    UPDATE note_reminders x
       SET next_fire_at = note_reminders_compute_next(x, greatest(v_now, s))
     WHERE x.note_id = r.note_id;

    IF fid IS NOT NULL THEN
      RETURN QUERY SELECT fid, n.id, n.author_id, n.title, n.kind, n.object_type, n.object_id, r.send_telegram, s, v_now,
                          false, 0;
    END IF;
  END LOOP;

  -- Adiados vencidos: o mesmo registro toca de novo (lembrete ativo, nota não arquivada e autor ativo).
  FOR f IN SELECT x.* FROM note_reminder_firings x
            WHERE x.snoozed_until <= v_now
              AND EXISTS (SELECT 1 FROM note_reminders y JOIN notes z ON z.id = y.note_id
                                   JOIN users u ON u.id = z.author_id
                           WHERE y.note_id = x.note_id AND y.is_active AND z.archived_at IS NULL AND u.is_active)
            ORDER BY x.snoozed_until, x.id
            LIMIT p_limit
            FOR UPDATE OF x SKIP LOCKED LOOP
    UPDATE note_reminder_firings x SET snoozed_until = NULL, last_fired_at = v_now WHERE x.id = f.id;
    SELECT * INTO n FROM notes WHERE id = f.note_id;
    RETURN QUERY SELECT f.id, n.id, f.user_id, n.title, n.kind, n.object_type, n.object_id,
                        (SELECT y.send_telegram FROM note_reminders y WHERE y.note_id = f.note_id), f.scheduled_for,
                        v_now, true, f.snooze_count;
  END LOOP;
END
$$;

COMMENT ON FUNCTION note_reminder_claim(integer) IS
  'Worker (spec 035): reserva até p_limit lembretes ativos vencidos (next_fire_at <= agora) com FOR UPDATE SKIP LOCKED, '
  'grava UM disparo no horário previsto mais recente (os perdidos com o worker parado viram um só; único por lembrete '
  'e horário) e avança next_fire_at para a ocorrência seguinte depois de agora (nulo se acabou: once, fim da '
  'vigência). Nota arquivada ou autor inativo: avança sem disparar. Depois, até p_limit disparos adiados vencidos '
  '(snoozed_until <= agora, lembrete ativo, nota não arquivada, autor ativo): limpa snoozed_until, last_fired_at = '
  'agora. Devolve firing_id, nota, usuário (o autor), título, kind, objeto, send_telegram, scheduled_for, fired_at (o '
  'toque agora), is_snooze_refire e snooze_count. Sino: dedup_key note_reminder:<firing_id>:<snooze_count>. 22023 '
  'com limite fora de 1–1000.';

-- Calendário ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION note_occurrences(p_from date, p_to date, p_visible_to uuid DEFAULT NULL, p_entity_id uuid DEFAULT NULL,
                                 p_include_archived boolean DEFAULT false)
RETURNS TABLE (note_id uuid, occurs_on date, kind text)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'note_occurrences: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    WITH visible AS (
      SELECT n.id, n.kind, n.note_date
        FROM notes n
       WHERE (p_include_archived OR n.archived_at IS NULL)
         AND (p_visible_to IS NULL OR n.author_id = p_visible_to OR n.scope = 'global')
         AND (p_entity_id IS NULL OR n.entity_id = p_entity_id)
    )
    SELECT v.id, v.note_date, v.kind
      FROM visible v
     WHERE v.note_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM note_reminders r WHERE r.note_id = v.id)
    UNION ALL
    SELECT v.id, o.d, v.kind
      FROM visible v
      JOIN note_reminders r ON r.note_id = v.id
     CROSS JOIN LATERAL note_reminder_occurrences(r.repeat, r.starts_on, r.ends_on, r.every_n_days, r.month_day,
                                                  p_from, p_to) AS o (d)
     ORDER BY 2, 1;
END
$$;

COMMENT ON FUNCTION note_occurrences(date, date, uuid, uuid, boolean) IS
  'Ocorrências das notas no período (até 1100 dias, senão 22023): a nota comum na note_date; a de lembrete em cada '
  'ocorrência entre o início e o fim (ativo ou pausado), expandida por note_reminder_occurrences. Visibilidade pelo '
  'parâmetro que a aplicação (Access) escolhe: p_visible_to nulo = todas (admin); senão as do autor p_visible_to e as '
  'globais. p_entity_id filtra a entidade; arquivadas só com p_include_archived. Serve o filtro de período da tabela.';

CREATE FUNCTION note_calendar(p_from date, p_to date, p_visible_to uuid DEFAULT NULL, p_entity_id uuid DEFAULT NULL)
RETURNS TABLE (day date, kind text, notes integer)
LANGUAGE sql STABLE AS $$
  SELECT o.occurs_on, o.kind, count(DISTINCT o.note_id)::int
    FROM note_occurrences(p_from, p_to, p_visible_to, p_entity_id, false) o
   GROUP BY o.occurs_on, o.kind
   ORDER BY o.occurs_on, o.kind
$$;

COMMENT ON FUNCTION note_calendar(date, date, uuid, uuid) IS
  'Bolinhas do calendário (spec 035): por dia e tipo, quantas notas visíveis não arquivadas ocorrem (lembretes '
  'expandidos). Mesmos parâmetros de note_occurrences (p_visible_to nulo = admin, todas).';

-- Notificação e evento note_reminder ----------------------------------------------------------------------------------
ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'test', 'note_reminder'));

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'contract_charge_missing', 'note_reminder'));

COMMENT ON COLUMN message_outbox.event_kind IS
  'Evento que gerou a mensagem (os de message_subscriptions, mais test e note_reminder: o disparo de lembrete com '
  '"Enviar também no Telegram", direto ao destino pessoal do autor, sem assinatura; spec 035).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e limiar), '
  'ai_awaiting_approval (spec 029: tarefa agendada ou conciliação com IA esperando aprovação), '
  'contract_charge_missing (spec 034) ou note_reminder (spec 035: disparo de lembrete; dedup por disparo e adiamento).';

-- migrate:down

DELETE FROM notifications WHERE kind = 'note_reminder';
DELETE FROM message_outbox WHERE event_kind = 'note_reminder';

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'contract_charge_missing'));
ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'test'));

COMMENT ON COLUMN message_outbox.event_kind IS 'Evento que gerou a mensagem (os de message_subscriptions, mais test).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e limiar) ou '
  'ai_awaiting_approval (spec 029: tarefa agendada ou conciliação com IA esperando aprovação).';

DROP FUNCTION note_calendar(date, date, uuid, uuid);
DROP FUNCTION note_occurrences(date, date, uuid, uuid, boolean);
DROP FUNCTION note_reminder_claim(integer);

DROP TABLE user_reminder_settings;
DROP TABLE note_reminder_firings;
DROP FUNCTION note_reminder_firings_before_write();

DROP TRIGGER notes_sync_reminder ON notes;
DROP TRIGGER notes_reminder_integrity_check ON notes;
DROP TRIGGER note_reminders_before_write ON note_reminders;
DROP FUNCTION note_reminders_compute_next(note_reminders, timestamptz);
DROP TABLE note_reminders;
DROP FUNCTION notes_sync_reminder();
DROP FUNCTION note_reminders_integrity_check();
DROP FUNCTION note_reminder_assert(uuid);
DROP FUNCTION note_reminders_audit_row();
DROP FUNCTION note_reminders_before_write();

DROP FUNCTION note_reminder_occurrences(text, date, date, integer, integer, date, date);
DROP FUNCTION note_reminder_prev_fire(text, time, date, date, integer, integer, timestamptz);
DROP FUNCTION note_reminder_next_fire(text, time, date, date, integer, integer, timestamptz);
DROP FUNCTION note_reminder_last_on_or_before(text, date, date, integer, integer, date);
DROP FUNCTION note_reminder_first_on_or_after(text, date, date, integer, integer, date);
DROP FUNCTION note_reminder_month_day(date, integer);

DROP TABLE notes;
DROP FUNCTION notes_before_write();
