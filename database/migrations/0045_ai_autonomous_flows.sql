-- migrate:up
-- F15, fluxos autônomos dos agentes (spec 029; tarefa 032).
--   * Finalidades novas scheduled_task e reconcile_statement em ai_conversations.purpose, ai_usage.purpose e
--     ai_requests.purpose. ai_usage_is_flow já as trata como fluxo (conversa com purpose <> chat; sem conversa, não é
--     um tipo de chamada), sem mudança.
--   * ai_auto_reconcile ("Conciliar com IA ao importar") em financial_accounts (só checking/savings) e em caixas (só
--     credit_card), desligado por padrão.
--   * Tarefas agendadas: ai_scheduled_tasks (agenda em jsonb validada por ai_schedule_valid; next_run_at calculado
--     pelo banco no fuso de São Paulo por ai_schedule_next_run; no máximo 20 ativas por usuário, por trigger) e
--     ai_scheduled_task_runs (um disparo por (tarefa, horário previsto), started|skipped|failed com o motivo). O worker
--     reserva com ai_scheduled_task_claim (FOR UPDATE SKIP LOCKED; atraso acima de 6 h vira skipped) e o "Rodar
--     agora" usa ai_scheduled_task_run_now.
--   * Telegram de entrada: message_destinations ganha inbound_enabled, inbound_agent_id e webhook_secret_hash (SHA-256
--     do secret_token do setWebhook; gravado, nunca lido pelo papel da aplicação), um webhook por bot entre os
--     destinos com entrada ligada, telegram_webhook_authenticate(destino, segredo) e o leitor de backup
--     admin_message_destination_webhook_secret(destino, ator).
--   * Pareamento: telegram_links (um vínculo ativo por destino e chat privado), telegram_pairing_codes (só o hash do
--     código, 10 min, uso único; consumido por telegram_pairing_consume) e telegram_updates_seen (dedup por
--     update_id, purgada por telegram_updates_seen_purge, 7 dias).
--   * audit_row() passa a omitir webhook_secret_hash e code_hash.
--   * Notificação e evento de mensagens ai_awaiting_approval (sem parâmetros).
--   * app_setting_valid aceita telegram.public_base_url (URL https sem barra no fim, sem query nem fragmento).

-- Finalidades novas --------------------------------------------------------------------------------------------------
ALTER TABLE ai_conversations
  DROP CONSTRAINT ai_conversations_purpose_check,
  ADD CONSTRAINT ai_conversations_purpose_check CHECK (purpose IN (
    'chat', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown', 'scheduled_task',
    'reconcile_statement'));

ALTER TABLE ai_usage
  DROP CONSTRAINT ai_usage_purpose_check,
  ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement'));

ALTER TABLE ai_requests
  DROP CONSTRAINT ai_requests_purpose_check,
  ADD CONSTRAINT ai_requests_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement'));

COMMENT ON COLUMN ai_conversations.purpose IS
  'Finalidade, definida no INSERT e imutável: chat (sessão do usuário, padrão) ou o fluxo automático que a criou '
  '(document_reading, classify_lines, contract_reading, contract_markdown, scheduled_task = um disparo de tarefa '
  'agendada, reconcile_statement = conciliação completa de um lote de extrato; mesmo vocabulário de ai_usage.purpose). '
  'Conversas de fluxo ficam fora da sessão ativa (ai_conversations_active_chat_key), da lista e da busca; '
  'scheduled_task e reconcile_statement rodam com as tools do kit do agente, os demais fluxos sem tools. A bifurcação '
  'é sempre chat.';
COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição '
  'de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo '
  'automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading '
  '(leitura do PDF do contrato), contract_markdown (PDF do contrato → markdown), scheduled_task (tarefa agendada) e '
  'reconcile_statement (conciliação completa ao importar). chat numa conversa de fluxo vira a finalidade da conversa.';

-- Conciliar com IA ao importar ---------------------------------------------------------------------------------------
ALTER TABLE financial_accounts
  ADD COLUMN ai_auto_reconcile boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT financial_accounts_ai_auto_reconcile_check
    CHECK (NOT ai_auto_reconcile OR kind IN ('checking', 'savings'));
ALTER TABLE caixas
  ADD COLUMN ai_auto_reconcile boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT caixas_ai_auto_reconcile_check CHECK (NOT ai_auto_reconcile OR kind = 'credit_card');

COMMENT ON COLUMN financial_accounts.ai_auto_reconcile IS
  '"Conciliar com IA ao importar" (spec 029): o import de extrato desta conta dispara a conciliação completa pelo agente '
  'dos fluxos (purpose reconcile_statement). Só em checking/savings (financial_accounts_ai_auto_reconcile_check).';
COMMENT ON COLUMN caixas.ai_auto_reconcile IS
  '"Conciliar com IA ao importar" do cartão (spec 029): o import de extrato da fatura dispara a conciliação completa '
  'pelo agente dos fluxos (purpose reconcile_statement). Só em credit_card (caixas_ai_auto_reconcile_check).';

-- Agenda das tarefas -------------------------------------------------------------------------------------------------
-- Formato (horário HH:MM em America/Sao_Paulo; dia da semana ISO, 1 = segunda … 7 = domingo):
--   {"kind": "daily",   "time": "08:00"}
--   {"kind": "weekly",  "time": "08:00", "weekdays": [1, 3, 5]}
--   {"kind": "monthly", "time": "08:00", "day": 10}       (1–31; dia que o mês não tem = último dia do mês)
--   {"kind": "monthly", "time": "08:00", "day": "last"}   (último dia do mês)
CREATE FUNCTION ai_schedule_valid(p_schedule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
BEGIN
  IF p_schedule IS NULL OR jsonb_typeof(p_schedule) <> 'object' OR jsonb_typeof(p_schedule -> 'kind') <> 'string' THEN
    RETURN false;
  END IF;
  CASE p_schedule ->> 'kind'
    WHEN 'daily' THEN allowed := '{kind,time}';
    WHEN 'weekly' THEN allowed := '{kind,time,weekdays}';
    WHEN 'monthly' THEN allowed := '{kind,time,day}';
    ELSE RETURN false;
  END CASE;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_schedule) k WHERE k <> ALL (allowed)) OR NOT (p_schedule ?& allowed) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_schedule -> 'time') <> 'string' OR p_schedule ->> 'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RETURN false;
  END IF;
  IF p_schedule ? 'weekdays' AND (
       jsonb_typeof(p_schedule -> 'weekdays') <> 'array'
       OR jsonb_array_length(p_schedule -> 'weekdays') NOT BETWEEN 1 AND 7
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule -> 'weekdays') e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[1-7]$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(p_schedule -> 'weekdays') e)
          <> jsonb_array_length(p_schedule -> 'weekdays')) THEN
    RETURN false;
  END IF;
  IF p_schedule ? 'day' AND NOT (
       (jsonb_typeof(p_schedule -> 'day') = 'number' AND (p_schedule -> 'day')::text ~ '^[0-9]{1,2}$'
        AND (p_schedule ->> 'day')::int BETWEEN 1 AND 31)
       OR p_schedule -> 'day' = '"last"'::jsonb) THEN
    RETURN false;
  END IF;
  RETURN true;
END
$$;

COMMENT ON FUNCTION ai_schedule_valid(jsonb) IS
  'true se a agenda de uma tarefa agendada (spec 029) é válida: {"kind": "daily", "time": "HH:MM"}, '
  '{"kind": "weekly", "time", "weekdays": [1–7 distintos, ISO, 1 = segunda]} ou {"kind": "monthly", "time", '
  '"day": 1–31 ou "last"}; só essas chaves, todas obrigatórias. Horário em America/Sao_Paulo.';

CREATE FUNCTION ai_schedule_occurs_on(p_schedule jsonb, p_day date) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_schedule ->> 'kind'
           WHEN 'daily' THEN true
           WHEN 'weekly' THEN (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow FROM p_day)::int)
           WHEN 'monthly' THEN
             extract(day FROM p_day)::int
               = least(CASE WHEN p_schedule -> 'day' = '"last"'::jsonb THEN 31 ELSE (p_schedule ->> 'day')::int END,
                       extract(day FROM (date_trunc('month', p_day) + interval '1 month - 1 day'))::int)
           ELSE false
         END
$$;

COMMENT ON FUNCTION ai_schedule_occurs_on(jsonb, date) IS
  'Interna: a agenda dispara no dia p_day (diária: todo dia; semanal: dia ISO na lista; mensal: o dia, limitado ao '
  'último dia do mês, ou o último dia com "last").';

CREATE FUNCTION ai_schedule_next_run(p_schedule jsonb, p_after timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  d0 date;
  d date;
  t timestamptz;
BEGIN
  IF NOT ai_schedule_valid(p_schedule) OR p_after IS NULL THEN
    RETURN NULL;
  END IF;
  d0 := (p_after AT TIME ZONE 'America/Sao_Paulo')::date;
  FOR i IN 0..62 LOOP
    d := d0 + i;
    CONTINUE WHEN NOT ai_schedule_occurs_on(p_schedule, d);
    t := (d + (p_schedule ->> 'time')::time) AT TIME ZONE 'America/Sao_Paulo';
    IF t > p_after THEN
      RETURN t;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION ai_schedule_next_run(jsonb, timestamptz) IS
  'Próximo disparo da agenda estritamente depois de p_after, no fuso America/Sao_Paulo (dia 31 em mês curto = último '
  'dia do mês; "last" = último dia). NULL com agenda inválida.';

CREATE FUNCTION ai_schedule_prev_run(p_schedule jsonb, p_at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  d0 date;
  d date;
  t timestamptz;
BEGIN
  IF NOT ai_schedule_valid(p_schedule) OR p_at IS NULL THEN
    RETURN NULL;
  END IF;
  d0 := (p_at AT TIME ZONE 'America/Sao_Paulo')::date;
  FOR i IN 0..62 LOOP
    d := d0 - i;
    CONTINUE WHEN NOT ai_schedule_occurs_on(p_schedule, d);
    t := (d + (p_schedule ->> 'time')::time) AT TIME ZONE 'America/Sao_Paulo';
    IF t <= p_at THEN
      RETURN t;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION ai_schedule_prev_run(jsonb, timestamptz) IS
  'Último disparo da agenda em p_at ou antes, no fuso America/Sao_Paulo (o "disparo perdido" mais recente). NULL com '
  'agenda inválida.';

-- Tarefas agendadas --------------------------------------------------------------------------------------------------
CREATE TABLE ai_scheduled_tasks (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id           uuid NOT NULL REFERENCES ai_agents (id),
  name               text NOT NULL,
  instruction        text NOT NULL,
  schedule           jsonb NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  next_run_at        timestamptz,
  last_run_at        timestamptz,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_scheduled_tasks_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT ai_scheduled_tasks_instruction_check CHECK (btrim(instruction) <> '' AND length(instruction) <= 20000),
  CONSTRAINT ai_scheduled_tasks_schedule_check CHECK (ai_schedule_valid(schedule)),
  CONSTRAINT ai_scheduled_tasks_next_run_check CHECK (is_active = (next_run_at IS NOT NULL))
);

CREATE INDEX ai_scheduled_tasks_user_id_idx ON ai_scheduled_tasks (user_id, created_at);
CREATE INDEX ai_scheduled_tasks_agent_id_idx ON ai_scheduled_tasks (agent_id);
CREATE INDEX ai_scheduled_tasks_created_by_user_id_idx ON ai_scheduled_tasks (created_by_user_id);
CREATE INDEX ai_scheduled_tasks_due_idx ON ai_scheduled_tasks (next_run_at) WHERE is_active;

CREATE FUNCTION ai_scheduled_tasks_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'ai_scheduled_tasks: owner of task % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_user_immutable_check';
  END IF;
  IF NOT ai_schedule_valid(NEW.schedule) THEN
    RAISE EXCEPTION 'ai_scheduled_tasks: invalid schedule %', NEW.schedule
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_schedule_check';
  END IF;

  -- No máximo 20 ativas por usuário. A trava por usuário serializa ativações concorrentes do mesmo dono.
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ai_scheduled_tasks:' || NEW.user_id::text, 0));
    IF (SELECT count(*) FROM ai_scheduled_tasks x
         WHERE x.user_id = NEW.user_id AND x.is_active AND x.id <> NEW.id) >= 20 THEN
      RAISE EXCEPTION 'ai_scheduled_tasks: user % already has 20 active tasks', NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_active_limit_check';
    END IF;
  END IF;

  -- Próximo disparo: calculado pelo banco ao criar, ao ativar e ao mudar a agenda; nulo se desativada. O claim o
  -- avança (sem mudar a agenda), e o valor dele fica.
  IF NOT NEW.is_active THEN
    NEW.next_run_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.is_active OR NEW.schedule IS DISTINCT FROM OLD.schedule
        OR NEW.next_run_at IS NULL THEN
    NEW.next_run_at := ai_schedule_next_run(NEW.schedule, now());
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_scheduled_tasks_before_write BEFORE INSERT OR UPDATE ON ai_scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION ai_scheduled_tasks_before_write();
CREATE TRIGGER ai_scheduled_tasks_set_updated_at BEFORE UPDATE ON ai_scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Auditada; o avanço do próximo disparo e o último disparo sozinhos não geram linha.
CREATE TRIGGER ai_scheduled_tasks_audit AFTER INSERT OR UPDATE OR DELETE ON ai_scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION audit_row('next_run_at,last_run_at');

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_scheduled_tasks TO moneyflow_app;

COMMENT ON TABLE ai_scheduled_tasks IS
  'Tarefas agendadas dos agentes (spec 029): a cada disparo, a instrução vai como mensagem do usuário numa sessão '
  'própria (purpose scheduled_task), rodando como o dono (user_id) com as permissões dele. No máximo 20 ativas por '
  'usuário (ai_scheduled_tasks_active_limit_check). Disparos em ai_scheduled_task_runs; reserva por '
  'ai_scheduled_task_claim, "Rodar agora" por ai_scheduled_task_run_now. Auditada (menos next_run_at/last_run_at).';
COMMENT ON COLUMN ai_scheduled_tasks.user_id IS 'Dono: a tarefa roda como ele. Imutável (ai_scheduled_tasks_user_immutable_check).';
COMMENT ON COLUMN ai_scheduled_tasks.agent_id IS
  'Agente que executa. Excluir o agente com tarefas dá 23503 (arquive). Agente inativo ou arquivado: o disparo é '
  'skipped com agent_inactive.';
COMMENT ON COLUMN ai_scheduled_tasks.instruction IS 'Texto enviado como mensagem do usuário a cada disparo (até 20 mil).';
COMMENT ON COLUMN ai_scheduled_tasks.schedule IS
  'Agenda (ai_schedule_valid): {"kind": "daily", "time": "HH:MM"}, {"kind": "weekly", "time", "weekdays": [1–7, ISO]} '
  'ou {"kind": "monthly", "time", "day": 1–31 | "last"}. Fuso America/Sao_Paulo; dia que o mês não tem = último dia.';
COMMENT ON COLUMN ai_scheduled_tasks.is_active IS 'Desligada não dispara e não conta no limite de 20.';
COMMENT ON COLUMN ai_scheduled_tasks.next_run_at IS
  'Próximo disparo, mantido pelo banco (ai_schedule_next_run a partir de agora, ao criar, ativar ou mudar a agenda; '
  'avançado pelo claim). Nulo se e somente se desativada.';
COMMENT ON COLUMN ai_scheduled_tasks.last_run_at IS 'Último disparo que começou (started), agendado ou manual.';
COMMENT ON COLUMN ai_scheduled_tasks.created_by_user_id IS 'Quem criou (o dono ou o admin).';

CREATE TABLE ai_scheduled_task_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  task_id         uuid NOT NULL REFERENCES ai_scheduled_tasks (id) ON DELETE CASCADE,
  scheduled_for   timestamptz NOT NULL,
  trigger_kind    text NOT NULL DEFAULT 'schedule',
  status          text NOT NULL,
  skip_reason     text,
  conversation_id uuid REFERENCES ai_conversations (id) ON DELETE SET NULL,
  run_id          uuid REFERENCES ai_runs (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_scheduled_task_runs_task_scheduled_key UNIQUE (task_id, scheduled_for),
  CONSTRAINT ai_scheduled_task_runs_trigger_kind_check CHECK (trigger_kind IN ('schedule', 'manual')),
  CONSTRAINT ai_scheduled_task_runs_status_check CHECK (status IN ('started', 'skipped', 'failed')),
  CONSTRAINT ai_scheduled_task_runs_reason_check CHECK (
    (status = 'started') = (skip_reason IS NULL) AND length(skip_reason) BETWEEN 1 AND 500),
  CONSTRAINT ai_scheduled_task_runs_run_check CHECK (status = 'started' OR run_id IS NULL)
);

CREATE INDEX ai_scheduled_task_runs_conversation_id_idx ON ai_scheduled_task_runs (conversation_id);
CREATE INDEX ai_scheduled_task_runs_run_id_idx ON ai_scheduled_task_runs (run_id);

CREATE FUNCTION ai_scheduled_task_runs_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id <> OLD.task_id OR NEW.scheduled_for <> OLD.scheduled_for OR NEW.trigger_kind <> OLD.trigger_kind
       OR NEW.created_at <> OLD.created_at
       OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT NULL
           AND NEW.conversation_id <> OLD.conversation_id)
       OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NEW.run_id <> OLD.run_id) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: task, time, trigger and links of run % are immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_immutable_check';
    END IF;
    IF OLD.status <> 'started' AND (NEW.status, NEW.skip_reason) IS DISTINCT FROM (OLD.status, OLD.skip_reason) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: run % is % (final)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_status_transition_check';
    END IF;
  END IF;

  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.conversation_id IS NULL) THEN
    SELECT t.user_id INTO owner FROM ai_scheduled_tasks t WHERE t.id = NEW.task_id;
    IF NOT EXISTS (SELECT 1 FROM ai_conversations c
                    WHERE c.id = NEW.conversation_id AND c.user_id = owner AND c.purpose = 'scheduled_task') THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: conversation % is not a scheduled_task session of the task owner',
        NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_links_check';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.run_id IS NULL) THEN
    IF NEW.conversation_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: run % does not belong to conversation %', NEW.run_id, NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_scheduled_task_runs_before_write BEFORE INSERT OR UPDATE ON ai_scheduled_task_runs
  FOR EACH ROW EXECUTE FUNCTION ai_scheduled_task_runs_before_write();
CREATE TRIGGER ai_scheduled_task_runs_set_updated_at BEFORE UPDATE ON ai_scheduled_task_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_scheduled_task_runs TO moneyflow_app;

COMMENT ON TABLE ai_scheduled_task_runs IS
  'Disparos das tarefas agendadas (spec 029): um por (tarefa, horário previsto) (ai_scheduled_task_runs_task_scheduled_key). '
  'Criados por ai_scheduled_task_claim (agendados) e ai_scheduled_task_run_now (manuais) como started ou skipped; a '
  'aplicação liga a sessão e a execução que criou, ou passa o started a skipped/failed (com o motivo) se não conseguiu '
  'começar. skipped e failed são finais. O resultado da execução está em ai_runs. Fora da auditoria e do backup '
  '(histórico operacional, como ai_runs).';
COMMENT ON COLUMN ai_scheduled_task_runs.scheduled_for IS
  'Horário previsto do disparo (agendado) ou o instante do clique (manual). Imutável.';
COMMENT ON COLUMN ai_scheduled_task_runs.trigger_kind IS 'schedule (pelo worker) ou manual ("Rodar agora").';
COMMENT ON COLUMN ai_scheduled_task_runs.status IS
  'started (começou: a aplicação cria a sessão e a execução), skipped (pulado, com o motivo) ou failed (não conseguiu '
  'começar, com o erro). started pode virar skipped/failed enquanto não tem execução; skipped e failed são finais.';
COMMENT ON COLUMN ai_scheduled_task_runs.skip_reason IS
  'Motivo, obrigatório em skipped/failed e nulo em started (até 500). Do banco: missed_window (atraso acima do prazo, '
  '6 h), previous_run_active (execução anterior ativa), user_inactive, agent_inactive. Da aplicação: os dela (ex.: '
  'budget_exceeded, rate_limited ou a mensagem de erro).';
COMMENT ON COLUMN ai_scheduled_task_runs.conversation_id IS
  'Sessão do disparo (purpose scheduled_task, do dono da tarefa: ai_scheduled_task_runs_links_check). Excluir a sessão '
  'anula o vínculo e o histórico fica.';
COMMENT ON COLUMN ai_scheduled_task_runs.run_id IS
  'Execução do disparo (da conversa acima). Excluída a conversa, vira nula e o histórico fica.';

-- Reserva dos disparos -----------------------------------------------------------------------------------------------
CREATE FUNCTION ai_scheduled_task_skip_reason(p_task ai_scheduled_tasks) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_task.user_id AND u.is_active) THEN 'user_inactive'
           WHEN NOT EXISTS (SELECT 1 FROM ai_agents a
                             WHERE a.id = p_task.agent_id AND a.is_active AND a.archived_at IS NULL) THEN 'agent_inactive'
           WHEN EXISTS (SELECT 1 FROM ai_scheduled_task_runs r
                          LEFT JOIN ai_runs ar ON ar.id = r.run_id
                         WHERE r.task_id = p_task.id AND r.status = 'started'
                           AND (ar.status IN ('queued', 'running', 'awaiting_confirmation')
                                -- Disparo recém-reservado cuja execução a aplicação ainda vai criar.
                                OR (r.run_id IS NULL AND r.conversation_id IS NULL
                                    AND r.created_at > clock_timestamp() - interval '10 minutes'))) THEN
             'previous_run_active'
         END
$$;

COMMENT ON FUNCTION ai_scheduled_task_skip_reason(ai_scheduled_tasks) IS
  'Interna: motivo para pular um disparo agora, ou NULL: user_inactive (dono desativado), agent_inactive (agente '
  'inativo ou arquivado), previous_run_active (um disparo anterior com execução queued/running/awaiting_confirmation, '
  'ou started há menos de 10 min ainda sem sessão nem execução).';

CREATE FUNCTION ai_scheduled_task_claim(p_limit integer DEFAULT 10, p_max_delay interval DEFAULT '6 hours')
RETURNS TABLE (task_run_id uuid, task_id uuid, user_id uuid, agent_id uuid, task_name text, instruction text,
               scheduled_for timestamptz, trigger_kind text, status text, skip_reason text)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  t ai_scheduled_tasks;
  s timestamptz;
  reason text;
  rid uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_max_delay IS NULL OR p_max_delay < interval '1 minute' THEN
    RAISE EXCEPTION 'ai_scheduled_task_claim: limit must be 1..100 and max_delay >= 1 minute'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR t IN SELECT x.* FROM ai_scheduled_tasks x
            WHERE x.is_active AND x.next_run_at <= v_now
            ORDER BY x.next_run_at, x.id
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED LOOP
    -- O disparo perdido mais recente (vários perdidos com o worker parado viram um só).
    s := greatest(t.next_run_at, coalesce(ai_schedule_prev_run(t.schedule, v_now), t.next_run_at));
    reason := CASE WHEN v_now - s > p_max_delay THEN 'missed_window' ELSE ai_scheduled_task_skip_reason(t) END;

    rid := NULL;
    INSERT INTO ai_scheduled_task_runs AS r (task_id, scheduled_for, trigger_kind, status, skip_reason)
    VALUES (t.id, s, 'schedule', CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason)
    ON CONFLICT ON CONSTRAINT ai_scheduled_task_runs_task_scheduled_key DO NOTHING
    RETURNING r.id INTO rid;

    UPDATE ai_scheduled_tasks x
       SET next_run_at = ai_schedule_next_run(x.schedule, greatest(v_now, t.next_run_at)),
           last_run_at = CASE WHEN rid IS NOT NULL AND reason IS NULL THEN v_now ELSE x.last_run_at END
     WHERE x.id = t.id;

    IF rid IS NOT NULL THEN
      RETURN QUERY SELECT rid, t.id, t.user_id, t.agent_id, t.name, t.instruction, s, 'schedule'::text,
                          CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason;
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION ai_scheduled_task_claim(integer, interval) IS
  'Reserva até p_limit tarefas ativas vencidas (next_run_at <= agora) com FOR UPDATE SKIP LOCKED e, para cada uma, grava '
  'o disparo do horário previsto mais recente (vários perdidos viram um) e avança next_run_at para depois de agora. O '
  'disparo sai skipped com missed_window se o atraso passa de p_max_delay (padrão 6 h), com user_inactive, '
  'agent_inactive ou previous_run_active; senão started (last_run_at = agora). Devolve os disparos gravados (started e '
  'skipped); um horário já gravado não se repete (único por tarefa e horário). Para cada started, a aplicação cria a '
  'sessão (purpose scheduled_task) e a execução, de preferência na mesma transação, e grava conversation_id e run_id; '
  'se não puder começar (orçamento, limite, erro), passa o disparo a skipped/failed com o motivo. 22023 com '
  'parâmetros inválidos.';

CREATE FUNCTION ai_scheduled_task_run_now(p_task_id uuid)
RETURNS TABLE (task_run_id uuid, task_id uuid, user_id uuid, agent_id uuid, task_name text, instruction text,
               scheduled_for timestamptz, trigger_kind text, status text, skip_reason text)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  t ai_scheduled_tasks;
  s timestamptz := clock_timestamp();
  reason text;
  rid uuid;
BEGIN
  SELECT x.* INTO t FROM ai_scheduled_tasks x WHERE x.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_scheduled_task_run_now: task % not found', p_task_id USING ERRCODE = 'no_data_found';
  END IF;
  reason := ai_scheduled_task_skip_reason(t);

  INSERT INTO ai_scheduled_task_runs AS r (task_id, scheduled_for, trigger_kind, status, skip_reason)
  VALUES (t.id, s, 'manual', CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason)
  RETURNING r.id INTO rid;
  IF reason IS NULL THEN
    UPDATE ai_scheduled_tasks x SET last_run_at = s WHERE x.id = t.id;
  END IF;

  RETURN QUERY SELECT rid, t.id, t.user_id, t.agent_id, t.name, t.instruction, s, 'manual'::text,
                      CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason;
END
$$;

COMMENT ON FUNCTION ai_scheduled_task_run_now(uuid) IS
  '"Rodar agora": grava um disparo manual (scheduled_for = agora), started ou skipped (user_inactive, agent_inactive, '
  'previous_run_active), e o devolve; vale também para tarefa desligada e não muda next_run_at. A aplicação segue como '
  'no claim. Quem pode (o dono ou o admin) é regra da aplicação. P0002 se a tarefa não existe.';

-- Telegram de entrada ------------------------------------------------------------------------------------------------
CREATE FUNCTION telegram_secret_hash(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
$$;

COMMENT ON FUNCTION telegram_secret_hash(text) IS
  'SHA-256 (hex minúsculo) do texto em UTF-8: o formato de message_destinations.webhook_secret_hash e de '
  'telegram_pairing_codes.code_hash (igual a createHash(''sha256'').update(valor, ''utf8'').digest(''hex'') no Node).';

ALTER TABLE message_destinations
  ADD COLUMN inbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN inbound_agent_id uuid REFERENCES ai_agents (id),
  ADD COLUMN webhook_secret_hash text,
  ADD CONSTRAINT message_destinations_webhook_secret_hash_check CHECK (webhook_secret_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT message_destinations_inbound_check CHECK (
    NOT inbound_enabled OR (is_active AND inbound_agent_id IS NOT NULL AND webhook_secret_hash IS NOT NULL));

CREATE INDEX message_destinations_inbound_agent_id_idx ON message_destinations (inbound_agent_id);
-- Um bot só aceita um webhook: dois destinos do mesmo bot com a entrada ligada se sobrescreveriam no setWebhook.
CREATE UNIQUE INDEX message_destinations_inbound_bot_key ON message_destinations (bot_id) WHERE inbound_enabled;

-- Blindagem por coluna (bot_token, webhook_secret_hash): coluna nova precisa de GRANT SELECT explícito.
GRANT SELECT (inbound_enabled, inbound_agent_id) ON message_destinations TO moneyflow_app;

COMMENT ON COLUMN message_destinations.inbound_enabled IS
  '"Receber mensagens" (spec 029): o bot entrega as mensagens por webhook em /api/telegram/webhook/:id e o agente '
  'inbound_agent_id responde. Exige destino ativo, agente e segredo (message_destinations_inbound_check): desativar ou '
  'arquivar o destino desliga a entrada na mesma operação (e a aplicação chama deleteWebhook). Um destino com a '
  'entrada ligada por bot (message_destinations_inbound_bot_key, 23505). A importação do backup traz false.';
COMMENT ON COLUMN message_destinations.inbound_agent_id IS
  'Agente que responde às mensagens recebidas. Excluir o agente em uso dá 23503 (arquive).';
COMMENT ON COLUMN message_destinations.webhook_secret_hash IS
  'SEGREDO: SHA-256 (hex, telegram_secret_hash) do secret_token enviado no setWebhook. moneyflow_app grava mas NÃO lê '
  'esta coluna; o webhook confere o cabeçalho X-Telegram-Bot-Api-Secret-Token por telegram_webhook_authenticate. '
  'Nunca vai para o audit_log; o backup o lê por admin_message_destination_webhook_secret.';

CREATE FUNCTION telegram_webhook_authenticate(p_destination_id uuid, p_secret text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT d.webhook_secret_hash = public.telegram_secret_hash(p_secret)
                     FROM public.message_destinations d
                    WHERE d.id = p_destination_id AND d.inbound_enabled AND d.is_active AND d.archived_at IS NULL),
                  false)
$$;

REVOKE EXECUTE ON FUNCTION telegram_webhook_authenticate(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telegram_webhook_authenticate(uuid, text) TO moneyflow_app;

COMMENT ON FUNCTION telegram_webhook_authenticate(uuid, text) IS
  'true se p_secret (o cabeçalho X-Telegram-Bot-Api-Secret-Token, como chegou) confere com o segredo do destino e o '
  'destino está ativo, não arquivado e com a entrada ligada; false em qualquer outro caso (destino inexistente, '
  'entrada desligada, segredo errado ou nulo). A API responde 401 com false.';

CREATE FUNCTION admin_message_destination_webhook_secret(p_destination_id uuid, p_actor_user_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_message_destination_webhook_secret: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.webhook_secret_hash INTO h FROM public.message_destinations d WHERE d.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_message_destination_webhook_secret: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN h;
END
$$;

REVOKE EXECUTE ON FUNCTION admin_message_destination_webhook_secret(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_message_destination_webhook_secret(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION admin_message_destination_webhook_secret(uuid, uuid) IS
  'Hash do segredo do webhook (webhook_secret_hash, nulo se nunca ligado) para o export de backup do admin. A '
  'importação traz o destino com inbound_enabled = false (o webhook é de outra instância e precisa ser religado, com um '
  'segredo novo). Erro 42501 se o ator não é admin ativo e P0002 se o destino não existe.';

-- Auditoria: os segredos novos nunca entram no log ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  secrets constant text[] := ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash',
                                   'webhook_secret_hash', 'code_hash'];
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
    IF changed IS NULL OR changed <@ quiet THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o - secrets, n - secrets, changed);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION audit_row() IS
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token, api_key, secret_headers, '
  'token_hash, webhook_secret_hash, code_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = '
  'colunas que sozinhas não geram linha.';

-- Pareamento -------------------------------------------------------------------------------------------------------
CREATE TABLE telegram_links (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  destination_id   uuid NOT NULL REFERENCES message_destinations (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chat_id          bigint NOT NULL,
  telegram_user_id bigint NOT NULL,
  username         text,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_links_chat_id_check CHECK (chat_id > 0),
  CONSTRAINT telegram_links_telegram_user_id_check CHECK (telegram_user_id > 0),
  CONSTRAINT telegram_links_username_check CHECK (username ~ '^[A-Za-z0-9_]{1,64}$')
);

CREATE UNIQUE INDEX telegram_links_active_key ON telegram_links (destination_id, chat_id) WHERE revoked_at IS NULL;
CREATE INDEX telegram_links_destination_id_idx ON telegram_links (destination_id);
CREATE INDEX telegram_links_user_id_idx ON telegram_links (user_id, created_at);

CREATE FUNCTION telegram_links_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_id <> OLD.destination_id OR NEW.user_id <> OLD.user_id OR NEW.chat_id <> OLD.chat_id
     OR NEW.telegram_user_id <> OLD.telegram_user_id THEN
    RAISE EXCEPTION 'telegram_links: destination, user and chat of link % are immutable (pair again)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_links_immutable_check';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'telegram_links: link % is revoked', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_links_revoked_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_links_validate BEFORE UPDATE ON telegram_links
  FOR EACH ROW EXECUTE FUNCTION telegram_links_validate();
CREATE TRIGGER telegram_links_set_updated_at BEFORE UPDATE ON telegram_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Auditada; a troca do @username (vinda do Telegram) sozinha não gera linha.
CREATE TRIGGER telegram_links_audit AFTER INSERT OR UPDATE OR DELETE ON telegram_links
  FOR EACH ROW EXECUTE FUNCTION audit_row('username');

GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_links TO moneyflow_app;

COMMENT ON TABLE telegram_links IS
  'Pareamento de um chat privado do Telegram com um usuário, por destino com entrada (spec 029). Criado por '
  'telegram_pairing_consume (/start <código>). Um ativo por (destino, chat) (telegram_links_active_key); desfazer = '
  'revoked_at (irreversível). Auditada e no backup.';
COMMENT ON COLUMN telegram_links.chat_id IS 'id do chat privado (positivo; grupos e canais não pareiam).';
COMMENT ON COLUMN telegram_links.telegram_user_id IS 'id do usuário do Telegram (no chat privado, igual ao chat_id).';
COMMENT ON COLUMN telegram_links.username IS '@username do Telegram, sem a arroba, quando houver (pode ser atualizado).';
COMMENT ON COLUMN telegram_links.revoked_at IS 'Desfeito em (irreversível; nulo = ativo).';

CREATE TABLE telegram_pairing_codes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES message_destinations (id) ON DELETE CASCADE,
  code_hash      text NOT NULL,
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at        timestamptz,
  link_id        uuid REFERENCES telegram_links (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_pairing_codes_code_hash_key UNIQUE (code_hash),
  CONSTRAINT telegram_pairing_codes_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT telegram_pairing_codes_expires_at_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT telegram_pairing_codes_link_check CHECK (link_id IS NULL OR used_at IS NOT NULL)
);

CREATE INDEX telegram_pairing_codes_user_id_idx ON telegram_pairing_codes (user_id, created_at);
CREATE INDEX telegram_pairing_codes_destination_id_idx ON telegram_pairing_codes (destination_id);
CREATE INDEX telegram_pairing_codes_link_id_idx ON telegram_pairing_codes (link_id);

CREATE FUNCTION telegram_pairing_codes_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM message_destinations d
                    WHERE d.id = NEW.destination_id AND d.inbound_enabled AND d.is_active) THEN
      RAISE EXCEPTION 'telegram_pairing_codes: destination % does not receive messages', NEW.destination_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_pairing_codes_destination_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.destination_id <> OLD.destination_id OR NEW.code_hash <> OLD.code_hash
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.link_id IS NOT NULL AND NEW.link_id IS NOT NULL AND NEW.link_id <> OLD.link_id) THEN
    RAISE EXCEPTION 'telegram_pairing_codes: code % is immutable and single-use', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_pairing_codes_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_pairing_codes_validate BEFORE INSERT OR UPDATE ON telegram_pairing_codes
  FOR EACH ROW EXECUTE FUNCTION telegram_pairing_codes_validate();
CREATE TRIGGER telegram_pairing_codes_set_updated_at BEFORE UPDATE ON telegram_pairing_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER telegram_pairing_codes_audit AFTER INSERT OR UPDATE OR DELETE ON telegram_pairing_codes
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Blindagem do hash: SELECT por coluna. Coluna nova nesta tabela precisa de GRANT SELECT explícito.
REVOKE SELECT ON telegram_pairing_codes FROM moneyflow_app;
GRANT SELECT (id, user_id, destination_id, expires_at, used_at, link_id, created_at, updated_at)
  ON telegram_pairing_codes TO moneyflow_app;

COMMENT ON TABLE telegram_pairing_codes IS
  'Códigos de pareamento do Telegram (spec 029): 8 caracteres, válidos por 10 min, de uso único, para um destino com '
  'entrada. Só o hash é guardado. Crie por telegram_pairing_code_create e consuma por telegram_pairing_consume. '
  'Auditada (sem o hash); fora do backup.';
COMMENT ON COLUMN telegram_pairing_codes.code_hash IS
  'SHA-256 (hex, telegram_secret_hash) do código em maiúsculas. moneyflow_app grava mas NÃO lê esta coluna. Nunca vai '
  'para o audit_log.';
COMMENT ON COLUMN telegram_pairing_codes.expires_at IS 'Expiração: no máximo 10 min depois da criação (padrão).';
COMMENT ON COLUMN telegram_pairing_codes.used_at IS 'Usado em (uma vez só; nulo = ainda não usado).';
COMMENT ON COLUMN telegram_pairing_codes.link_id IS 'Vínculo criado (ou mantido) com este código.';

CREATE FUNCTION telegram_pairing_code_create(p_user_id uuid, p_destination_id uuid, p_code text)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  c text := upper(btrim(p_code));
BEGIN
  IF c IS NULL OR c !~ '^[A-Z0-9]{8}$' THEN
    RAISE EXCEPTION 'telegram_pairing_code_create: the code must have 8 letters or digits'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  INSERT INTO telegram_pairing_codes AS k (user_id, destination_id, code_hash)
  VALUES (p_user_id, p_destination_id, telegram_secret_hash(c))
  RETURNING k.id, k.expires_at;
END
$$;

COMMENT ON FUNCTION telegram_pairing_code_create(uuid, uuid, text) IS
  'Grava um código de pareamento (só o hash do código em maiúsculas), válido por 10 min, e devolve id e expiração. '
  '22023 se o código não tem 8 letras ou dígitos; 23514 telegram_pairing_codes_destination_check se o destino não '
  'está ativo com a entrada ligada; 23505 telegram_pairing_codes_code_hash_key se o código já foi emitido (gere outro). '
  'Quem pode usar o destino é regra da aplicação.';

CREATE FUNCTION telegram_pairing_consume(p_destination_id uuid, p_code text, p_chat_id bigint,
                                         p_telegram_user_id bigint, p_username text DEFAULT NULL)
RETURNS TABLE (link_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  k public.telegram_pairing_codes;
  l public.telegram_links;
  uname text := nullif(ltrim(btrim(p_username), '@'), '');
BEGIN
  IF p_chat_id IS NULL OR p_chat_id <= 0 OR p_telegram_user_id IS NULL OR p_telegram_user_id <= 0 THEN
    RAISE EXCEPTION 'telegram_pairing_consume: only private chats pair (positive chat and user ids)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_code IS NULL THEN
    RETURN;
  END IF;

  SELECT c.* INTO k
    FROM public.telegram_pairing_codes c
    JOIN public.users u ON u.id = c.user_id AND u.is_active
    JOIN public.message_destinations d ON d.id = c.destination_id AND d.inbound_enabled AND d.is_active
   WHERE c.code_hash = public.telegram_secret_hash(upper(btrim(p_code)))
     AND c.destination_id = p_destination_id
     AND c.used_at IS NULL
     AND c.expires_at > clock_timestamp()
     FOR UPDATE OF c;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Quem pareou é o dono do código (o webhook não tem sessão): o ator da auditoria no resto da transação.
  IF nullif(current_setting('app.user_id', true), '') IS NULL THEN
    PERFORM set_config('app.user_id', k.user_id::text, true);
  END IF;

  SELECT x.* INTO l FROM public.telegram_links x
   WHERE x.destination_id = p_destination_id AND x.chat_id = p_chat_id AND x.revoked_at IS NULL
     FOR UPDATE;
  IF FOUND AND l.user_id <> k.user_id THEN
    -- O chat passa para o dono do código: o vínculo anterior é desfeito.
    UPDATE public.telegram_links x SET revoked_at = clock_timestamp() WHERE x.id = l.id;
    l := NULL;
  END IF;

  IF l.id IS NULL THEN
    INSERT INTO public.telegram_links AS x (destination_id, user_id, chat_id, telegram_user_id, username)
    VALUES (p_destination_id, k.user_id, p_chat_id, p_telegram_user_id, uname)
    RETURNING x.* INTO l;
  ELSIF l.username IS DISTINCT FROM uname THEN
    UPDATE public.telegram_links x SET username = uname WHERE x.id = l.id;
  END IF;

  UPDATE public.telegram_pairing_codes c SET used_at = clock_timestamp(), link_id = l.id WHERE c.id = k.id;
  RETURN QUERY SELECT l.id, l.user_id;
END
$$;

REVOKE EXECUTE ON FUNCTION telegram_pairing_consume(uuid, text, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telegram_pairing_consume(uuid, text, bigint, bigint, text) TO moneyflow_app;

COMMENT ON FUNCTION telegram_pairing_consume(uuid, text, bigint, bigint, text) IS
  '/start <código>: confere o código (maiúsculas, sem espaços nas pontas) contra os não usados e não expirados do '
  'destino, de dono ativo e destino ativo com a entrada ligada; marca o código usado e liga o chat ao dono (se o chat '
  'já estava ligado a outro usuário no destino, aquele vínculo é desfeito; se ao mesmo, é mantido). Devolve (link_id, '
  'user_id), ou nenhuma linha com código errado, expirado, usado ou de outro destino. Sem app.user_id na transação, '
  'define-o como o dono do código (ator da auditoria). 22023 se o chat ou o usuário do Telegram não é positivo (só '
  'chats privados pareiam).';

-- Dedup das atualizações do webhook ---------------------------------------------------------------------------------
CREATE TABLE telegram_updates_seen (
  destination_id uuid NOT NULL REFERENCES message_destinations (id) ON DELETE CASCADE,
  update_id      bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_updates_seen_pkey PRIMARY KEY (destination_id, update_id),
  CONSTRAINT telegram_updates_seen_update_id_check CHECK (update_id >= 0)
);

CREATE INDEX telegram_updates_seen_created_at_idx ON telegram_updates_seen (created_at);

REVOKE UPDATE ON telegram_updates_seen FROM moneyflow_app;
GRANT SELECT, INSERT, DELETE ON telegram_updates_seen TO moneyflow_app;

COMMENT ON TABLE telegram_updates_seen IS
  'update_id já recebidos por destino (spec 029), para o webhook ignorar a reentrega do Telegram. Marque por '
  'telegram_update_seen; purga por telegram_updates_seen_purge (7 dias). Fora da auditoria e do backup.';

CREATE FUNCTION telegram_update_seen(p_destination_id uuid, p_update_id bigint) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  WITH ins AS (
    INSERT INTO telegram_updates_seen (destination_id, update_id) VALUES (p_destination_id, p_update_id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT NOT EXISTS (SELECT 1 FROM ins)
$$;

COMMENT ON FUNCTION telegram_update_seen(uuid, bigint) IS
  'Marca o update_id do destino como recebido. Devolve false na primeira vez (processe) e true se já tinha sido visto '
  '(ignore). Chame na mesma transação que processa a atualização, para uma falha não marcar o que não foi feito.';

CREATE FUNCTION telegram_updates_seen_purge(p_keep interval DEFAULT '7 days') RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '1 hour' THEN
    RAISE EXCEPTION 'telegram_updates_seen_purge: keep must be >= 1 hour' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM telegram_updates_seen s WHERE s.created_at < clock_timestamp() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION telegram_updates_seen_purge(interval) IS
  'Apaga os update_id vistos há mais de p_keep (padrão 7 dias; o Telegram desiste de reentregar bem antes) e devolve '
  'quantos. 22023 com prazo nulo ou < 1 hora.';

-- Notificação e evento ai_awaiting_approval ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;

  CASE p_event_kind
    WHEN 'due_reminder' THEN allowed := '{days_before,send_at}'; required := '{days_before,send_at}';
    WHEN 'overdue' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'daily_summary' THEN allowed := '{send_at}'; required := '{send_at}';
    WHEN 'weekly_summary' THEN allowed := '{send_at,weekday}'; required := '{send_at,weekday}';
    WHEN 'card_limit' THEN allowed := '{thresholds_percent}'; required := '{thresholds_percent}';
    WHEN 'reconciliation_divergence' THEN allowed := '{min_difference_cents}'; required := '{}';
    WHEN 'invoice_closed', 'agent_completed', 'agent_message', 'ai_budget_alert', 'ai_awaiting_approval' THEN
      allowed := '{}'; required := '{}';
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
    ELSE RETURN false;
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k <> ALL (allowed))
     OR NOT (p_params ?& required) THEN
    RETURN false;
  END IF;

  IF p_params ? 'send_at' AND (jsonb_typeof(p_params -> 'send_at') <> 'string' OR p_params ->> 'send_at' !~ hhmm) THEN
    RETURN false;
  END IF;
  IF p_params ? 'weekday' AND (jsonb_typeof(p_params -> 'weekday') <> 'number'
                               OR (p_params ->> 'weekday') !~ '^[1-7]$') THEN
    RETURN false;
  END IF;
  IF p_params ? 'repeat_every_days' AND (jsonb_typeof(p_params -> 'repeat_every_days') <> 'number'
                                         OR (p_params ->> 'repeat_every_days') !~ '^[0-9]{1,2}$'
                                         OR (p_params ->> 'repeat_every_days')::int NOT BETWEEN 1 AND 30) THEN
    RETURN false;
  END IF;
  IF p_params ? 'min_difference_cents' AND (jsonb_typeof(p_params -> 'min_difference_cents') <> 'number'
                                            OR (p_params ->> 'min_difference_cents') !~ '^[0-9]{1,15}$') THEN
    RETURN false;
  END IF;

  -- Listas de inteiros: 1–10 valores distintos dentro da faixa.
  FOREACH arr IN ARRAY ARRAY[p_params -> 'days_before', p_params -> 'thresholds_percent'] LOOP
    CONTINUE WHEN arr IS NULL;
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(arr) e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[0-9]{1,3}$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(arr) e) <> jsonb_array_length(arr) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_params ? 'days_before'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent '
  '1–200; repeat_every_days 1–30; invoice_closed, agent_completed, agent_message, ai_budget_alert e '
  'ai_awaiting_approval sem parâmetros). Usada no CHECK de message_subscriptions.';

ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval'));

ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'test'));

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos '
  '(spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), '
  'contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base); '
  'ai_budget_alert (spec 028: orçamento de IA cruzou o aviso ou chegou a 100%; sem parâmetros); ai_awaiting_approval '
  '(spec 029: uma tarefa agendada ou a conciliação com IA espera aprovação; sem parâmetros).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e limiar) ou '
  'ai_awaiting_approval (spec 029: tarefa agendada ou conciliação com IA esperando aprovação).';

-- Configurações: URL pública do webhook -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_key = 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           WHEN p_key IN ('ai.runs_per_minute', 'ai.flow_runs_per_minute') THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,4}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 1000
                  ELSE false
             END
           WHEN p_key = 'telegram.public_base_url' THEN
             coalesce(jsonb_typeof(p_value) = 'string'
                      AND length(p_value #>> '{}') <= 500
                      AND p_value #>> '{}'
                          ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&()*+,;=:@-]+)*$',
                      false)
           ELSE false
         END
$$;

COMMENT ON FUNCTION app_setting_valid(text, jsonb) IS
  'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: '
  'ai.request_retention_days (número inteiro de 1 a 365); na F14 (spec 028), ai.runs_per_minute e '
  'ai.flow_runs_per_minute (número inteiro de 1 a 1000), sempre sem aspas nem casas decimais; na F15 (spec 029), '
  'telegram.public_base_url (texto: URL https://host[:porta][/caminho], sem barra no fim, query nem fragmento, até 500; '
  'vence PUBLIC_BASE_URL).';

-- migrate:down

DELETE FROM app_settings WHERE key = 'telegram.public_base_url';

CREATE OR REPLACE FUNCTION app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_key = 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           WHEN p_key IN ('ai.runs_per_minute', 'ai.flow_runs_per_minute') THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,4}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 1000
                  ELSE false
             END
           ELSE false
         END
$$;

COMMENT ON FUNCTION app_setting_valid(text, jsonb) IS
  'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: '
  'ai.request_retention_days (número inteiro de 1 a 365) e, na F14 (spec 028), ai.runs_per_minute e '
  'ai.flow_runs_per_minute (número inteiro de 1 a 1000), sempre sem aspas nem casas decimais. A fase 029 acrescenta '
  'chaves.';

DELETE FROM notifications WHERE kind = 'ai_awaiting_approval';
DELETE FROM message_outbox WHERE event_kind = 'ai_awaiting_approval';
DELETE FROM message_subscriptions WHERE event_kind = 'ai_awaiting_approval';

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert'));
ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'test'));
ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos '
  '(spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), '
  'contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base); '
  'ai_budget_alert (spec 028: orçamento de IA cruzou o aviso ou chegou a 100%; sem parâmetros).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment ou ai_budget_alert (spec 028; dedup por orçamento, mês e limiar).';

CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;

  CASE p_event_kind
    WHEN 'due_reminder' THEN allowed := '{days_before,send_at}'; required := '{days_before,send_at}';
    WHEN 'overdue' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'daily_summary' THEN allowed := '{send_at}'; required := '{send_at}';
    WHEN 'weekly_summary' THEN allowed := '{send_at,weekday}'; required := '{send_at,weekday}';
    WHEN 'card_limit' THEN allowed := '{thresholds_percent}'; required := '{thresholds_percent}';
    WHEN 'reconciliation_divergence' THEN allowed := '{min_difference_cents}'; required := '{}';
    WHEN 'invoice_closed', 'agent_completed', 'agent_message', 'ai_budget_alert' THEN allowed := '{}'; required := '{}';
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
    ELSE RETURN false;
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k <> ALL (allowed))
     OR NOT (p_params ?& required) THEN
    RETURN false;
  END IF;

  IF p_params ? 'send_at' AND (jsonb_typeof(p_params -> 'send_at') <> 'string' OR p_params ->> 'send_at' !~ hhmm) THEN
    RETURN false;
  END IF;
  IF p_params ? 'weekday' AND (jsonb_typeof(p_params -> 'weekday') <> 'number'
                               OR (p_params ->> 'weekday') !~ '^[1-7]$') THEN
    RETURN false;
  END IF;
  IF p_params ? 'repeat_every_days' AND (jsonb_typeof(p_params -> 'repeat_every_days') <> 'number'
                                         OR (p_params ->> 'repeat_every_days') !~ '^[0-9]{1,2}$'
                                         OR (p_params ->> 'repeat_every_days')::int NOT BETWEEN 1 AND 30) THEN
    RETURN false;
  END IF;
  IF p_params ? 'min_difference_cents' AND (jsonb_typeof(p_params -> 'min_difference_cents') <> 'number'
                                            OR (p_params ->> 'min_difference_cents') !~ '^[0-9]{1,15}$') THEN
    RETURN false;
  END IF;

  -- Listas de inteiros: 1–10 valores distintos dentro da faixa.
  FOREACH arr IN ARRAY ARRAY[p_params -> 'days_before', p_params -> 'thresholds_percent'] LOOP
    CONTINUE WHEN arr IS NULL;
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(arr) e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[0-9]{1,3}$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(arr) e) <> jsonb_array_length(arr) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_params ? 'days_before'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent '
  '1–200; repeat_every_days 1–30; invoice_closed, agent_completed, agent_message e ai_budget_alert sem parâmetros). '
  'Usada no CHECK de message_subscriptions.';

-- Telegram de entrada e pareamento
DROP FUNCTION telegram_updates_seen_purge(interval);
DROP FUNCTION telegram_update_seen(uuid, bigint);
DROP TABLE telegram_updates_seen;
DROP FUNCTION telegram_pairing_consume(uuid, text, bigint, bigint, text);
DROP FUNCTION telegram_pairing_code_create(uuid, uuid, text);
DROP TABLE telegram_pairing_codes;
DROP FUNCTION telegram_pairing_codes_validate();
DROP TABLE telegram_links;
DROP FUNCTION telegram_links_validate();

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  secrets constant text[] := ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash'];
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
    IF changed IS NULL OR changed <@ quiet THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o - secrets, n - secrets, changed);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION audit_row() IS
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token, api_key, secret_headers, '
  'token_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';

DROP FUNCTION admin_message_destination_webhook_secret(uuid, uuid);
DROP FUNCTION telegram_webhook_authenticate(uuid, text);
DROP INDEX message_destinations_inbound_bot_key;
DROP INDEX message_destinations_inbound_agent_id_idx;
ALTER TABLE message_destinations
  DROP CONSTRAINT message_destinations_inbound_check,
  DROP CONSTRAINT message_destinations_webhook_secret_hash_check,
  DROP COLUMN webhook_secret_hash,
  DROP COLUMN inbound_agent_id,
  DROP COLUMN inbound_enabled;
DROP FUNCTION telegram_secret_hash(text);

-- Tarefas agendadas
DROP FUNCTION ai_scheduled_task_run_now(uuid);
DROP FUNCTION ai_scheduled_task_claim(integer, interval);
DROP FUNCTION ai_scheduled_task_skip_reason(ai_scheduled_tasks);
DROP TABLE ai_scheduled_task_runs;
DROP FUNCTION ai_scheduled_task_runs_before_write();
DROP TABLE ai_scheduled_tasks;
DROP FUNCTION ai_scheduled_tasks_before_write();
DROP FUNCTION ai_schedule_prev_run(jsonb, timestamptz);
DROP FUNCTION ai_schedule_next_run(jsonb, timestamptz);
DROP FUNCTION ai_schedule_occurs_on(jsonb, date);
DROP FUNCTION ai_schedule_valid(jsonb);

-- Conciliar com IA ao importar
ALTER TABLE caixas DROP CONSTRAINT caixas_ai_auto_reconcile_check, DROP COLUMN ai_auto_reconcile;
ALTER TABLE financial_accounts
  DROP CONSTRAINT financial_accounts_ai_auto_reconcile_check, DROP COLUMN ai_auto_reconcile;

-- Finalidades: o uso e as requisições voltam a chat (como antes); a sessão da tarefa vira uma sessão chat finalizada e
-- a conciliação completa, um fluxo classify_lines (a finalidade é imutável: o guard sai durante a troca).
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_set_updated_at;
UPDATE ai_requests SET purpose = 'chat' WHERE purpose IN ('scheduled_task', 'reconcile_statement');
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_set_updated_at;
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests
  DROP CONSTRAINT ai_requests_purpose_check,
  ADD CONSTRAINT ai_requests_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech'));

UPDATE ai_usage SET purpose = 'chat' WHERE purpose IN ('scheduled_task', 'reconcile_statement');
ALTER TABLE ai_usage
  DROP CONSTRAINT ai_usage_purpose_check,
  ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech'));

ALTER TABLE ai_conversations DISABLE TRIGGER ai_conversations_purpose_immutable;
UPDATE ai_conversations
   SET purpose = 'chat', archived_at = coalesce(archived_at, now()), archived_reason = coalesce(archived_reason, 'finished')
 WHERE purpose = 'scheduled_task';
UPDATE ai_conversations SET purpose = 'classify_lines' WHERE purpose = 'reconcile_statement';
ALTER TABLE ai_conversations ENABLE TRIGGER ai_conversations_purpose_immutable;
ALTER TABLE ai_conversations
  DROP CONSTRAINT ai_conversations_purpose_check,
  ADD CONSTRAINT ai_conversations_purpose_check CHECK (purpose IN (
    'chat', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown'));

COMMENT ON COLUMN ai_conversations.purpose IS
  'Finalidade, definida no INSERT e imutável: chat (conversa do usuário, padrão) ou o fluxo automático que a criou '
  '(document_reading, classify_lines, contract_reading, contract_markdown; mesmo vocabulário de ai_usage.purpose). '
  'Conversas de fluxo não entram na lista nem na busca e rodam sem tools. A bifurcação é sempre chat.';
COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição '
  'de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo '
  'automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading '
  '(leitura do PDF do contrato) e contract_markdown (PDF do contrato → markdown). chat numa conversa de fluxo vira a '
  'finalidade da conversa.';
