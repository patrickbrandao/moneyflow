-- Fixture da migração 0063 (sinal do mapeamento CSV), no schema da 0062. Carregado numa transação por
-- scripts/test-migration.sh antes de subir a 0063. Os lotes guardam o valor como a aplicação gravou (no cartão, invertido
-- quando a maioria das linhas do arquivo era positiva) e, em raw, a linha do arquivo.
--
-- M1 cartão Nubank: um lote invertido (compras positivas no arquivo) → invert.
-- M2 cartão Inter: um lote não invertido (compras negativas no arquivo) → as_is.
-- M3 cartão C6 sem lote → invert (sem evidência).
-- M4 conta corrente com lote → as_is (conta nunca foi invertida).
-- M5 cartão Nubank com valor sem casas decimais no arquivo ("150"): nenhuma linha conferível → invert.
-- M6 cartão Inter com dois lotes, um invertido e um não (o mês com poucas compras) → empate → invert.
-- M7 cartão C6 com três lotes, dois não invertidos (parênteses e sufixo D) e um invertido → as_is. Uma linha com o saldo
--    de mesmos dígitos e sinal oposto não é conferível.

INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-63000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-63000000e004', 'company', 'Nu Pagamentos'),
  ('00000000-0000-7000-8000-63000000e005', 'company', 'Banco Inter'),
  ('00000000-0000-7000-8000-63000000e006', 'company', 'Banco C6');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-63000000c001', 'Casa', 'general', '00000000-0000-7000-8000-63000000e001', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-63000000c010', 'Nubank', 'credit_card', '00000000-0000-7000-8000-63000000e004',
   '00000000-0000-7000-8000-63000000c001', 500000, 3, 10, '1111'),
  ('00000000-0000-7000-8000-63000000c011', 'Inter', 'credit_card', '00000000-0000-7000-8000-63000000e005',
   '00000000-0000-7000-8000-63000000c001', 500000, 3, 10, '2222'),
  ('00000000-0000-7000-8000-63000000c012', 'C6', 'credit_card', '00000000-0000-7000-8000-63000000e006',
   '00000000-0000-7000-8000-63000000c001', 500000, 3, 10, '3333');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-63000000a001', '00000000-0000-7000-8000-63000000c001', 'checking', 'Corrente', '2026-01-01');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-63000000ff01', 'fatura.csv', 'text/csv', '\x6373760a');

INSERT INTO statement_csv_mappings (id, financial_account_id, card_caixa_id, name, columns) VALUES
  ('00000000-0000-7000-8000-630000000001', NULL, '00000000-0000-7000-8000-63000000c010', 'M1 Nubank',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000002', NULL, '00000000-0000-7000-8000-63000000c011', 'M2 Inter',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000003', NULL, '00000000-0000-7000-8000-63000000c012', 'M3 C6 sem lote',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000004', '00000000-0000-7000-8000-63000000a001', NULL, 'M4 Corrente',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000005', NULL, '00000000-0000-7000-8000-63000000c010', 'M5 Nubank inteiro',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000006', NULL, '00000000-0000-7000-8000-63000000c011', 'M6 Inter dois lotes',
   '{"date": "Data", "description": "Descrição", "amount": "Valor"}'),
  ('00000000-0000-7000-8000-630000000007', NULL, '00000000-0000-7000-8000-63000000c012', 'M7 C6 três lotes',
   '{"date": "Data", "description": "Descrição", "amount": "Valor", "balance": "Saldo"}');

-- Lotes: (id, mapeamento, conta, cartão).
INSERT INTO statement_imports (id, financial_account_id, card_caixa_id, format, attachment_id, csv_mapping_id, period_start, period_end)
SELECT ('00000000-0000-7000-8000-6300000010' || v.lot)::uuid, v.account::uuid, v.card::uuid, 'csv',
       '00000000-0000-7000-8000-63000000ff01', ('00000000-0000-7000-8000-63000000000' || v.mapping)::uuid,
       '2026-10-01', '2026-10-31'
  FROM (VALUES ('01', '1', NULL, '00000000-0000-7000-8000-63000000c010'),
               ('02', '2', NULL, '00000000-0000-7000-8000-63000000c011'),
               ('04', '4', '00000000-0000-7000-8000-63000000a001', NULL),
               ('05', '5', NULL, '00000000-0000-7000-8000-63000000c010'),
               ('61', '6', NULL, '00000000-0000-7000-8000-63000000c011'),
               ('62', '6', NULL, '00000000-0000-7000-8000-63000000c011'),
               ('71', '7', NULL, '00000000-0000-7000-8000-63000000c012'),
               ('72', '7', NULL, '00000000-0000-7000-8000-63000000c012'),
               ('73', '7', NULL, '00000000-0000-7000-8000-63000000c012')) v (lot, mapping, account, card);

-- Linhas: (lote, número, valor gravado, célula Valor do arquivo[, Saldo]).
INSERT INTO statement_lines (statement_import_id, financial_account_id, card_caixa_id, line_number, posted_on, amount_cents,
                             description, dedup_hash, raw)
SELECT i.id, i.financial_account_id, i.card_caixa_id, v.n, '2026-10-05', v.cents, 'LINHA ' || v.n, 'h' || v.lot || '-' || v.n,
       jsonb_strip_nulls(jsonb_build_object('Data', '05/10/2026', 'Descrição', 'LINHA ' || v.n, 'Valor', v.cell, 'Saldo', v.balance))
  FROM (VALUES
    -- M1: compras positivas no arquivo, invertidas pelo app.
    ('01', 1, -15000, '150,00', NULL), ('01', 2, 8000, '-80,00', NULL), ('01', 3, -3590, 'R$ 35,90', NULL),
    -- M2: compras negativas no arquivo, gravadas como estão.
    ('02', 1, -5000, '-50,00', NULL), ('02', 2, 20000, '200,00', NULL), ('02', 3, 3000, '+30,00', NULL),
    -- M4: conta, como no arquivo.
    ('04', 1, 15000, '150,00', NULL), ('04', 2, -2000, '-20,00', NULL),
    -- M5: sem casas decimais: os dígitos não batem com os centavos.
    ('05', 1, -15000, '150', NULL), ('05', 2, -2000, '20', NULL),
    -- M6: um lote invertido e o mês com uma compra e o pagamento (não invertido, a compra ficou positiva).
    ('61', 1, -1000, '10,00', NULL), ('61', 2, -2000, '20,00', NULL),
    ('62', 1, 15000, '150,00', NULL), ('62', 2, -15000, '-150,00', NULL),
    -- M7: dois lotes não invertidos (parênteses, sufixo D e "-" atrás) e um invertido; a linha com o saldo de mesmos
    --     dígitos e sinal oposto não conta.
    ('71', 1, -2500, '(25,00)', NULL), ('71', 2, -4000, '40,00 D', NULL), ('71', 3, 9900, '99,00', '-99,00'),
    ('72', 1, -1200, '12,00-', NULL), ('72', 2, 500, '5,00 C', NULL),
    ('73', 1, -1200, '12,00', NULL)) v (lot, n, cents, cell, balance)
  JOIN statement_imports i ON i.id = ('00000000-0000-7000-8000-6300000010' || v.lot)::uuid;
