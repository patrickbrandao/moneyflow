-- migrate:up
-- F16, receitas de conciliação (spec 030; tarefa 035).
--   * ai_reconcile_recipes: instrução reutilizável com o agente responsável, dona uma caixa ou global (caixa_id nulo),
--     "rodar ao importar" com a ordem (position), ativo e arquivamento (sem DELETE para a aplicação). Dona imutável.
--     No máximo 50 não arquivadas por dona (ai_reconcile_recipes_active_limit_check). Auditada.
--   * ai_reconcile_recipe_targets: contas (checking/savings) ou cartões vinculados, exatamente um por linha, da caixa
--     dona quando a receita não é global (o cartão: a própria caixa dona ou um cartão cuja pagadora padrão é a dona).
--     No máximo 10 receitas não arquivadas com run_on_import por conta ou cartão
--     (ai_reconcile_recipe_targets_import_limit_check). Tem id próprio (o par não cabe numa chave composta, com uma
--     das duas colunas sempre nula), com único por (receita, conta) e (receita, cartão). Auditada com
--     record_id = recipe_id (histórico da receita).
--   * run_on_import exige pelo menos um alvo, checado no COMMIT (ai_reconcile_recipes_run_on_import_check, deferido).
--   * ai_reconcile_recipe_runs: fila e histórico das execuções (manual|import; queued|started|completed|skipped|
--     failed), fora da auditoria e do backup.
--   * Fila do import: ai_reconcile_import_lock(lote) (advisory lock do lote, o mesmo do play), ai_reconcile_import_busy
--     (lote) (há execução ativa numa conversa reconcile_statement do lote), ai_reconcile_recipe_claim(lote) (reserva a
--     próxima queued por position com SKIP LOCKED) e ai_reconcile_recipe_pending_imports(limite) (lotes com fila
--     pendente e livres, para o worker).
--   * Sem finalidade nova: as execuções usam reconcile_statement; a receita vem de screen_context.recipeId.

-- Receitas -----------------------------------------------------------------------------------------------------------
CREATE TABLE ai_reconcile_recipes (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  caixa_id           uuid REFERENCES caixas (id),
  agent_id           uuid NOT NULL REFERENCES ai_agents (id),
  name               text NOT NULL,
  description        text,
  instruction        text NOT NULL,
  run_on_import      boolean NOT NULL DEFAULT false,
  position           integer NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  archived_at        timestamptz,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_reconcile_recipes_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT ai_reconcile_recipes_description_check CHECK (length(description) <= 2000),
  CONSTRAINT ai_reconcile_recipes_instruction_check CHECK (btrim(instruction) <> '' AND length(instruction) <= 20000),
  CONSTRAINT ai_reconcile_recipes_position_check CHECK (position BETWEEN 0 AND 100000),
  CONSTRAINT ai_reconcile_recipes_active_check CHECK (NOT (is_active AND archived_at IS NOT NULL))
);

CREATE INDEX ai_reconcile_recipes_caixa_id_idx ON ai_reconcile_recipes (caixa_id, position);
CREATE INDEX ai_reconcile_recipes_agent_id_idx ON ai_reconcile_recipes (agent_id);
CREATE INDEX ai_reconcile_recipes_created_by_user_id_idx ON ai_reconcile_recipes (created_by_user_id);

CREATE FUNCTION ai_reconcile_import_limit_check(p_recipe_id uuid, p_account_id uuid, p_card_caixa_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Trava por conta/cartão: serializa vínculos e ativações concorrentes do mesmo alvo.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ai_reconcile_recipe_targets:' || coalesce(p_account_id, p_card_caixa_id)::text, 0));
  IF (SELECT count(DISTINCT r.id)
        FROM ai_reconcile_recipe_targets t
        JOIN ai_reconcile_recipes r ON r.id = t.recipe_id
       WHERE r.run_on_import AND r.archived_at IS NULL AND r.id <> p_recipe_id
         AND (t.financial_account_id = p_account_id OR t.card_caixa_id = p_card_caixa_id)) >= 10 THEN
    RAISE EXCEPTION 'ai_reconcile_recipe_targets: account/card % already has 10 recipes run on import',
      coalesce(p_account_id, p_card_caixa_id)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_import_limit_check';
  END IF;
END
$$;

COMMENT ON FUNCTION ai_reconcile_import_limit_check(uuid, uuid, uuid) IS
  'Interna: recusa (23514 ai_reconcile_recipe_targets_import_limit_check) quando a conta ou o cartão já tem 10 outras '
  'receitas não arquivadas com run_on_import. Trava o alvo (advisory lock) antes de contar.';

CREATE FUNCTION ai_reconcile_recipes_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.caixa_id IS DISTINCT FROM OLD.caixa_id THEN
    RAISE EXCEPTION 'ai_reconcile_recipes: owner of recipe % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_owner_immutable_check';
  END IF;

  -- No máximo 50 não arquivadas por dona (caixa ou global).
  IF NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR OLD.archived_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'ai_reconcile_recipes:' || coalesce(NEW.caixa_id::text, 'global'), 0));
    IF (SELECT count(*) FROM ai_reconcile_recipes x
         WHERE x.caixa_id IS NOT DISTINCT FROM NEW.caixa_id AND x.archived_at IS NULL AND x.id <> NEW.id) >= 50 THEN
      RAISE EXCEPTION 'ai_reconcile_recipes: owner % already has 50 recipes', coalesce(NEW.caixa_id::text, 'global')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_active_limit_check';
    END IF;
  END IF;

  -- Passou a contar no limite de 10 ao importar (ligou run_on_import ou desarquivou): confere cada alvo.
  IF TG_OP = 'UPDATE' AND NEW.run_on_import AND NEW.archived_at IS NULL
     AND NOT (OLD.run_on_import AND OLD.archived_at IS NULL) THEN
    FOR t IN SELECT financial_account_id, card_caixa_id FROM ai_reconcile_recipe_targets WHERE recipe_id = NEW.id LOOP
      PERFORM ai_reconcile_import_limit_check(NEW.id, t.financial_account_id, t.card_caixa_id);
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_reconcile_recipes_before_write BEFORE INSERT OR UPDATE ON ai_reconcile_recipes
  FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipes_before_write();
CREATE TRIGGER ai_reconcile_recipes_set_updated_at BEFORE UPDATE ON ai_reconcile_recipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_reconcile_recipes_audit AFTER INSERT OR UPDATE OR DELETE ON ai_reconcile_recipes
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Excluir = arquivar: sem DELETE para a aplicação (os privilégios padrão do schema dão DML completo).
GRANT SELECT, INSERT, UPDATE ON ai_reconcile_recipes TO moneyflow_app;
REVOKE DELETE ON ai_reconcile_recipes FROM moneyflow_app;

COMMENT ON TABLE ai_reconcile_recipes IS
  'Receitas de conciliação (spec 030): instrução reutilizável (mensagem do usuário) com o agente responsável, '
  'executada sobre um lote de extrato numa sessão nova (purpose reconcile_statement, screen_context.recipeId). Dona '
  'uma caixa ou global (caixa_id nulo). No máximo 50 não arquivadas por dona (ai_reconcile_recipes_active_limit_check). '
  'Excluir = arquivar (sem DELETE para a aplicação). Auditada; no backup.';
COMMENT ON COLUMN ai_reconcile_recipes.caixa_id IS
  'Caixa dona (quem escreve nela edita; quem lê vê) ou nulo = global (só o admin edita; vale para os lotes de qualquer '
  'caixa). Imutável (ai_reconcile_recipes_owner_immutable_check).';
COMMENT ON COLUMN ai_reconcile_recipes.agent_id IS
  'Agente que executa (qualquer agente; o kit dele decide allow/ask). Excluir o agente em uso dá 23503 (arquive).';
COMMENT ON COLUMN ai_reconcile_recipes.instruction IS
  'Texto enviado como mensagem do usuário (até 20 mil), com as variáveis da spec 022 e as do lote; a validação das '
  'variáveis é da aplicação.';
COMMENT ON COLUMN ai_reconcile_recipes.run_on_import IS
  '"Rodar ao importar": entra na fila do import das contas/cartões vinculados (quando ai_auto_reconcile do alvo está '
  'ligado). Exige pelo menos um alvo, checado no COMMIT (ai_reconcile_recipes_run_on_import_check). No máximo 10 não '
  'arquivadas por alvo (ai_reconcile_recipe_targets_import_limit_check).';
COMMENT ON COLUMN ai_reconcile_recipes.position IS 'Ordem (menor primeiro) na lista e na fila do import (0–100000).';
COMMENT ON COLUMN ai_reconcile_recipes.is_active IS
  'Interruptor ativo. Arquivada não pode estar ativa (ai_reconcile_recipes_active_check): ao arquivar, desligue.';
COMMENT ON COLUMN ai_reconcile_recipes.archived_at IS 'Arquivada (a exclusão da tela). Não conta nos limites.';

-- Alvos --------------------------------------------------------------------------------------------------------------
CREATE TABLE ai_reconcile_recipe_targets (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  recipe_id            uuid NOT NULL REFERENCES ai_reconcile_recipes (id) ON DELETE CASCADE,
  financial_account_id uuid REFERENCES financial_accounts (id) ON DELETE CASCADE,
  card_caixa_id        uuid REFERENCES caixas (id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_reconcile_recipe_targets_target_check CHECK (num_nonnulls(financial_account_id, card_caixa_id) = 1)
);

CREATE UNIQUE INDEX ai_reconcile_recipe_targets_account_key ON ai_reconcile_recipe_targets (recipe_id, financial_account_id)
  WHERE financial_account_id IS NOT NULL;
CREATE UNIQUE INDEX ai_reconcile_recipe_targets_card_key ON ai_reconcile_recipe_targets (recipe_id, card_caixa_id)
  WHERE card_caixa_id IS NOT NULL;
CREATE INDEX ai_reconcile_recipe_targets_recipe_id_idx ON ai_reconcile_recipe_targets (recipe_id);
CREATE INDEX ai_reconcile_recipe_targets_financial_account_id_idx ON ai_reconcile_recipe_targets (financial_account_id);
CREATE INDEX ai_reconcile_recipe_targets_card_caixa_id_idx ON ai_reconcile_recipe_targets (card_caixa_id);

CREATE FUNCTION ai_reconcile_recipe_targets_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r ai_reconcile_recipes;
  owner uuid;
  payer uuid;
  k text;
BEGIN
  SELECT x.* INTO r FROM ai_reconcile_recipes x WHERE x.id = NEW.recipe_id;
  IF NOT FOUND THEN
    RETURN NEW; -- a FK recusa
  END IF;

  IF NEW.financial_account_id IS NOT NULL THEN
    SELECT a.caixa_id, a.kind INTO owner, k FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    IF FOUND AND k NOT IN ('checking', 'savings') THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: account % does not import statements (only checking/savings)',
        NEW.financial_account_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_kind_check';
    END IF;
    IF FOUND AND r.caixa_id IS NOT NULL AND owner <> r.caixa_id THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: account % is not of caixa %', NEW.financial_account_id, r.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_owner_check';
    END IF;
  ELSIF NEW.card_caixa_id IS NOT NULL THEN
    SELECT c.kind, c.default_payer_caixa_id INTO k, payer FROM caixas c WHERE c.id = NEW.card_caixa_id;
    IF FOUND AND k <> 'credit_card' THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: caixa % is not a credit card', NEW.card_caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_kind_check';
    END IF;
    -- O cartão é uma caixa própria: vale a receita do próprio cartão ou a da pagadora padrão dele.
    IF FOUND AND r.caixa_id IS NOT NULL AND r.caixa_id <> NEW.card_caixa_id AND payer IS DISTINCT FROM r.caixa_id THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: card % is not of caixa %', NEW.card_caixa_id, r.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_owner_check';
    END IF;
  END IF;

  IF r.run_on_import AND r.archived_at IS NULL
     AND (TG_OP = 'INSERT' OR (NEW.recipe_id, NEW.financial_account_id, NEW.card_caixa_id)
                              IS DISTINCT FROM (OLD.recipe_id, OLD.financial_account_id, OLD.card_caixa_id)) THEN
    PERFORM ai_reconcile_import_limit_check(NEW.recipe_id, NEW.financial_account_id, NEW.card_caixa_id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_reconcile_recipe_targets_before_write BEFORE INSERT OR UPDATE ON ai_reconcile_recipe_targets
  FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipe_targets_before_write();
CREATE TRIGGER ai_reconcile_recipe_targets_set_updated_at BEFORE UPDATE ON ai_reconcile_recipe_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION ai_reconcile_recipe_targets_audit_row() RETURNS trigger
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
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed,
                      coalesce(n ->> 'recipe_id', o ->> 'recipe_id')::uuid);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION ai_reconcile_recipe_targets_audit_row() IS
  'Trigger de auditoria de ai_reconcile_recipe_targets: grava com record_id = recipe_id, para vincular e desvincular '
  'contas aparecerem no histórico da receita.';

CREATE TRIGGER ai_reconcile_recipe_targets_audit AFTER INSERT OR UPDATE OR DELETE ON ai_reconcile_recipe_targets
  FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipe_targets_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_reconcile_recipe_targets TO moneyflow_app;

COMMENT ON TABLE ai_reconcile_recipe_targets IS
  'Contas e cartões vinculados a uma receita (spec 030): exatamente um dos dois por linha '
  '(ai_reconcile_recipe_targets_target_check), sem repetir na mesma receita (…_account_key, …_card_key). Conta só '
  'checking/savings e cartão só credit_card (ai_reconcile_recipe_targets_kind_check). Receita de caixa: a conta da '
  'caixa dona, e o cartão que é a caixa dona ou cuja pagadora padrão é a dona; global: qualquer um '
  '(ai_reconcile_recipe_targets_owner_check). No máximo 10 receitas não arquivadas com run_on_import por alvo '
  '(ai_reconcile_recipe_targets_import_limit_check). Sem vínculo, a receita vale para todos os lotes da dona. Some com a '
  'receita, a conta ou o cartão (CASCADE). Trocar vínculos pode apagar (DELETE). Auditada com record_id = recipe_id; no '
  'backup (tem id próprio).';
COMMENT ON COLUMN ai_reconcile_recipe_targets.financial_account_id IS 'Conta corrente/poupança vinculada (ou nulo).';
COMMENT ON COLUMN ai_reconcile_recipe_targets.card_caixa_id IS 'Cartão (caixa credit_card) vinculado (ou nulo).';

-- run_on_import exige alvo (no COMMIT) -------------------------------------------------------------------------------
CREATE FUNCTION ai_reconcile_recipes_run_on_import_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rid uuid;
BEGIN
  -- O registro de cada tabela só tem os campos dela: o id da receita sai por to_jsonb.
  IF TG_TABLE_NAME = 'ai_reconcile_recipes' THEN
    rid := NEW.id;
  ELSE
    -- Alvo removido ou trocado de receita: confere a receita de antes.
    rid := (to_jsonb(OLD) ->> 'recipe_id')::uuid;
  END IF;
  IF EXISTS (SELECT 1 FROM ai_reconcile_recipes r
              WHERE r.id = rid AND r.run_on_import
                AND NOT EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = r.id)) THEN
    RAISE EXCEPTION 'ai_reconcile_recipes: recipe % runs on import but has no account or card', rid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_run_on_import_check';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION ai_reconcile_recipes_run_on_import_check() IS
  'Constraint trigger deferida: receita com run_on_import precisa de pelo menos um alvo no COMMIT '
  '(23514 ai_reconcile_recipes_run_on_import_check). Crie a receita e os alvos na mesma transação.';

CREATE CONSTRAINT TRIGGER ai_reconcile_recipes_run_on_import_check
  AFTER INSERT OR UPDATE OF run_on_import ON ai_reconcile_recipes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipes_run_on_import_check();
CREATE CONSTRAINT TRIGGER ai_reconcile_recipe_targets_run_on_import_check
  AFTER DELETE OR UPDATE OF recipe_id ON ai_reconcile_recipe_targets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipes_run_on_import_check();

-- Execuções ----------------------------------------------------------------------------------------------------------
CREATE TABLE ai_reconcile_recipe_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  recipe_id       uuid NOT NULL REFERENCES ai_reconcile_recipes (id) ON DELETE CASCADE,
  import_id       uuid NOT NULL REFERENCES statement_imports (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  trigger_kind    text NOT NULL,
  position        integer,
  line_ids        uuid[],
  status          text NOT NULL,
  skip_reason     text,
  conversation_id uuid REFERENCES ai_conversations (id) ON DELETE SET NULL,
  run_id          uuid REFERENCES ai_runs (id) ON DELETE SET NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_reconcile_recipe_runs_trigger_kind_check CHECK (trigger_kind IN ('manual', 'import')),
  CONSTRAINT ai_reconcile_recipe_runs_status_check CHECK (status IN ('queued', 'started', 'completed', 'skipped', 'failed')),
  CONSTRAINT ai_reconcile_recipe_runs_position_check CHECK ((trigger_kind = 'import') = (position IS NOT NULL)),
  CONSTRAINT ai_reconcile_recipe_runs_queued_check CHECK (status <> 'queued' OR trigger_kind = 'import'),
  CONSTRAINT ai_reconcile_recipe_runs_line_ids_check CHECK (cardinality(line_ids) >= 1),
  CONSTRAINT ai_reconcile_recipe_runs_reason_check CHECK (
    (status IN ('skipped', 'failed')) = (skip_reason IS NOT NULL) AND length(skip_reason) BETWEEN 1 AND 500),
  CONSTRAINT ai_reconcile_recipe_runs_run_check CHECK (status NOT IN ('queued', 'skipped') OR run_id IS NULL)
);

-- A mesma receita entra uma vez na fila de um import.
CREATE UNIQUE INDEX ai_reconcile_recipe_runs_import_queue_key ON ai_reconcile_recipe_runs (import_id, recipe_id)
  WHERE trigger_kind = 'import';
CREATE INDEX ai_reconcile_recipe_runs_import_id_idx ON ai_reconcile_recipe_runs (import_id, status, position);
CREATE INDEX ai_reconcile_recipe_runs_recipe_id_idx ON ai_reconcile_recipe_runs (recipe_id, created_at DESC);
CREATE INDEX ai_reconcile_recipe_runs_user_id_idx ON ai_reconcile_recipe_runs (user_id);
CREATE INDEX ai_reconcile_recipe_runs_conversation_id_idx ON ai_reconcile_recipe_runs (conversation_id);
CREATE INDEX ai_reconcile_recipe_runs_run_id_idx ON ai_reconcile_recipe_runs (run_id);
CREATE INDEX ai_reconcile_recipe_runs_queued_idx ON ai_reconcile_recipe_runs (created_at) WHERE status = 'queued';

-- Achar as conversas de conciliação de um lote (screen_context.importId).
CREATE INDEX ai_conversations_reconcile_import_idx ON ai_conversations ((screen_context ->> 'importId'))
  WHERE purpose = 'reconcile_statement';

CREATE FUNCTION ai_reconcile_recipe_runs_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.recipe_id <> OLD.recipe_id OR NEW.import_id <> OLD.import_id OR NEW.user_id <> OLD.user_id
       OR NEW.trigger_kind <> OLD.trigger_kind OR NEW.created_at <> OLD.created_at
       OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT NULL
           AND NEW.conversation_id <> OLD.conversation_id)
       OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NEW.run_id <> OLD.run_id) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: recipe, import, user, trigger and links of run % are immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_immutable_check';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'queued' AND NEW.status IN ('started', 'skipped', 'failed'))
         OR (OLD.status = 'started' AND NEW.status IN ('completed', 'skipped', 'failed'))) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_status_transition_check';
    END IF;
    IF OLD.status IN ('completed', 'skipped', 'failed') AND NEW.skip_reason IS DISTINCT FROM OLD.skip_reason THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % is % (final)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_status_transition_check';
    END IF;
  END IF;

  IF NEW.status IN ('started', 'completed') AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;
  IF NEW.status IN ('completed', 'skipped', 'failed') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := clock_timestamp();
  END IF;

  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.conversation_id IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM ai_conversations c
                    WHERE c.id = NEW.conversation_id AND c.user_id = NEW.user_id
                      AND c.purpose = 'reconcile_statement') THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: conversation % is not a reconcile_statement session of user %',
        NEW.conversation_id, NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_links_check';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.run_id IS NULL) THEN
    IF NEW.conversation_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % does not belong to conversation %', NEW.run_id, NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_reconcile_recipe_runs_before_write BEFORE INSERT OR UPDATE ON ai_reconcile_recipe_runs
  FOR EACH ROW EXECUTE FUNCTION ai_reconcile_recipe_runs_before_write();
CREATE TRIGGER ai_reconcile_recipe_runs_set_updated_at BEFORE UPDATE ON ai_reconcile_recipe_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Histórico: sem DELETE para a aplicação (some com o lote, por CASCADE).
GRANT SELECT, INSERT, UPDATE ON ai_reconcile_recipe_runs TO moneyflow_app;
REVOKE DELETE ON ai_reconcile_recipe_runs FROM moneyflow_app;

COMMENT ON TABLE ai_reconcile_recipe_runs IS
  'Execuções das receitas (spec 030): a fila do import (trigger_kind import, criadas queued com position) e o play '
  '(manual, criadas started). queued → started|skipped|failed; started → completed|skipped|failed; completed, skipped '
  'e failed são finais (ai_reconcile_recipe_runs_status_transition_check). A aplicação liga a sessão e a execução, '
  'grava line_ids ao começar e passa a completed/failed quando a execução termina. O resultado está em ai_runs. Fora da '
  'auditoria e do backup.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.user_id IS 'Quem disparou (o clique, ou quem importou): roda como ele.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.trigger_kind IS 'manual (play) ou import (fila do import).';
COMMENT ON COLUMN ai_reconcile_recipe_runs.position IS
  'Ordem na fila do import (a position da receita ao enfileirar); obrigatória em import, nula em manual.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.line_ids IS
  'Linhas do extrato no escopo (as selecionadas ou as pendentes ao começar); nulo enquanto queued ou se pulada.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.status IS 'queued, started, completed, skipped ou failed.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.skip_reason IS
  'Motivo, obrigatório em skipped/failed e nulo nos demais (até 500). Do banco (claim): recipe_inactive, '
  'agent_inactive, user_inactive. Da aplicação: no_lines, budget_exceeded, rate_limited ou a mensagem de erro.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.conversation_id IS
  'Sessão da execução (purpose reconcile_statement, de user_id: ai_reconcile_recipe_runs_links_check). Excluída, o '
  'histórico fica.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.run_id IS 'Execução (ai_runs) da sessão acima.';
COMMENT ON COLUMN ai_reconcile_recipe_runs.started_at IS 'Quando passou a started (pelo banco).';
COMMENT ON COLUMN ai_reconcile_recipe_runs.finished_at IS 'Quando chegou a completed/skipped/failed (pelo banco).';

-- Fila do import -----------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_reconcile_import_lock(p_import_id uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ai_reconcile_import:' || p_import_id::text, 0))
$$;

COMMENT ON FUNCTION ai_reconcile_import_lock(uuid) IS
  'Advisory lock (da transação) do lote: o play, a conciliação genérica e ai_reconcile_recipe_claim o tomam antes de '
  'conferir ai_reconcile_import_busy e criar a execução, para duas execuções nunca começarem juntas no mesmo lote.';

CREATE FUNCTION ai_reconcile_import_busy(p_import_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM ai_conversations c
                   JOIN ai_runs r ON r.conversation_id = c.id
                  WHERE c.purpose = 'reconcile_statement' AND c.screen_context ->> 'importId' = p_import_id::text
                    AND r.status IN ('queued', 'running', 'awaiting_confirmation'))
      OR EXISTS (SELECT 1 FROM ai_reconcile_recipe_runs x
                  WHERE x.import_id = p_import_id AND x.status = 'started' AND x.run_id IS NULL
                    AND x.started_at > clock_timestamp() - interval '10 minutes')
$$;

COMMENT ON FUNCTION ai_reconcile_import_busy(uuid) IS
  'true se o lote tem execução ativa: uma conversa reconcile_statement com screen_context.importId = lote e uma ai_runs '
  'queued/running/awaiting_confirmation, ou uma execução de receita started há menos de 10 min ainda sem a ai_runs '
  '(recém-reservada). O play responde 409 com true.';

CREATE FUNCTION ai_reconcile_recipe_claim(p_import_id uuid)
RETURNS TABLE (recipe_run_id uuid, recipe_id uuid, import_id uuid, user_id uuid, agent_id uuid, recipe_name text,
               instruction text, "position" integer)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  x ai_reconcile_recipe_runs;
  rc ai_reconcile_recipes;
  reason text;
BEGIN
  PERFORM ai_reconcile_import_lock(p_import_id);
  IF ai_reconcile_import_busy(p_import_id) THEN
    RETURN;
  END IF;

  LOOP
    SELECT q.* INTO x FROM ai_reconcile_recipe_runs q
     WHERE q.import_id = p_import_id AND q.status = 'queued'
     ORDER BY q.position, q.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT r.* INTO rc FROM ai_reconcile_recipes r WHERE r.id = x.recipe_id;
    reason := CASE
                WHEN NOT rc.is_active OR rc.archived_at IS NOT NULL THEN 'recipe_inactive'
                WHEN NOT EXISTS (SELECT 1 FROM ai_agents a
                                  WHERE a.id = rc.agent_id AND a.is_active AND a.archived_at IS NULL) THEN 'agent_inactive'
                WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = x.user_id AND u.is_active) THEN 'user_inactive'
              END;
    IF reason IS NOT NULL THEN
      UPDATE ai_reconcile_recipe_runs q SET status = 'skipped', skip_reason = reason WHERE q.id = x.id;
      CONTINUE;
    END IF;

    UPDATE ai_reconcile_recipe_runs q SET status = 'started' WHERE q.id = x.id;
    RETURN QUERY SELECT x.id, rc.id, x.import_id, x.user_id, rc.agent_id, rc.name, rc.instruction, x.position;
    RETURN;
  END LOOP;
END
$$;

COMMENT ON FUNCTION ai_reconcile_recipe_claim(uuid) IS
  'Fila do import (spec 030): toma o lock do lote (ai_reconcile_import_lock) e, se o lote não está ocupado '
  '(ai_reconcile_import_busy), reserva a próxima execução queued por position (FOR UPDATE SKIP LOCKED), passa-a a '
  'started e a devolve (zero ou uma linha). Antes, pula (skipped) as da vez com recipe_inactive (receita desligada ou '
  'arquivada), agent_inactive ou user_inactive. Lote ocupado ou fila vazia: nenhuma linha. A aplicação calcula as linhas '
  'pendentes (sem nenhuma, skipped no_lines e chama de novo), cria a sessão e a execução na mesma transação e grava '
  'line_ids, conversation_id e run_id; se não puder começar, passa a failed/skipped com o motivo.';

CREATE FUNCTION ai_reconcile_recipe_pending_imports(p_limit integer DEFAULT 20)
RETURNS TABLE (import_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT q.import_id
    FROM ai_reconcile_recipe_runs q
   WHERE q.status = 'queued'
   GROUP BY q.import_id
  HAVING NOT ai_reconcile_import_busy(q.import_id)
   ORDER BY min(q.created_at), q.import_id
   LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
$$;

COMMENT ON FUNCTION ai_reconcile_recipe_pending_imports(integer) IS
  'Lotes com execução de receita queued e sem execução ativa (ai_reconcile_import_busy), o mais antigo primeiro, até '
  'p_limit (1–100, padrão 20): o worker chama ai_reconcile_recipe_claim para cada um.';

-- migrate:down

DROP FUNCTION ai_reconcile_recipe_pending_imports(integer);
DROP FUNCTION ai_reconcile_recipe_claim(uuid);
DROP FUNCTION ai_reconcile_import_busy(uuid);
DROP FUNCTION ai_reconcile_import_lock(uuid);
DROP INDEX ai_conversations_reconcile_import_idx;
DROP TABLE ai_reconcile_recipe_runs;
DROP FUNCTION ai_reconcile_recipe_runs_before_write();
DROP TABLE ai_reconcile_recipe_targets;
DROP FUNCTION ai_reconcile_recipe_targets_audit_row();
DROP FUNCTION ai_reconcile_recipe_targets_before_write();
DROP TABLE ai_reconcile_recipes;
DROP FUNCTION ai_reconcile_recipes_run_on_import_check();
DROP FUNCTION ai_reconcile_recipes_before_write();
DROP FUNCTION ai_reconcile_import_limit_check(uuid, uuid, uuid);
DELETE FROM audit_log WHERE table_name IN ('ai_reconcile_recipes', 'ai_reconcile_recipe_targets');
