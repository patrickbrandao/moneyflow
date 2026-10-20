-- migrate:up

-- Regras de classificação por conta (spec 032, F18): cada regra tem exatamente um alvo,
-- a conta checking/savings (caixa geral) ou o cartão (caixa credit_card, sem conta).
-- Não existe mais regra global nem regra da caixa inteira. Origem `copy` para a cópia
-- feita pelo usuário entre contas, com o vínculo informativo copied_from_rule_id.

-- A unicidade antiga (por caixa) cai antes da migração dos dados: as cópias de uma regra
-- de caixa ficam na mesma caixa, uma por conta.
DROP INDEX classification_rules_pattern_key;

ALTER TABLE classification_rules
  ADD COLUMN financial_account_id uuid REFERENCES financial_accounts (id) ON DELETE CASCADE,
  ADD COLUMN copied_from_rule_id  uuid REFERENCES classification_rules (id) ON DELETE SET NULL;

ALTER TABLE classification_rules DROP CONSTRAINT classification_rules_origin_check;
ALTER TABLE classification_rules
  ADD CONSTRAINT classification_rules_origin_check CHECK (origin IN ('manual', 'correction', 'agent', 'copy')),
  ADD CONSTRAINT classification_rules_copied_from_check CHECK (
    copied_from_rule_id IS NULL OR (origin = 'copy' AND copied_from_rule_id <> id)
  );

-- Alvo coerente: cartão sem conta; caixa geral com conta checking/savings dela.
CREATE FUNCTION classification_rules_validate_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  caixa_kind text;
  acc        financial_accounts;
BEGIN
  IF NEW.caixa_id IS NULL THEN
    RETURN NEW;  -- o NOT NULL de caixa_id recusa
  END IF;
  SELECT c.kind INTO caixa_kind FROM caixas c WHERE c.id = NEW.caixa_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;

  IF caixa_kind = 'credit_card' THEN
    IF NEW.financial_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'classification_rules: a rule of card % has no account', NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.financial_account_id IS NULL THEN
    RAISE EXCEPTION 'classification_rules: a rule of caixa % needs an account', NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  SELECT * INTO acc FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;
  IF acc.caixa_id <> NEW.caixa_id THEN
    RAISE EXCEPTION 'classification_rules: account % is not in caixa %', acc.id, NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  IF acc.kind NOT IN ('checking', 'savings') THEN
    RAISE EXCEPTION 'classification_rules: account % does not import statements (only checking/savings)', acc.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER classification_rules_validate_target
  BEFORE INSERT OR UPDATE OF caixa_id, financial_account_id ON classification_rules
  FOR EACH ROW EXECUTE FUNCTION classification_rules_validate_target();

-- A conta com regras não muda de caixa nem vira cofre.
CREATE FUNCTION financial_accounts_validate_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.caixa_id <> OLD.caixa_id OR NEW.kind NOT IN ('checking', 'savings'))
     AND EXISTS (SELECT 1 FROM classification_rules r WHERE r.financial_account_id = OLD.id) THEN
    RAISE EXCEPTION 'financial_accounts: account % has classification rules and must stay a checking/savings account of caixa %',
      OLD.id, OLD.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER financial_accounts_validate_rules BEFORE UPDATE OF caixa_id, kind ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate_rules();

-- Migração dos dados --------------------------------------------------------------------------------------
-- Uso interno (migração e o seu pgTAP); sem EXECUTE para a aplicação.
CREATE FUNCTION classification_rules_split_by_target() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('pg_temp.crs_rules') IS NOT NULL THEN DROP TABLE pg_temp.crs_rules; END IF;
  IF to_regclass('pg_temp.crs_pairs') IS NOT NULL THEN DROP TABLE pg_temp.crs_pairs; END IF;

  -- Regras a migrar: as globais e as de caixa geral ainda sem conta.
  CREATE TEMP TABLE crs_rules ON COMMIT DROP AS
  SELECT r.id, r.caixa_id, r.match_kind, r.pattern, r.direction, r.priority, r.archived_at, r.created_from_line_id
    FROM classification_rules r
   WHERE r.financial_account_id IS NULL
     AND (r.caixa_id IS NULL OR EXISTS (SELECT 1 FROM caixas c WHERE c.id = r.caixa_id AND c.kind = 'general'));

  CREATE TEMP TABLE crs_pairs (
    rule_id     uuid    NOT NULL,
    caixa_id    uuid    NOT NULL,
    account_id  uuid,
    lines       integer NOT NULL DEFAULT 0,
    archive     boolean NOT NULL DEFAULT false,
    is_original boolean NOT NULL DEFAULT false,
    new_id      uuid
  ) ON COMMIT DROP;

  -- Alvos: contas checking/savings ativas (da caixa, ou de todas na global), cartões ativos
  -- (só a global) e o alvo de cada linha classificada pela regra (mesmo conta arquivada).
  INSERT INTO crs_pairs (rule_id, caixa_id, account_id)
  SELECT r.id, a.caixa_id, a.id
    FROM crs_rules r
    JOIN financial_accounts a ON a.kind IN ('checking', 'savings') AND a.archived_at IS NULL
                             AND (r.caixa_id IS NULL OR a.caixa_id = r.caixa_id)
  UNION
  SELECT r.id, c.id, NULL
    FROM crs_rules r
    JOIN caixas c ON r.caixa_id IS NULL AND c.kind = 'credit_card' AND c.archived_at IS NULL
  UNION
  SELECT l.classification_rule_id, coalesce(a.caixa_id, l.card_caixa_id), l.financial_account_id
    FROM statement_lines l
    JOIN crs_rules r ON r.id = l.classification_rule_id
    LEFT JOIN financial_accounts a ON a.id = l.financial_account_id
   WHERE l.card_caixa_id IS NOT NULL OR a.kind IN ('checking', 'savings');

  -- Linhas de cada alvo classificadas pela regra.
  UPDATE crs_pairs p
     SET lines = x.n
    FROM (SELECT l.classification_rule_id AS rule_id, l.financial_account_id, l.card_caixa_id, count(*)::int AS n
            FROM statement_lines l
            JOIN crs_rules r ON r.id = l.classification_rule_id
           GROUP BY 1, 2, 3) x
   WHERE x.rule_id = p.rule_id
     AND x.financial_account_id IS NOT DISTINCT FROM p.account_id
     AND (p.account_id IS NOT NULL OR x.card_caixa_id = p.caixa_id);

  -- Unicidade das ativas no alvo: a regra que já é do alvo (a do cartão) fica; entre as
  -- migradas, vence a que já vencia (menor prioridade, a da caixa antes da global). A
  -- perdedora vira cópia arquivada se tem linhas no alvo; senão, não vai para ele.
  WITH cand AS (
    SELECT p.rule_id, p.caixa_id, p.account_id, r.match_kind, lower(r.pattern) AS pat, r.direction,
           false AS fixed, r.priority, (r.caixa_id IS NULL) AS is_global
      FROM crs_pairs p JOIN crs_rules r ON r.id = p.rule_id
     WHERE r.archived_at IS NULL
    UNION ALL
    SELECT r.id, r.caixa_id, r.financial_account_id, r.match_kind, lower(r.pattern), r.direction,
           true, r.priority, false
      FROM classification_rules r
     WHERE r.archived_at IS NULL AND r.caixa_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM crs_rules m WHERE m.id = r.id)
  ), ranked AS (
    SELECT c.*, row_number() OVER (PARTITION BY c.caixa_id, c.account_id, c.match_kind, c.pat, c.direction
                                   ORDER BY c.fixed DESC, c.priority, c.is_global, c.rule_id) AS rn
      FROM cand c
  )
  UPDATE crs_pairs p
     SET archive = true
    FROM ranked k
   WHERE NOT k.fixed AND k.rn > 1
     AND k.rule_id = p.rule_id AND k.caixa_id = p.caixa_id AND k.account_id IS NOT DISTINCT FROM p.account_id;

  DELETE FROM crs_pairs WHERE archive AND lines = 0;

  -- A original fica no alvo com mais linhas (ativo antes de arquivado); os demais são cópias.
  UPDATE crs_pairs p
     SET is_original = true
    FROM (SELECT DISTINCT ON (rule_id) rule_id, caixa_id, account_id
            FROM crs_pairs
           ORDER BY rule_id, lines DESC, archive, account_id NULLS LAST, caixa_id) o
   WHERE o.rule_id = p.rule_id AND o.caixa_id = p.caixa_id AND o.account_id IS NOT DISTINCT FROM p.account_id;
  UPDATE crs_pairs SET new_id = uuidv7() WHERE NOT is_original;

  -- Cópias: a mesma regra no alvo, com a origem da original, o uso do alvo e o histórico.
  INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id,
                                    category_id, priority, origin, created_from_line_id, created_by_user_id,
                                    usage_count, last_used_at, archived_at, created_at, updated_at)
  SELECT p.new_id, p.caixa_id, p.account_id, r.match_kind, r.pattern, r.direction, r.entity_id,
         r.category_id, r.priority, r.origin,
         (SELECT l.id FROM statement_lines l
           WHERE l.id = r.created_from_line_id
             AND l.financial_account_id IS NOT DISTINCT FROM p.account_id
             AND (p.account_id IS NOT NULL OR l.card_caixa_id = p.caixa_id)),
         r.created_by_user_id, p.lines, CASE WHEN p.lines > 0 THEN r.last_used_at END,
         coalesce(r.archived_at, CASE WHEN p.archive THEN now() END), r.created_at, now()
    FROM crs_pairs p
    JOIN classification_rules r ON r.id = p.rule_id
   WHERE NOT p.is_original;

  UPDATE classification_rules r
     SET caixa_id = p.caixa_id,
         financial_account_id = p.account_id,
         usage_count = p.lines,
         last_used_at = CASE WHEN p.lines > 0 THEN r.last_used_at END,
         archived_at = coalesce(r.archived_at, CASE WHEN p.archive THEN now() END)
    FROM crs_pairs p
   WHERE p.rule_id = r.id AND p.is_original;

  -- As linhas passam para a cópia do alvo delas. Só classification_rule_id muda: a
  -- validação da linha, a imutabilidade do lote substituído (0049), o updated_at e a
  -- auditoria das linhas ficam desligados (a auditoria das regras registra a migração).
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_supersede_validate;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;

  UPDATE statement_lines l
     SET classification_rule_id = p.new_id
    FROM crs_pairs p
   WHERE l.classification_rule_id = p.rule_id AND NOT p.is_original
     AND l.financial_account_id IS NOT DISTINCT FROM p.account_id
     AND (p.account_id IS NOT NULL OR l.card_caixa_id = p.caixa_id);

  -- Linha que não tem alvo de regra (conta que deixou de ser checking/savings) solta a regra.
  UPDATE statement_lines l
     SET classification_rule_id = NULL
    FROM classification_rules r
   WHERE l.classification_rule_id = r.id
     AND EXISTS (SELECT 1 FROM crs_rules m WHERE m.id = r.id)
     AND NOT (l.financial_account_id IS NOT DISTINCT FROM r.financial_account_id
              AND (r.financial_account_id IS NOT NULL OR l.card_caixa_id = r.caixa_id));

  -- Sem alvo e sem linha: removida (as globais sempre saem daqui, porque a original ganhou um alvo).
  DELETE FROM classification_rules r
   USING crs_rules m
   WHERE r.id = m.id
     AND NOT EXISTS (SELECT 1 FROM crs_pairs p WHERE p.rule_id = r.id AND p.is_original);

  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_supersede_validate;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

  DROP TABLE pg_temp.crs_pairs;
  DROP TABLE pg_temp.crs_rules;
END
$$;

REVOKE EXECUTE ON FUNCTION classification_rules_split_by_target() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION classification_rules_split_by_target() IS
  'Uso interno (migração 0050, spec 032): leva as regras globais e de caixa geral sem conta para os alvos (conta '
  'checking/savings ou cartão), com uma cópia por alvo, as linhas reapontadas e o uso recontado. Não é usado pela aplicação.';

SELECT classification_rules_split_by_target();

ALTER TABLE classification_rules ALTER COLUMN caixa_id SET NOT NULL;

CREATE UNIQUE INDEX classification_rules_pattern_key
  ON classification_rules (caixa_id, financial_account_id, match_kind, lower(pattern), direction) NULLS NOT DISTINCT
  WHERE archived_at IS NULL;
CREATE INDEX classification_rules_financial_account_id_idx ON classification_rules (financial_account_id);
CREATE INDEX classification_rules_copied_from_rule_id_idx ON classification_rules (copied_from_rule_id);

-- Melhor regra para uma linha: só as do alvo dela ------------------------------------------------------------
DROP FUNCTION classification_rule_for(uuid, text, bigint);

CREATE FUNCTION classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid,
                                        p_description text, p_amount_cents bigint)
RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  rule_id uuid;
BEGIN
  IF num_nonnulls(p_financial_account_id, p_card_caixa_id) <> 1 THEN
    RAISE EXCEPTION 'classification_rule_for: pass exactly one target (account or card)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.id INTO rule_id
    FROM classification_rules r
   WHERE r.archived_at IS NULL
     AND CASE WHEN p_financial_account_id IS NOT NULL
              THEN r.financial_account_id = p_financial_account_id
              ELSE r.caixa_id = p_card_caixa_id AND r.financial_account_id IS NULL END
     AND (r.direction IS NULL OR r.direction = CASE WHEN p_amount_cents > 0 THEN 'in' ELSE 'out' END)
     AND CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END
   ORDER BY r.priority,
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1;
  RETURN rule_id;
END
$$;

COMMENT ON FUNCTION classification_rule_for(uuid, uuid, text, bigint) IS
  'Regra ativa do alvo da linha (a conta, ou o cartão; exatamente um) que classifica a descrição (sinal de '
  'p_amount_cents = direção): menor prioridade, exact > starts_with > contains > regex, padrão mais longo. '
  'NULL se nenhuma casa. Para o cartão, passe a caixa do cartão e o valor da linha (compra −).';

COMMENT ON TABLE classification_rules IS
  'Regras descrição → entidade/categoria (spec 009/032), de uma conta checking/savings ou de um cartão, criadas à mão, '
  'por correção do usuário, sugeridas pelo agente ou copiadas de outra conta. A melhor regra para uma linha: '
  'classification_rule_for().';
COMMENT ON COLUMN classification_rules.caixa_id IS
  'Caixa do alvo: a caixa da conta (financial_account_id) ou o próprio cartão (caixa credit_card, sem conta).';
COMMENT ON COLUMN classification_rules.financial_account_id IS
  'Conta checking/savings da caixa cujas linhas a regra classifica; obrigatória fora do cartão, nula no cartão.';
COMMENT ON COLUMN classification_rules.origin IS
  'manual, correction (aprendida de uma correção do usuário), agent (sugestão aprovada do agente) ou copy (copiada '
  'de outra conta pelo usuário).';
COMMENT ON COLUMN classification_rules.copied_from_rule_id IS
  'Regra de origem da cópia (só em origin = copy; informativo, nulo se a origem foi excluída).';

-- migrate:down

DROP FUNCTION classification_rule_for(uuid, uuid, text, bigint);

CREATE FUNCTION classification_rule_for(p_caixa_id uuid, p_description text, p_amount_cents bigint)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.id
    FROM classification_rules r
   WHERE r.archived_at IS NULL
     AND (r.caixa_id IS NULL OR r.caixa_id = p_caixa_id)
     AND (r.direction IS NULL OR r.direction = CASE WHEN p_amount_cents > 0 THEN 'in' ELSE 'out' END)
     AND CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END
   ORDER BY r.priority,
            (r.caixa_id IS NULL),
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1
$$;

COMMENT ON FUNCTION classification_rule_for(uuid, text, bigint) IS
  'Regra ativa que classifica a descrição (sinal de p_amount_cents = direção) na caixa: menor prioridade, regra da '
  'caixa antes da global, exact > starts_with > contains > regex, padrão mais longo. NULL se nenhuma casa. '
  'Para cartão, passe a caixa do cartão e o valor da linha (compra −).';

DROP FUNCTION classification_rules_split_by_target();
DROP TRIGGER financial_accounts_validate_rules ON financial_accounts;
DROP FUNCTION financial_accounts_validate_rules();
DROP TRIGGER classification_rules_validate_target ON classification_rules;
DROP FUNCTION classification_rules_validate_target();

-- Volta ao escopo por caixa (melhor esforço): as ativas iguais da mesma caixa (cópias por
-- conta) viram uma só, com as linhas e o uso somados; cópias entre caixas não viram global.
CREATE TEMP TABLE crs_merge ON COMMIT DROP AS
SELECT r.id, first_value(r.id) OVER w AS keeper_id
  FROM classification_rules r
 WHERE r.archived_at IS NULL AND r.financial_account_id IS NOT NULL
WINDOW w AS (PARTITION BY r.caixa_id, r.match_kind, lower(r.pattern), r.direction
             ORDER BY (r.origin = 'copy'), r.id);
DELETE FROM crs_merge WHERE id = keeper_id;

ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;

UPDATE statement_lines l SET classification_rule_id = m.keeper_id
  FROM crs_merge m WHERE l.classification_rule_id = m.id;

UPDATE classification_rules k
   SET usage_count = k.usage_count + x.usage_count,
       last_used_at = CASE WHEN x.last_used_at IS NULL THEN k.last_used_at
                           ELSE greatest(k.last_used_at, x.last_used_at) END
  FROM (SELECT m.keeper_id, sum(r.usage_count)::int AS usage_count, max(r.last_used_at) AS last_used_at
          FROM crs_merge m JOIN classification_rules r ON r.id = m.id GROUP BY 1) x
 WHERE k.id = x.keeper_id;

DELETE FROM classification_rules r USING crs_merge m WHERE r.id = m.id;

ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

DROP TABLE crs_merge;

UPDATE classification_rules SET origin = 'manual' WHERE origin = 'copy';

DROP INDEX classification_rules_pattern_key;
DROP INDEX classification_rules_financial_account_id_idx;
DROP INDEX classification_rules_copied_from_rule_id_idx;
ALTER TABLE classification_rules ALTER COLUMN caixa_id DROP NOT NULL;
ALTER TABLE classification_rules DROP CONSTRAINT classification_rules_copied_from_check;
ALTER TABLE classification_rules DROP CONSTRAINT classification_rules_origin_check;
ALTER TABLE classification_rules
  ADD CONSTRAINT classification_rules_origin_check CHECK (origin IN ('manual', 'correction', 'agent'));
ALTER TABLE classification_rules DROP COLUMN copied_from_rule_id, DROP COLUMN financial_account_id;

CREATE UNIQUE INDEX classification_rules_pattern_key
  ON classification_rules (caixa_id, match_kind, lower(pattern), direction) NULLS NOT DISTINCT
  WHERE archived_at IS NULL;

COMMENT ON TABLE classification_rules IS
  'Regras descrição → entidade/categoria (spec 009), criadas à mão, por correção do usuário ou sugeridas pelo agente. '
  'A melhor regra para uma linha: classification_rule_for().';
COMMENT ON COLUMN classification_rules.caixa_id IS 'Escopo: só nesta caixa. Nulo = todas as caixas.';
COMMENT ON COLUMN classification_rules.origin IS 'manual, correction (aprendida de uma correção do usuário) ou agent (sugestão aprovada do agente).';
