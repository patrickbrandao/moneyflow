-- migrate:up

-- Conciliação (spec 009): marca explícita de que o lançamento ligado a uma linha
-- conciliada nasceu dela, para o "desfazer e excluir o lançamento" da aplicação.
--   adjustment  o movimento avulso de movement_id foi criado pela linha;
--   title       o título (com o espelho, quando houver) e a baixa cujo movimento é movement_id;
--   settlement  só a baixa cujo movimento é movement_id, num título que já existia;
--   purchase    a compra no cartão do card_invoice_item_id.

ALTER TABLE statement_lines
  ADD COLUMN created_entry text,
  ADD CONSTRAINT statement_lines_created_entry_check CHECK (
    created_entry IS NULL
    OR (created_entry IN ('adjustment', 'title', 'settlement', 'purchase') AND status = 'matched')
  ),
  ADD CONSTRAINT statement_lines_created_entry_links_check CHECK (
    CASE created_entry
      WHEN 'adjustment' THEN movement_id IS NOT NULL
      WHEN 'title'      THEN movement_id IS NOT NULL
      WHEN 'settlement' THEN movement_id IS NOT NULL
      WHEN 'purchase'   THEN card_invoice_item_id IS NOT NULL
      ELSE true
    END
  );

COMMENT ON COLUMN statement_lines.created_entry IS
  'Só em matched: o lançamento ligado foi criado a partir desta linha. adjustment = o movimento avulso de movement_id; '
  'title = o título (o par com o espelho) e a baixa cujo movimento é movement_id; settlement = só a baixa cujo movimento '
  'é movement_id, num título que já existia (casar com título em aberto); purchase = a compra no cartão do '
  'card_invoice_item_id. Nulo = a linha foi casada com um lançamento que já existia. A aplicação grava junto com a '
  'conciliação e limpa ao desfazer ou ignorar a linha (o "desfazer e excluir o lançamento" apaga o que ela indica).';

-- Inferência para as linhas conciliadas antes desta coluna: o lançamento criado pela
-- linha nasce na mesma transação que a concilia (created_at DEFAULT now() e
-- matched_at = now() são o mesmo instante da transação).
CREATE FUNCTION statement_line_inferred_created_entry(p_line_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN l.status <> 'matched' THEN NULL
           WHEN m.kind = 'adjustment' AND m.created_at = l.matched_at THEN 'adjustment'
           WHEN m.kind = 'settlement' AND t.created_at = l.matched_at THEN 'title'
           WHEN m.kind = 'settlement' AND s.created_at = l.matched_at THEN 'settlement'
           WHEN p.created_at = l.matched_at THEN 'purchase'
         END
    FROM statement_lines l
    LEFT JOIN movements m ON m.id = l.movement_id
    LEFT JOIN settlements s ON s.id = m.settlement_id
    LEFT JOIN titles t ON t.id = s.title_id
    LEFT JOIN card_invoice_items i ON i.id = l.card_invoice_item_id
    LEFT JOIN card_purchases p ON p.id = i.card_purchase_id
   WHERE l.id = p_line_id
$$;

REVOKE EXECUTE ON FUNCTION statement_line_inferred_created_entry(uuid) FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION statement_line_inferred_created_entry(uuid) IS
  'Uso interno (backfill da 0048): created_entry inferido para uma linha matched pelo instante de criação do lançamento '
  'igual ao matched_at (mesma transação). Nulo se o lançamento é mais antigo que a conciliação. Não é usado pela aplicação, '
  'que grava created_entry ao conciliar.';

-- Backfill. Só created_entry muda: a validação da linha (que revalidaria vínculos e
-- categoria de dados antigos), o updated_at e a auditoria (uma linha "system" por
-- linha conciliada) ficam desligados durante o UPDATE. statement_lines não tem trava
-- de período fechado.
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;

UPDATE statement_lines l
   SET created_entry = x.created_entry
  FROM (SELECT id, statement_line_inferred_created_entry(id) AS created_entry
          FROM statement_lines WHERE status = 'matched') x
 WHERE l.id = x.id AND x.created_entry IS NOT NULL;

ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

-- migrate:down

DROP FUNCTION statement_line_inferred_created_entry(uuid);
ALTER TABLE statement_lines DROP COLUMN created_entry;
