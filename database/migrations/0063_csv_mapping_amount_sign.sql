-- migrate:up

-- Tarefa 091: o sinal dos valores do CSV passa a ser uma escolha do mapeamento, e não a maioria das linhas de cada
-- arquivo (que virava num mês com poucas compras). amount_sign: 'as_is' (o sinal do arquivo) ou 'invert' (a fatura do
-- cartão que traz as compras positivas; vale também para conta, se o banco escreve o débito positivo).
--
-- Mapeamentos que já existiam (a aplicação invertia só no cartão, pela maioria do arquivo):
--   * de conta: 'as_is' (nunca foram invertidos);
--   * de cartão: o que os lotes CSV importados com eles mostram. Numa linha, a célula do arquivo (raw) com os mesmos
--     dígitos do valor dá o sinal original pelas regras do parseAmount do shared (sufixo D/C, parênteses, "-" na frente
--     ou atrás); a linha foi invertida se o sinal gravado é o oposto. O lote foi invertido se a maioria das linhas que
--     dão para conferir foi; o mapeamento fica 'invert' se pelo menos metade dos lotes conferíveis foi invertida, e
--     'as_is' se a maioria não foi. Sem lote conferível, 'invert' (a fatura em CSV costuma trazer as compras
--     positivas, spec 009).

ALTER TABLE statement_csv_mappings
  ADD COLUMN amount_sign text NOT NULL DEFAULT 'as_is',
  ADD CONSTRAINT statement_csv_mappings_amount_sign_check CHECK (amount_sign IN ('as_is', 'invert'));

COMMENT ON COLUMN statement_csv_mappings.amount_sign IS
  'Sinal dos valores do arquivo (tarefa 091): as_is = como vêm; invert = inverte todos (fatura do cartão com as compras '
  'positivas; conta com o débito positivo). A aplicação aplica pelo mapeamento, nunca pela maioria das linhas.';

-- Sinal de uma célula de valor do CSV, pelas regras do parseAmount (packages/shared/src/parsers/csv.ts). Só para a
-- conversão abaixo; sai no fim da migration.
CREATE FUNCTION csv_cell_negative_0063(p_cell text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s   text := btrim(replace(coalesce(p_cell, ''), chr(160), ' '));
  neg boolean := false;
BEGIN
  IF s ~* '[DC]$' THEN
    neg := upper(right(s, 1)) = 'D';
    s := btrim(left(s, -1));
  END IF;
  IF s ~ '^\(.*\)$' THEN
    neg := NOT neg;
    s := btrim(substr(s, 2, length(s) - 2));
  END IF;
  s := regexp_replace(regexp_replace(s, '^R\$\s*', '', 'i'), '\s', '', 'g');
  IF left(s, 1) = '-' THEN
    neg := NOT neg;
    s := substr(s, 2);
  ELSIF left(s, 1) = '+' THEN
    s := substr(s, 2);
  END IF;
  s := regexp_replace(s, '^R\$', '', 'i');
  IF right(s, 1) = '-' THEN
    neg := NOT neg;
  END IF;
  RETURN neg;
END
$$;

WITH cells AS (
  SELECT i.csv_mapping_id AS mapping_id, i.id AS import_id, l.id AS line_id, l.amount_cents,
         csv_cell_negative_0063(v.value) AS file_negative
    FROM statement_csv_mappings mp
    JOIN statement_imports i ON i.csv_mapping_id = mp.id AND i.format = 'csv'
    JOIN statement_lines l ON l.statement_import_id = i.id
    CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(l.raw) = 'object' THEN l.raw ELSE '{}'::jsonb END) v
   WHERE mp.card_caixa_id IS NOT NULL
     AND nullif(regexp_replace(v.value, '\D', '', 'g'), '')::numeric = abs(l.amount_cents)
), lines AS (
  -- Linha conferível: as células com os dígitos do valor concordam no sinal.
  SELECT c.mapping_id, c.import_id, c.line_id, bool_and(c.file_negative) <> (min(c.amount_cents) < 0) AS inverted
    FROM cells c
   GROUP BY c.mapping_id, c.import_id, c.line_id
  HAVING bool_and(c.file_negative) = bool_or(c.file_negative)
), lots AS (
  SELECT l.mapping_id, l.import_id, count(*) FILTER (WHERE l.inverted) > count(*) FILTER (WHERE NOT l.inverted) AS inverted
    FROM lines l
   GROUP BY l.mapping_id, l.import_id
), decided AS (
  SELECT t.mapping_id,
         CASE WHEN count(*) FILTER (WHERE t.inverted) >= count(*) FILTER (WHERE NOT t.inverted) THEN 'invert' ELSE 'as_is' END
           AS amount_sign
    FROM lots t
   GROUP BY t.mapping_id
)
UPDATE statement_csv_mappings mp
   SET amount_sign = coalesce((SELECT d.amount_sign FROM decided d WHERE d.mapping_id = mp.id), 'invert')
 WHERE mp.card_caixa_id IS NOT NULL;

DROP FUNCTION csv_cell_negative_0063(text);

-- migrate:down

ALTER TABLE statement_csv_mappings DROP COLUMN amount_sign;
