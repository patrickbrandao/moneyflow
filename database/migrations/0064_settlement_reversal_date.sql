-- migrate:up

-- Tarefa 045: corrigir a data do estorno de uma baixa. O estorno lança, em cada perna com conta, o movimento oposto na
-- data informada (padrão: hoje); quando o estorno serve para refazer a baixa, a data certa é a da própria baixa. As
-- funções abaixo são o caminho da aplicação (SECURITY INVOKER: a auditoria sai com o ator da transação, app.user_id):
--   * settlement_reversal_movements(baixa): as pernas (a baixa e a do espelho) com o movimento de estorno de cada uma,
--     para a prévia e para o Access nas caixas das pernas;
--   * settlement_reversal_set_date(baixa, data): muda a data do movimento de estorno das duas pernas.
-- Regras: a baixa está estornada; a data não é antes da baixa (como já exige o COMMIT, movements_settlement_check) nem
-- da abertura da conta (movements_opening_date_check, pelo trigger); mês fechado na data antiga ou na nova recusa
-- (period_closings_locked_check, pelo trigger); movimento de estorno conciliado com linha de extrato recusa
-- (settlements_reversal_reconciled_check: desfaça a conciliação antes, a linha é o que o banco mostrou).

CREATE FUNCTION settlement_reversal_movements(p_settlement_id uuid)
RETURNS TABLE (settlement_id uuid, title_id uuid, caixa_id uuid, settled_on date, reversed_at timestamptz,
               movement_id uuid, financial_account_id uuid, occurred_on date, amount_cents bigint, opening_date date,
               statement_line_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.title_id, t.caixa_id, s.settled_on, s.reversed_at,
         m.id, m.financial_account_id, m.occurred_on, m.amount_cents, a.opening_date, l.id
    FROM settlements s0
    JOIN settlements s ON s.id IN (s0.id, s0.mirror_settlement_id)
    JOIN titles t ON t.id = s.title_id
    LEFT JOIN LATERAL (
      -- O movimento de estorno é o de sinal oposto ao da baixa (payable sai, receivable entra).
      SELECT x.* FROM movements x
       WHERE x.settlement_id = s.id
         AND x.amount_cents = -(s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)
                              * CASE t.direction WHEN 'payable' THEN -1 ELSE 1 END
       ORDER BY x.occurred_on DESC, x.id
       LIMIT 1
    ) m ON s.reversed_at IS NOT NULL
    LEFT JOIN financial_accounts a ON a.id = m.financial_account_id
    LEFT JOIN statement_lines l ON l.movement_id = m.id AND l.status = 'matched'
   WHERE s0.id = p_settlement_id
   ORDER BY s.id = p_settlement_id DESC, s.id
$$;

COMMENT ON FUNCTION settlement_reversal_movements(uuid) IS
  'Pernas da baixa (ela e a perna do espelho, se houver), cada uma com a caixa do título, a data da baixa, reversed_at e '
  'o movimento de estorno (o de sinal oposto ao da baixa; nulo se a perna não tem conta ou não foi estornada), com a '
  'conta, a data, o valor, a abertura da conta e a linha de extrato conciliada com ele. A baixa pedida vem primeiro. '
  'Sem linhas se a baixa não existe. Para a prévia da troca da data do estorno e o Access nas caixas das pernas (tarefa 045).';

CREATE FUNCTION settlement_reversal_set_date(p_settlement_id uuid, p_reversed_on date)
RETURNS TABLE (movement_id uuid, settlement_id uuid, financial_account_id uuid, old_date date, new_date date)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  s settlements;
  r record;
BEGIN
  IF p_reversed_on IS NULL THEN
    RAISE EXCEPTION 'settlement_reversal_set_date: the reversal date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Trava as pernas (a baixa e a do espelho), para duas trocas da mesma baixa ficarem em série.
  SELECT * INTO s FROM settlements x WHERE x.id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_reversal_set_date: settlement % not found', p_settlement_id USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM settlements x WHERE x.id = s.mirror_settlement_id FOR UPDATE;

  IF s.reversed_at IS NULL THEN
    RAISE EXCEPTION 'settlements: settlement % is not reversed', s.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_reversal_date_check';
  END IF;
  IF p_reversed_on < s.settled_on THEN
    RAISE EXCEPTION 'settlements: reversal date % is before the settlement date % (settlement %)', p_reversed_on, s.settled_on, s.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_reversal_date_check';
  END IF;

  FOR r IN SELECT * FROM settlement_reversal_movements(p_settlement_id) v WHERE v.movement_id IS NOT NULL LOOP
    IF r.statement_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'settlements: reversal movement % of settlement % is reconciled with statement line %',
        r.movement_id, r.settlement_id, r.statement_line_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_reversal_reconciled_check';
    END IF;
    IF r.occurred_on <> p_reversed_on THEN
      -- A abertura da conta e o mês fechado (data antiga e nova) são conferidos pelos triggers de movements.
      UPDATE movements m SET occurred_on = p_reversed_on WHERE m.id = r.movement_id;
      movement_id := r.movement_id;
      settlement_id := r.settlement_id;
      financial_account_id := r.financial_account_id;
      old_date := r.occurred_on;
      new_date := p_reversed_on;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION settlement_reversal_set_date(uuid, date) IS
  'Muda para p_reversed_on a data do movimento de estorno das pernas da baixa estornada (ela e a do espelho; pernas sem '
  'conta não têm movimento) e devolve os movimentos alterados com a data antiga e a nova (tarefa 045). SECURITY INVOKER: '
  'a auditoria registra o ator da transação. Erros: 22023 data nula; P0002 baixa inexistente; 23514 '
  'settlements_reversal_date_check (baixa não estornada ou data antes da baixa), settlements_reversal_reconciled_check '
  '(movimento de estorno conciliado com linha de extrato), movements_opening_date_check (antes da abertura da conta) e '
  'period_closings_locked_check (mês fechado na data antiga ou na nova).';

-- migrate:down

DROP FUNCTION settlement_reversal_set_date(uuid, date);
DROP FUNCTION settlement_reversal_movements(uuid);
