-- migrate:up

-- Lote provisório de extrato e a troca pelo consolidado (spec 031, F17).
--   * statement_imports: provisional (só lote de conta), superseded_by_import_id/superseded_at (só provisório, por um
--     lote da mesma conta; final; sem excluir o substituído nem o substituto) e, no COMMIT, provisórios ativos sem
--     sobreposição e toda linha do substituído com desfecho.
--   * statement_lines: provisional (cópia do lote, mantida pelo banco) e a dedup por conta só entre as linhas de lotes
--     não provisórios; o estado superseded, superseded_by_line_id, supersede_outcome com as transições, a sugestão da
--     IA e a linha do substituído somente leitura fora do desfecho.
--   * Mês fechado: o fechamento é recusado com provisório ativo ou linha pending no mês; o provisório não entra em mês
--     fechado.
--   * statement_import_balances ganha provisional e superseded; a finalidade supersede_pairs nas conversas, no uso e nas
--     requisições ao provedor.

-- Lote -----------------------------------------------------------------------------------------------------------------
ALTER TABLE statement_imports
  ADD COLUMN provisional boolean NOT NULL DEFAULT false,
  ADD COLUMN superseded_by_import_id uuid REFERENCES statement_imports (id),
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT statement_imports_provisional_check CHECK (NOT provisional OR financial_account_id IS NOT NULL),
  ADD CONSTRAINT statement_imports_superseded_check CHECK (
    (superseded_by_import_id IS NULL) = (superseded_at IS NULL)
    AND (superseded_by_import_id IS NULL OR (provisional AND superseded_by_import_id <> id))
  );

CREATE INDEX statement_imports_superseded_by_import_id_idx ON statement_imports (superseded_by_import_id);
CREATE INDEX statement_imports_provisional_active_idx ON statement_imports (financial_account_id, period_start)
  WHERE provisional AND superseded_by_import_id IS NULL;

COMMENT ON COLUMN statement_imports.provisional IS
  'Lote provisório (spec 031): extrato parcial de conta (nunca de cartão) importado antes do consolidado do mês. As '
  'linhas dele ficam fora da deduplicação da conta (statement_lines.provisional). Provisórios ativos da mesma conta não '
  'se sobrepõem (no COMMIT); não vira provisório com linha em mês fechado nem se já substituiu outro lote.';
COMMENT ON COLUMN statement_imports.superseded_by_import_id IS
  'Lote (da mesma conta, não substituído no momento da troca) que substituiu este provisório; preenchido junto com '
  'superseded_at. Final: provisional, superseded_by_import_id e superseded_at não mudam mais, o lote não é excluído e o '
  'substituto também não (FK). Toda linha do substituído tem supersede_outcome (no COMMIT).';
COMMENT ON COLUMN statement_imports.superseded_at IS 'Instante da troca pelo consolidado (junto com superseded_by_import_id).';

-- Linhas ---------------------------------------------------------------------------------------------------------------
ALTER TABLE statement_lines
  ADD COLUMN provisional boolean NOT NULL DEFAULT false,
  ADD COLUMN superseded_by_line_id uuid REFERENCES statement_lines (id),
  ADD COLUMN supersede_outcome text,
  ADD COLUMN supersede_suggested_line_id uuid REFERENCES statement_lines (id),
  ADD COLUMN supersede_suggestion_reason text,
  DROP CONSTRAINT statement_lines_status_check,
  ADD CONSTRAINT statement_lines_status_check CHECK (status IN ('matched', 'suggested', 'new', 'ignored', 'superseded')),
  -- pending continua conciliada (matched); os demais desfechos e só eles são superseded (sem vínculo, pelo links_check,
  -- e sem created_entry, pelo created_entry_check); transferred e paired apontam para a linha do consolidado.
  ADD CONSTRAINT statement_lines_supersede_outcome_check CHECK (
    (supersede_outcome IS NULL
     OR supersede_outcome IN ('transferred', 'paired', 'dropped', 'pending', 'kept', 'entry_deleted'))
    AND (status = 'superseded') = coalesce(supersede_outcome <> 'pending', false)
    AND (supersede_outcome IS DISTINCT FROM 'pending' OR status = 'matched')
    AND (superseded_by_line_id IS NOT NULL) = coalesce(supersede_outcome IN ('transferred', 'paired'), false)
    AND superseded_by_line_id IS DISTINCT FROM id
  ),
  ADD CONSTRAINT statement_lines_supersede_suggestion_check CHECK (
    (supersede_suggested_line_id IS NULL OR supersede_outcome IS NOT DISTINCT FROM 'pending')
    AND (supersede_suggestion_reason IS NULL
         OR (supersede_suggested_line_id IS NOT NULL
             AND btrim(supersede_suggestion_reason) <> '' AND length(supersede_suggestion_reason) <= 500))
  );

-- Deduplicação por conta só entre as linhas de lotes não provisórios (o índice do cartão fica como está).
DROP INDEX statement_lines_account_dedup_key;
CREATE UNIQUE INDEX statement_lines_account_dedup_key ON statement_lines (financial_account_id, dedup_hash)
  WHERE financial_account_id IS NOT NULL AND NOT provisional;

CREATE INDEX statement_lines_superseded_by_line_id_idx ON statement_lines (superseded_by_line_id);
CREATE INDEX statement_lines_supersede_suggested_line_id_idx ON statement_lines (supersede_suggested_line_id);
CREATE INDEX statement_lines_supersede_pending_idx ON statement_lines (financial_account_id, posted_on)
  WHERE supersede_outcome = 'pending';

COMMENT ON TABLE statement_lines IS
  'Linhas de um extrato importado (spec 009), deduplicadas por conta (só entre lotes não provisórios) ou cartão via '
  'dedup_hash. matched = conciliada (movimento ou item de fatura), suggested = casamento proposto aguardando '
  'confirmação, new = sem par (vira baixa ou movimento avulso), ignored = descartada, superseded = linha de um lote '
  'provisório substituído pelo consolidado (spec 031), sem vínculo, com o desfecho em supersede_outcome.';
COMMENT ON COLUMN statement_lines.provisional IS
  'Cópia de statement_imports.provisional, mantida pelo banco (preenchida no INSERT; acompanha o lote ao marcar ou '
  'desmarcar). Linha provisória fica fora de statement_lines_account_dedup_key; desmarcar um lote cujas linhas repetem '
  'as de outro lote não provisório dá 23505.';
COMMENT ON COLUMN statement_lines.superseded_by_line_id IS
  'transferred/paired: a linha do lote que substituiu o desta linha (statement_imports.superseded_by_import_id), que '
  'ficou no lugar dela.';
COMMENT ON COLUMN statement_lines.supersede_outcome IS
  'Só em linha de lote substituído (spec 031), e toda linha dele tem um: transferred (conciliação passada à linha do '
  'consolidado), paired (ignorada/nova com par; a classificação passou), dropped (ignorada/nova sem par), pending '
  '(conciliada sem par: continua matched, aguardando o usuário), kept (pendente que soltou o vínculo e manteve o '
  'lançamento), entry_deleted (pendente cujo lançamento criado pela linha foi excluído). Na troca, matched vira '
  'transferred ou pending e as demais, paired ou dropped; pending só sai para transferred, kept ou entry_deleted (este '
  'só com created_entry); os outros são finais.';
COMMENT ON COLUMN statement_lines.supersede_suggested_line_id IS
  'Só em pending: par sugerido pela IA (fluxo supersede_pairs), uma linha do lote substituto com o mesmo amount_cents. '
  'A aplicação limpa ao aprovar, descartar ou sair de pending.';
COMMENT ON COLUMN statement_lines.supersede_suggestion_reason IS 'Motivo curto da sugestão da IA (até 500 caracteres).';

-- Validação do lote: provisório, substituição e imutabilidade do substituído ---------------------------------------------
CREATE FUNCTION statement_imports_supersede_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target statement_imports;
  caixa  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.superseded_by_import_id IS NOT NULL THEN
      RAISE EXCEPTION 'statement_imports: import % was superseded and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_immutable_check';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.superseded_by_import_id IS NOT NULL
     AND (NEW.provisional IS DISTINCT FROM OLD.provisional
          OR NEW.superseded_by_import_id IS DISTINCT FROM OLD.superseded_by_import_id
          OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'statement_imports: import % was superseded; provisional and the supersession are final', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_immutable_check';
  END IF;

  -- A troca: o substituto é da mesma conta e, no UPDATE (a troca ao vivo), não está substituído. No INSERT (restauração
  -- de um backup) a cadeia já aconteceu e o substituto pode ter sido substituído depois.
  IF NEW.superseded_by_import_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.superseded_by_import_id IS NULL) THEN
    SELECT * INTO target FROM statement_imports i WHERE i.id = NEW.superseded_by_import_id;
    IF FOUND AND (target.financial_account_id IS DISTINCT FROM NEW.financial_account_id
                  OR (TG_OP = 'UPDATE' AND target.superseded_by_import_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'statement_imports: import % can only be superseded by an import of the same account that is not superseded',
        NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_by_check';
    END IF;
  END IF;

  -- Marcar como provisório.
  IF TG_OP = 'UPDATE' AND NEW.provisional AND NOT OLD.provisional THEN
    IF EXISTS (SELECT 1 FROM statement_imports s WHERE s.superseded_by_import_id = NEW.id) THEN
      RAISE EXCEPTION 'statement_imports: import % already superseded another import and cannot become provisional', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_provisional_supersedes_check';
    END IF;
    SELECT a.caixa_id INTO caixa FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    IF EXISTS (SELECT 1 FROM statement_lines l
                WHERE l.statement_import_id = NEW.id AND period_is_closed(caixa, l.posted_on)) THEN
      RAISE EXCEPTION 'statement_imports: import % has lines in a closed month of caixa % and cannot become provisional',
        NEW.id, caixa
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_closed_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statement_imports_supersede_validate BEFORE INSERT OR UPDATE OR DELETE ON statement_imports
  FOR EACH ROW EXECUTE FUNCTION statement_imports_supersede_validate();

-- As linhas acompanham a marca do lote (desmarcar com linha repetida viola statement_lines_account_dedup_key: 23505).
CREATE FUNCTION statement_imports_sync_provisional() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE statement_lines SET provisional = NEW.provisional
   WHERE statement_import_id = NEW.id AND provisional IS DISTINCT FROM NEW.provisional;
  RETURN NULL;
END
$$;

CREATE TRIGGER statement_imports_sync_provisional AFTER UPDATE OF provisional ON statement_imports
  FOR EACH ROW WHEN (NEW.provisional IS DISTINCT FROM OLD.provisional)
  EXECUTE FUNCTION statement_imports_sync_provisional();

-- No COMMIT: provisórios ativos da conta sem sobreposição; toda linha do substituído com desfecho.
CREATE FUNCTION statement_imports_supersede_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imp   statement_imports;
  other uuid;
BEGIN
  SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF imp.provisional AND imp.superseded_by_import_id IS NULL THEN
    -- Serializa os provisórios da conta: quem chega depois relê depois do COMMIT do outro.
    PERFORM pg_advisory_xact_lock(hashtextextended('statement_imports_provisional:' || imp.financial_account_id::text, 0));
    SELECT s.id INTO other
      FROM statement_imports s
     WHERE s.financial_account_id = imp.financial_account_id AND s.id <> imp.id
       AND s.provisional AND s.superseded_by_import_id IS NULL
       AND s.period_start <= imp.period_end AND imp.period_start <= s.period_end
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'statement_imports: provisional import % overlaps active provisional import % of the same account',
        imp.id, other
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_provisional_overlap_check';
    END IF;
  END IF;

  IF imp.superseded_by_import_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM statement_lines l WHERE l.statement_import_id = imp.id AND l.supersede_outcome IS NULL) THEN
    RAISE EXCEPTION 'statement_imports: every line of superseded import % needs a supersede_outcome', imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_lines_check';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER statement_imports_supersede_commit_check
  AFTER INSERT OR UPDATE OF provisional, period_start, period_end, superseded_by_import_id ON statement_imports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION statement_imports_supersede_commit_check();

-- Validação da linha: marca provisória, desfecho, transições e a linha do substituído somente leitura ----------------------
CREATE FUNCTION statement_lines_supersede_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imp            statement_imports;
  target         statement_lines;
  caixa          uuid;
  links_changed  boolean;
  class_changed  boolean;
  sugg_changed   boolean;
  line_changed   boolean;
  swap_ok        boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM statement_imports i
                WHERE i.id = OLD.statement_import_id AND i.superseded_by_import_id IS NOT NULL) THEN
      RAISE EXCEPTION 'statement_lines: line % belongs to a superseded import and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.statement_import_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;

  -- A marca é a do lote: copiada no INSERT; só muda acompanhando o lote.
  IF TG_OP = 'INSERT' THEN
    NEW.provisional := imp.provisional;
  ELSIF NEW.provisional IS DISTINCT FROM OLD.provisional AND NEW.provisional IS DISTINCT FROM imp.provisional THEN
    RAISE EXCEPTION 'statement_lines: provisional of line % follows its import %', OLD.id, imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_check';
  END IF;

  -- Provisório ativo não entra em mês fechado.
  IF TG_OP = 'INSERT' AND imp.provisional AND imp.superseded_by_import_id IS NULL THEN
    SELECT a.caixa_id INTO caixa FROM financial_accounts a WHERE a.id = imp.financial_account_id;
    IF period_is_closed(caixa, NEW.posted_on) THEN
      RAISE EXCEPTION 'statement_lines: provisional import % cannot have a line in closed month % of caixa %',
        imp.id, to_char(NEW.posted_on, 'YYYY-MM'), caixa
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_closed_check';
    END IF;
  END IF;

  -- Desfecho só em lote substituído; linha de lote substituído sempre com desfecho.
  IF imp.superseded_by_import_id IS NULL THEN
    IF NEW.supersede_outcome IS NOT NULL THEN
      RAISE EXCEPTION 'statement_lines: supersede_outcome only on lines of a superseded import (line %)', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_import_check';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.supersede_outcome IS NULL THEN
    RAISE EXCEPTION 'statement_lines: a line of superseded import % needs a supersede_outcome', imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_lines_check';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    links_changed := NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id
                     OR NEW.title_id IS DISTINCT FROM OLD.title_id
                     OR NEW.card_invoice_item_id IS DISTINCT FROM OLD.card_invoice_item_id
                     OR NEW.matched_at IS DISTINCT FROM OLD.matched_at
                     OR NEW.created_entry IS DISTINCT FROM OLD.created_entry;
    -- A regra excluída (FK ON DELETE SET NULL) pode soltar classification_rule_id.
    class_changed := NEW.entity_id IS DISTINCT FROM OLD.entity_id
                     OR NEW.category_id IS DISTINCT FROM OLD.category_id
                     OR NEW.classification_source IS DISTINCT FROM OLD.classification_source
                     OR (NEW.classification_rule_id IS DISTINCT FROM OLD.classification_rule_id
                         AND NEW.classification_rule_id IS NOT NULL);
    sugg_changed  := NEW.supersede_suggested_line_id IS DISTINCT FROM OLD.supersede_suggested_line_id
                     OR NEW.supersede_suggestion_reason IS DISTINCT FROM OLD.supersede_suggestion_reason;
    line_changed  := NEW.superseded_by_line_id IS DISTINCT FROM OLD.superseded_by_line_id;

    -- A troca: a conciliada transfere ou fica pendente (como está); as demais casam ou são descartadas.
    swap_ok := CASE NEW.supersede_outcome
                 WHEN 'transferred' THEN OLD.status = 'matched'
                 WHEN 'pending'     THEN OLD.status = 'matched' AND NOT links_changed
                 WHEN 'paired'      THEN OLD.status <> 'matched'
                 WHEN 'dropped'     THEN OLD.status <> 'matched'
                 ELSE false
               END;

    IF class_changed THEN
      RAISE EXCEPTION 'statement_lines: line % of a superseded import cannot change its classification', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
    END IF;

    IF OLD.supersede_outcome IS NULL THEN
      IF NEW.supersede_outcome IS NULL THEN
        IF links_changed OR line_changed OR sugg_changed THEN
          RAISE EXCEPTION 'statement_lines: line % of a superseded import only changes by its supersede outcome', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
        END IF;
      ELSIF NOT swap_ok THEN
        RAISE EXCEPTION 'statement_lines: line % (status %) cannot be superseded as %', OLD.id, OLD.status, NEW.supersede_outcome
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
    ELSIF OLD.supersede_outcome = 'pending' THEN
      IF NEW.supersede_outcome = 'pending' THEN
        IF links_changed OR line_changed THEN
          RAISE EXCEPTION 'statement_lines: pending line % only changes by leaving pending or by its suggestion', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
        END IF;
      ELSIF NOT coalesce(NEW.supersede_outcome IN ('transferred', 'kept')
                         OR (NEW.supersede_outcome = 'entry_deleted' AND OLD.created_entry IS NOT NULL), false) THEN
        RAISE EXCEPTION 'statement_lines: pending line % cannot become %', OLD.id, coalesce(NEW.supersede_outcome, 'NULL')
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
    ELSE
      IF NEW.supersede_outcome IS DISTINCT FROM OLD.supersede_outcome THEN
        RAISE EXCEPTION 'statement_lines: supersede outcome % of line % is final', OLD.supersede_outcome, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
      IF links_changed OR line_changed OR sugg_changed THEN
        RAISE EXCEPTION 'statement_lines: line % of a superseded import is read-only', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
      END IF;
    END IF;
  END IF;

  -- A linha que ficou no lugar e a sugestão: do lote substituto (a sugestão com o mesmo valor).
  IF NEW.superseded_by_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.superseded_by_line_id IS DISTINCT FROM OLD.superseded_by_line_id) THEN
    SELECT * INTO target FROM statement_lines l WHERE l.id = NEW.superseded_by_line_id;
    IF FOUND AND (target.statement_import_id <> imp.superseded_by_import_id
                  OR target.financial_account_id IS DISTINCT FROM NEW.financial_account_id) THEN
      RAISE EXCEPTION 'statement_lines: line % must be superseded by a line of import %', NEW.id, imp.superseded_by_import_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_by_line_check';
    END IF;
  END IF;

  IF NEW.supersede_suggested_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.supersede_suggested_line_id IS DISTINCT FROM OLD.supersede_suggested_line_id) THEN
    SELECT * INTO target FROM statement_lines l WHERE l.id = NEW.supersede_suggested_line_id;
    IF FOUND AND (target.statement_import_id <> imp.superseded_by_import_id OR target.amount_cents <> NEW.amount_cents) THEN
      RAISE EXCEPTION 'statement_lines: suggestion for line % must be a line of import % with the same amount',
        NEW.id, imp.superseded_by_import_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_suggestion_target_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statement_lines_supersede_validate BEFORE INSERT OR UPDATE OR DELETE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION statement_lines_supersede_validate();

-- A cópia da marca nas linhas não gera auditoria própria (a do lote registra a troca).
DROP TRIGGER statement_lines_audit ON statement_lines;
CREATE TRIGGER statement_lines_audit AFTER INSERT OR UPDATE OR DELETE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row('provisional');

-- Fechamento de mês ----------------------------------------------------------------------------------------------------
CREATE FUNCTION period_closings_provisional_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imports text;
BEGIN
  SELECT string_agg(DISTINCT l.statement_import_id::text, ', ') INTO imports
    FROM statement_lines l
    JOIN financial_accounts a ON a.id = l.financial_account_id
    JOIN statement_imports i ON i.id = l.statement_import_id
   WHERE a.caixa_id = NEW.caixa_id
     AND l.posted_on >= NEW.month AND l.posted_on < (NEW.month + interval '1 month')::date
     AND ((i.provisional AND i.superseded_by_import_id IS NULL) OR l.supersede_outcome = 'pending');
  IF imports IS NOT NULL THEN
    RAISE EXCEPTION 'period_closings: month % of caixa % has lines of an active provisional import or pending lines (imports: %)',
      to_char(NEW.month, 'YYYY-MM'), NEW.caixa_id, imports
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_provisional_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER period_closings_provisional_check BEFORE INSERT ON period_closings
  FOR EACH ROW EXECUTE FUNCTION period_closings_provisional_check();

-- Divergência ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW statement_import_balances WITH (security_invoker = true) AS
SELECT i.id AS statement_import_id,
       i.financial_account_id,
       i.card_caixa_id,
       i.period_start,
       i.period_end,
       i.bank_balance_on,
       i.bank_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN financial_account_balance_at(i.financial_account_id, i.bank_balance_on) END AS app_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN i.bank_balance_cents - financial_account_balance_at(i.financial_account_id, i.bank_balance_on)
       END AS difference_cents,
       coalesce(c.lines, 0)::int AS lines,
       coalesce(c.matched, 0)::int AS matched_lines,
       coalesce(c.suggested, 0)::int AS suggested_lines,
       coalesce(c.new, 0)::int AS new_lines,
       coalesce(c.ignored, 0)::int AS ignored_lines,
       i.provisional,
       i.superseded_by_import_id IS NOT NULL AS superseded
  FROM statement_imports i
  LEFT JOIN LATERAL (
    SELECT count(*) AS lines,
           count(*) FILTER (WHERE l.status = 'matched') AS matched,
           count(*) FILTER (WHERE l.status = 'suggested') AS suggested,
           count(*) FILTER (WHERE l.status = 'new') AS new,
           count(*) FILTER (WHERE l.status = 'ignored') AS ignored
      FROM statement_lines l WHERE l.statement_import_id = i.id
  ) c ON true;

COMMENT ON VIEW statement_import_balances IS
  'Por lote: saldo informado pelo banco × saldo do app na mesma data (difference_cents = banco − app; 0 = sem '
  'divergência) e contagem de linhas por status (lines inclui as superseded). Saldo só para contas (não para cartão). '
  'provisional e superseded (spec 031): a aplicação tira os substituídos da divergência e do "lote anterior".';

-- IA: finalidade supersede_pairs (fluxo JSON, sem tools) -----------------------------------------------------------------
ALTER TABLE ai_conversations
  DROP CONSTRAINT ai_conversations_purpose_check,
  ADD CONSTRAINT ai_conversations_purpose_check CHECK (purpose IN (
    'chat', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown', 'scheduled_task',
    'reconcile_statement', 'supersede_pairs'));

ALTER TABLE ai_usage
  DROP CONSTRAINT ai_usage_purpose_check,
  ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement', 'supersede_pairs'));

ALTER TABLE ai_requests
  DROP CONSTRAINT ai_requests_purpose_check,
  ADD CONSTRAINT ai_requests_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement', 'supersede_pairs'));

COMMENT ON COLUMN ai_conversations.purpose IS
  'Finalidade, definida no INSERT e imutável: chat (sessão do usuário, padrão) ou o fluxo automático que a criou '
  '(document_reading, classify_lines, contract_reading, contract_markdown, supersede_pairs = pares das sobras do lote '
  'provisório substituído, scheduled_task = um disparo de tarefa agendada, reconcile_statement = conciliação completa '
  'de um lote de extrato; mesmo vocabulário de ai_usage.purpose). Conversas de fluxo ficam fora da sessão ativa '
  '(ai_conversations_active_chat_key), da lista e da busca; scheduled_task e reconcile_statement rodam com as tools do '
  'kit do agente, os demais fluxos sem tools. A bifurcação é sempre chat.';
COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição '
  'de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo '
  'automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading '
  '(leitura do PDF do contrato), contract_markdown (PDF do contrato → markdown), scheduled_task (tarefa agendada), '
  'reconcile_statement (conciliação completa ao importar) e supersede_pairs (pares das sobras do lote provisório '
  'substituído). chat numa conversa de fluxo vira a finalidade da conversa.';

-- migrate:down

-- Finalidade: o fluxo vira classify_lines (a finalidade é imutável: o guard sai durante a troca).
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_set_updated_at;
UPDATE ai_requests SET purpose = 'classify_lines' WHERE purpose = 'supersede_pairs';
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_set_updated_at;
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests
  DROP CONSTRAINT ai_requests_purpose_check,
  ADD CONSTRAINT ai_requests_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement'));

UPDATE ai_usage SET purpose = 'classify_lines' WHERE purpose = 'supersede_pairs';
ALTER TABLE ai_usage
  DROP CONSTRAINT ai_usage_purpose_check,
  ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN (
    'chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
    'vision_describe', 'transcription', 'speech', 'scheduled_task', 'reconcile_statement'));

ALTER TABLE ai_conversations DISABLE TRIGGER ai_conversations_purpose_immutable;
UPDATE ai_conversations SET purpose = 'classify_lines' WHERE purpose = 'supersede_pairs';
ALTER TABLE ai_conversations ENABLE TRIGGER ai_conversations_purpose_immutable;
ALTER TABLE ai_conversations
  DROP CONSTRAINT ai_conversations_purpose_check,
  ADD CONSTRAINT ai_conversations_purpose_check CHECK (purpose IN (
    'chat', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown', 'scheduled_task',
    'reconcile_statement'));

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

-- Divergência: as colunas novas saem (CREATE OR REPLACE não remove colunas).
DROP VIEW statement_import_balances;
CREATE VIEW statement_import_balances WITH (security_invoker = true) AS
SELECT i.id AS statement_import_id,
       i.financial_account_id,
       i.card_caixa_id,
       i.period_start,
       i.period_end,
       i.bank_balance_on,
       i.bank_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN financial_account_balance_at(i.financial_account_id, i.bank_balance_on) END AS app_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN i.bank_balance_cents - financial_account_balance_at(i.financial_account_id, i.bank_balance_on)
       END AS difference_cents,
       coalesce(c.lines, 0)::int AS lines,
       coalesce(c.matched, 0)::int AS matched_lines,
       coalesce(c.suggested, 0)::int AS suggested_lines,
       coalesce(c.new, 0)::int AS new_lines,
       coalesce(c.ignored, 0)::int AS ignored_lines
  FROM statement_imports i
  LEFT JOIN LATERAL (
    SELECT count(*) AS lines,
           count(*) FILTER (WHERE l.status = 'matched') AS matched,
           count(*) FILTER (WHERE l.status = 'suggested') AS suggested,
           count(*) FILTER (WHERE l.status = 'new') AS new,
           count(*) FILTER (WHERE l.status = 'ignored') AS ignored
      FROM statement_lines l WHERE l.statement_import_id = i.id
  ) c ON true;

COMMENT ON VIEW statement_import_balances IS
  'Por lote: saldo informado pelo banco × saldo do app na mesma data (difference_cents = banco − app; 0 = sem '
  'divergência) e contagem de linhas por status. Saldo só para contas (não para cartão).';

DROP TRIGGER period_closings_provisional_check ON period_closings;
DROP FUNCTION period_closings_provisional_check();

DROP TRIGGER statement_lines_audit ON statement_lines;
CREATE TRIGGER statement_lines_audit AFTER INSERT OR UPDATE OR DELETE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER statement_lines_supersede_validate ON statement_lines;
DROP FUNCTION statement_lines_supersede_validate();
DROP TRIGGER statement_imports_supersede_commit_check ON statement_imports;
DROP FUNCTION statement_imports_supersede_commit_check();
DROP TRIGGER statement_imports_sync_provisional ON statement_imports;
DROP FUNCTION statement_imports_sync_provisional();
DROP TRIGGER statement_imports_supersede_validate ON statement_imports;
DROP FUNCTION statement_imports_supersede_validate();

DROP INDEX statement_lines_supersede_pending_idx;
DROP INDEX statement_lines_supersede_suggested_line_id_idx;
DROP INDEX statement_lines_superseded_by_line_id_idx;
DROP INDEX statement_lines_account_dedup_key;
ALTER TABLE statement_lines
  DROP CONSTRAINT statement_lines_supersede_suggestion_check,
  DROP CONSTRAINT statement_lines_supersede_outcome_check,
  DROP CONSTRAINT statement_lines_status_check;

-- Dados: a linha substituída vira ignorada (sem vínculo, como era) e a linha provisória que repete o hash de outra
-- linha da conta ganha um hash próprio, para o índice único voltar a valer sobre todas as linhas. Só esses campos
-- mudam: a validação, o updated_at e a auditoria ficam desligados durante o UPDATE.
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;
UPDATE statement_lines SET status = 'ignored' WHERE status = 'superseded';
UPDATE statement_lines l SET dedup_hash = 'provisional:' || l.id::text
 WHERE l.provisional AND l.financial_account_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM statement_lines o
                WHERE o.financial_account_id = l.financial_account_id AND o.dedup_hash = l.dedup_hash AND o.id <> l.id
                  AND (NOT o.provisional OR o.id < l.id));
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

ALTER TABLE statement_lines
  ADD CONSTRAINT statement_lines_status_check CHECK (status IN ('matched', 'suggested', 'new', 'ignored')),
  DROP COLUMN supersede_suggestion_reason,
  DROP COLUMN supersede_suggested_line_id,
  DROP COLUMN supersede_outcome,
  DROP COLUMN superseded_by_line_id,
  DROP COLUMN provisional;
CREATE UNIQUE INDEX statement_lines_account_dedup_key ON statement_lines (financial_account_id, dedup_hash)
  WHERE financial_account_id IS NOT NULL;

COMMENT ON TABLE statement_lines IS
  'Linhas de um extrato importado (spec 009), deduplicadas por conta (ou cartão) via dedup_hash. '
  'matched = conciliada (movimento ou item de fatura), suggested = casamento proposto aguardando confirmação, '
  'new = sem par (vira baixa ou movimento avulso), ignored = descartada.';

DROP INDEX statement_imports_provisional_active_idx;
DROP INDEX statement_imports_superseded_by_import_id_idx;
ALTER TABLE statement_imports
  DROP CONSTRAINT statement_imports_superseded_check,
  DROP CONSTRAINT statement_imports_provisional_check,
  DROP COLUMN superseded_at,
  DROP COLUMN superseded_by_import_id,
  DROP COLUMN provisional;
