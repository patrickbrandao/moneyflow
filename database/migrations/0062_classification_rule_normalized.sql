-- migrate:up

-- Tarefa 076: a regra aprendida da correção grava o padrão com a descrição normalizada (normalizeDescription do shared:
-- minúsculas, sem acentos, pontuação, números de documento, datas e CNPJ), mas era comparada com a descrição crua e quase
-- nunca casava, nem com a linha de onde nasceu. classification_rule_for ganha p_description_normalized (opcional): exact,
-- starts_with e contains casam com a descrição crua OU com a normalizada (a normalizada também por lower(btrim())); regex
-- continua só na crua. A ordem de escolha (prioridade, tipo, padrão mais longo) não muda. Chamada com quatro
-- argumentos = como antes. Sem migração de dados: as regras já gravadas passam a valer quando a aplicação passar a
-- descrição normalizada.

DROP FUNCTION classification_rule_for(uuid, uuid, text, bigint);
CREATE FUNCTION classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text,
                                        p_amount_cents bigint, p_description_normalized text DEFAULT NULL)
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
     AND coalesce(CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
                                   OR lower(btrim(p_description_normalized)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
                                   OR starts_with(lower(btrim(p_description_normalized)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
                                   OR strpos(lower(p_description_normalized), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END, false)
   ORDER BY r.priority,
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1;
  RETURN rule_id;
END
$$;

COMMENT ON FUNCTION classification_rule_for(uuid, uuid, text, bigint, text) IS
  'Regra ativa do alvo da linha (a conta, ou o cartão; exatamente um) que classifica a descrição (sinal de '
  'p_amount_cents = direção): menor prioridade, exact > starts_with > contains > regex, padrão mais longo. NULL se '
  'nenhuma casa. Para o cartão, passe a caixa do cartão e o valor da linha (compra −). p_description_normalized '
  '(opcional, tarefa 076): a descrição pelo normalizeDescription do shared; exact, starts_with e contains casam com a '
  'crua ou com a normalizada (a regra aprendida guarda o padrão normalizado), regex só com a crua.';

-- migrate:down

DROP FUNCTION classification_rule_for(uuid, uuid, text, bigint, text);
CREATE FUNCTION classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text,
                                        p_amount_cents bigint)
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
