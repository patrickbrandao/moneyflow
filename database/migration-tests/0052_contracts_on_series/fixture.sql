-- Fixture da migração 0052 (contratos sobre séries), no schema da 0051. Carregado numa transação por
-- scripts/test-migration.sh antes de subir a 0052.
--
-- K1 Aluguel (Casa paga à Imobiliária; renovação pendente): dois ciclos mensais de 12, aditivo no ciclo 1 que mudou
--    o valor das parcelas 7–12 (100.000 → 110.000), ciclo 2 com 120.000; conta das parcelas na Empresa com a
--    passagem no cofre da Casa; encargos, janela e auto_settle. Parcela 1 paga pela Empresa (transferência +
--    baixa no cofre, linha transfer_settlement automática), 2 com desconto na corrente (conta própria), 3 conciliada
--    pela linha (settlement), 4 parcial, 5 cancelada, 6 com baixa estornada, 8 sem conta prevista. Tarefa do
--    ciclo 1 aprovada, a do ciclo 2 aberta. Documentos PDF e markdown versionado.
-- K2 Suporte ACME (Empresa recebe; espelhado na caixa da ACME; rescindido): ciclo trimestral de 12 meses com vencimento
--    no dia 31 do mês seguinte (30/04, 31/07, 31/10, 31/01), parcelas 3 e 4 canceladas, 1 recebida, multa extra.
-- K3 Taxa anual (parcela única), K4 rascunho com ciclo e sem títulos, K5 Garagem encerrado (12 em aberto).
-- S1 série comum; R2 regra órfã (sem títulos); S3 série com a 3ª ocorrência movida para outra caixa.

INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-5200000000e1', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-5200000000e2', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-5200000000e3', 'company', 'Imobiliária Locadora'),
  ('00000000-0000-7000-8000-5200000000e4', 'company', 'ACME Ltda');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-5200000000c1', 'Casa', 'general', '00000000-0000-7000-8000-5200000000e1', true),
  ('00000000-0000-7000-8000-5200000000c2', 'Empresa', 'general', '00000000-0000-7000-8000-5200000000e2', true),
  ('00000000-0000-7000-8000-5200000000c3', 'ACME', 'general', '00000000-0000-7000-8000-5200000000e4', true);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-520000000ca1', 'expense', 'Aluguel 52'),
  ('00000000-0000-7000-8000-520000000ca2', 'income', 'Serviços 52'),
  ('00000000-0000-7000-8000-520000000ca3', 'expense', 'Serviços contratados 52');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-5200000000a1', '00000000-0000-7000-8000-5200000000c1', 'checking', 'Corrente Casa', '2024-01-01'),
  ('00000000-0000-7000-8000-5200000000a2', '00000000-0000-7000-8000-5200000000c1', 'cash', 'Cofre Casa', '2024-01-01'),
  ('00000000-0000-7000-8000-5200000000b1', '00000000-0000-7000-8000-5200000000c2', 'checking', 'Corrente Empresa', '2024-01-01');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-5200000000f1', 'contrato.pdf', 'application/pdf', '\x255044462d'),
  ('00000000-0000-7000-8000-5200000000f2', 'aditivo.pdf', 'application/pdf', '\x255044462d31'),
  ('00000000-0000-7000-8000-5200000000f3', 'extrato.ofx', 'application/x-ofx', '\x4f4658');

-- Contratos ---------------------------------------------------------------------------------------------------------
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, counterparty_caixa_id, status, auto_renew,
                       terminated_on, termination_penalty_cents, payment_account_id, transit_account_id,
                       late_fee_percent, interest_month_percent, early_discount_percent, tolerance_cents,
                       match_window_days, auto_settle)
VALUES
  ('00000000-0000-7000-8000-52000000c001', '00000000-0000-7000-8000-5200000000c1', '00000000-0000-7000-8000-5200000000e3',
   'payable', 'Aluguel', '00000000-0000-7000-8000-520000000ca1', NULL, 'renewal_pending', true, NULL, NULL,
   '00000000-0000-7000-8000-5200000000b1', '00000000-0000-7000-8000-5200000000a2', 2, 1, 5, 500, 20, true),
  ('00000000-0000-7000-8000-52000000c002', '00000000-0000-7000-8000-5200000000c2', '00000000-0000-7000-8000-5200000000e4',
   'receivable', 'Suporte ACME', '00000000-0000-7000-8000-520000000ca2', '00000000-0000-7000-8000-5200000000c3',
   'terminated', false, '2025-09-30', 50000, NULL, NULL, NULL, NULL, NULL, 0, 15, false),
  ('00000000-0000-7000-8000-52000000c003', '00000000-0000-7000-8000-5200000000c1', '00000000-0000-7000-8000-5200000000e3',
   'payable', 'Taxa anual', '00000000-0000-7000-8000-520000000ca1', NULL, 'active', false, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, 0, 15, false),
  ('00000000-0000-7000-8000-52000000c004', '00000000-0000-7000-8000-5200000000c1', '00000000-0000-7000-8000-5200000000e3',
   'payable', 'Rascunho', '00000000-0000-7000-8000-520000000ca1', NULL, 'draft', false, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, 0, 15, false),
  ('00000000-0000-7000-8000-52000000c005', '00000000-0000-7000-8000-5200000000c1', '00000000-0000-7000-8000-5200000000e3',
   'payable', 'Garagem', '00000000-0000-7000-8000-520000000ca1', NULL, 'ended', false, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, 0, 15, false);

INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day,
                             due_month_offset, readjustment_percent) VALUES
  ('00000000-0000-7000-8000-5200000000d1', '00000000-0000-7000-8000-52000000c001', 1, '2025-01-01', 12, 'monthly', 1260000, 10, 0, NULL),
  ('00000000-0000-7000-8000-5200000000d2', '00000000-0000-7000-8000-52000000c001', 2, '2026-01-01', 12, 'monthly', 1440000, 10, 0, 9.0909),
  ('00000000-0000-7000-8000-5200000000d3', '00000000-0000-7000-8000-52000000c002', 1, '2025-03-15', 12, 'quarterly', 400000, 31, 1, NULL),
  ('00000000-0000-7000-8000-5200000000d4', '00000000-0000-7000-8000-52000000c003', 1, '2025-05-01', 12, 'single', 30000, 5, 0, NULL),
  ('00000000-0000-7000-8000-5200000000d5', '00000000-0000-7000-8000-52000000c004', 1, '2026-02-01', 12, 'monthly', 120000, 1, 0, NULL),
  ('00000000-0000-7000-8000-5200000000d6', '00000000-0000-7000-8000-52000000c005', 1, '2024-01-01', 12, 'monthly', 144000, 15, 0, NULL);

-- K1: 24 parcelas (ciclo 1: 5200000101nn; ciclo 2: 5200000102nn).
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, contract_id, contract_cycle_id, contract_installment, planned_account_id,
                    planned_transit_account_id, planned_account_custom)
SELECT ('00000000-0000-7000-8000-52000001' || lpad(y::text, 2, '0') || lpad(i::text, 2, '0'))::uuid,
       '00000000-0000-7000-8000-5200000000c1', 'payable', '00000000-0000-7000-8000-5200000000e3',
       '00000000-0000-7000-8000-520000000ca1', 'Aluguel · ' || i || '/12',
       (date '2025-01-01' + make_interval(years => y - 1, months => i - 1))::date,
       (date '2025-01-10' + make_interval(years => y - 1, months => i - 1))::date,
       CASE WHEN y = 2 THEN 120000 WHEN i <= 6 THEN 100000 ELSE 110000 END,
       'contract', '00000000-0000-7000-8000-52000000c001',
       CASE y WHEN 1 THEN '00000000-0000-7000-8000-5200000000d1'::uuid ELSE '00000000-0000-7000-8000-5200000000d2'::uuid END, i,
       CASE WHEN y = 1 AND i = 2 THEN '00000000-0000-7000-8000-5200000000a1'::uuid
            WHEN y = 1 AND i = 8 THEN NULL
            ELSE '00000000-0000-7000-8000-5200000000b1'::uuid END,
       CASE WHEN y = 1 AND i IN (2, 8) THEN NULL ELSE '00000000-0000-7000-8000-5200000000a2'::uuid END,
       y = 1 AND i = 2
  FROM generate_series(1, 2) y, generate_series(1, 12) i;
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-520000010105';

-- K2: 4 parcelas trimestrais espelhadas na ACME (original 5200000201nn, espelho 5200000202nn); 3 e 4 canceladas.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, contract_id, contract_cycle_id, contract_installment, counterparty_caixa_id, mirror_title_id,
                    mirror_status, status)
SELECT ('00000000-0000-7000-8000-52000002' || lpad(s::text, 2, '0') || lpad(i::text, 2, '0'))::uuid,
       CASE s WHEN 1 THEN '00000000-0000-7000-8000-5200000000c2'::uuid ELSE '00000000-0000-7000-8000-5200000000c3'::uuid END,
       CASE s WHEN 1 THEN 'receivable' ELSE 'payable' END,
       CASE s WHEN 1 THEN '00000000-0000-7000-8000-5200000000e4'::uuid ELSE '00000000-0000-7000-8000-5200000000e2'::uuid END,
       CASE s WHEN 1 THEN '00000000-0000-7000-8000-520000000ca2'::uuid ELSE '00000000-0000-7000-8000-520000000ca3'::uuid END,
       'Suporte ACME · ' || i || '/4',
       (date '2025-03-01' + make_interval(months => (i - 1) * 3))::date,
       ((date '2025-04-01' + make_interval(months => (i - 1) * 3 + 1))::date - 1),
       100000, 'contract', '00000000-0000-7000-8000-52000000c002', '00000000-0000-7000-8000-5200000000d3', i,
       CASE s WHEN 1 THEN '00000000-0000-7000-8000-5200000000c3'::uuid ELSE '00000000-0000-7000-8000-5200000000c2'::uuid END,
       ('00000000-0000-7000-8000-52000002' || lpad((3 - s)::text, 2, '0') || lpad(i::text, 2, '0'))::uuid,
       CASE s WHEN 2 THEN 'accepted' END,
       CASE WHEN i >= 3 THEN 'canceled' ELSE 'open' END
  FROM generate_series(1, 2) s, generate_series(1, 4) i;
-- Multa rescisória: título extra do contrato, sem ciclo.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, contract_id)
VALUES ('00000000-0000-7000-8000-520000020301', '00000000-0000-7000-8000-5200000000c2', 'receivable',
        '00000000-0000-7000-8000-5200000000e4', '00000000-0000-7000-8000-520000000ca2', 'Multa rescisória',
        '2025-09-01', '2025-10-10', 50000, 'contract', '00000000-0000-7000-8000-52000000c002');

-- K3 parcela única; K5 12 parcelas em aberto (5200000501nn).
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, contract_id, contract_cycle_id, contract_installment)
VALUES ('00000000-0000-7000-8000-520000030101', '00000000-0000-7000-8000-5200000000c1', 'payable',
        '00000000-0000-7000-8000-5200000000e3', '00000000-0000-7000-8000-520000000ca1', 'Taxa anual · 1/1',
        '2025-05-01', '2025-05-05', 30000, 'contract', '00000000-0000-7000-8000-52000000c003',
        '00000000-0000-7000-8000-5200000000d4', 1);
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, contract_id, contract_cycle_id, contract_installment)
SELECT ('00000000-0000-7000-8000-52000005' || '01' || lpad(i::text, 2, '0'))::uuid,
       '00000000-0000-7000-8000-5200000000c1', 'payable', '00000000-0000-7000-8000-5200000000e3',
       '00000000-0000-7000-8000-520000000ca1', 'Garagem · ' || i || '/12',
       (date '2024-01-01' + make_interval(months => i - 1))::date, (date '2024-01-15' + make_interval(months => i - 1))::date,
       12000, 'contract', '00000000-0000-7000-8000-52000000c005', '00000000-0000-7000-8000-5200000000d6', i
  FROM generate_series(1, 12) i;

-- Séries que não são de contrato ---------------------------------------------------------------------------------------
-- S1 (5200000000aa) com 3 ocorrências na Casa; R2 (…ab) órfã; S3 (…ac) com a 3ª ocorrência movida para a Empresa.
INSERT INTO recurrence_rules (id, frequency, anchor_day, starts_on) VALUES
  ('00000000-0000-7000-8000-5200000000aa', 'monthly', 5, '2025-01-05'),
  ('00000000-0000-7000-8000-5200000000ab', 'monthly', 7, '2025-01-07'),
  ('00000000-0000-7000-8000-5200000000ac', 'monthly', 20, '2025-01-20');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, recurrence_rule_id, occurrence)
SELECT ('00000000-0000-7000-8000-52000009' || r || lpad(i::text, 2, '0'))::uuid,
       CASE WHEN r = 'ac' AND i = 3 THEN '00000000-0000-7000-8000-5200000000c2'::uuid
            ELSE '00000000-0000-7000-8000-5200000000c1'::uuid END,
       'payable', '00000000-0000-7000-8000-5200000000e3', '00000000-0000-7000-8000-520000000ca1',
       CASE r WHEN 'aa' THEN 'Internet' ELSE 'Limpeza' END,
       (date '2025-01-01' + make_interval(months => i - 1))::date,
       (date '2025-01-01' + make_interval(months => i - 1))::date + CASE r WHEN 'aa' THEN 4 ELSE 19 END,
       10000, 'recurrence', ('00000000-0000-7000-8000-5200000000' || r)::uuid, i
  FROM unnest(ARRAY['aa', 'ac']) r, generate_series(1, 3) i;

-- Baixas, movimentos e transferências do K1 ----------------------------------------------------------------------------
-- P1 (venc. 10/01/2025) paga em 15/01 pela Empresa: baixa no cofre com multa e juros + transferência Empresa → cofre.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, fine_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005a1', '00000000-0000-7000-8000-520000010101', '2025-01-15', 100000, 166, 2000,
   '00000000-0000-7000-8000-5200000000a2');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000a2', '2025-01-15', -102166, 'settlement', '00000000-0000-7000-8000-5200000005a1');
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000007a1', '00000000-0000-7000-8000-5200000000b1', '00000000-0000-7000-8000-5200000000a2',
   102166, '2025-01-15', '00000000-0000-7000-8000-5200000005a1');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  ('00000000-0000-7000-8000-5200000006b1', '00000000-0000-7000-8000-5200000000b1', '2025-01-15', -102166, 'transfer',
   '00000000-0000-7000-8000-5200000007a1'),
  ('00000000-0000-7000-8000-5200000006b2', '00000000-0000-7000-8000-5200000000a2', '2025-01-15', 102166, 'transfer',
   '00000000-0000-7000-8000-5200000007a1');
-- P2 paga em 08/02 na corrente da Casa com desconto.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, discount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005a2', '00000000-0000-7000-8000-520000010102', '2025-02-08', 100000, 5000,
   '00000000-0000-7000-8000-5200000000a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000a1', '2025-02-08', -95000, 'settlement', '00000000-0000-7000-8000-5200000005a2');
-- P3 paga em 12/03 pela conciliação (a linha criou a baixa).
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005a3', '00000000-0000-7000-8000-520000010103', '2025-03-12', 100000,
   '00000000-0000-7000-8000-5200000000a1');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000006a3', '00000000-0000-7000-8000-5200000000a1', '2025-03-12', -100000, 'settlement',
   '00000000-0000-7000-8000-5200000005a3');
-- P4 parcial em 12/04.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005a4', '00000000-0000-7000-8000-520000010104', '2025-04-12', 40000,
   '00000000-0000-7000-8000-5200000000a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000a1', '2025-04-12', -40000, 'settlement', '00000000-0000-7000-8000-5200000005a4');
-- P6 com baixa estornada (não conta).
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005a6', '00000000-0000-7000-8000-520000010106', '2025-06-20', 100000,
   '00000000-0000-7000-8000-5200000000a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000a1', '2025-06-20', -100000, 'settlement', '00000000-0000-7000-8000-5200000005a6');
UPDATE settlements SET reversed_at = now(), reversal_reason = 'lançada errada' WHERE id = '00000000-0000-7000-8000-5200000005a6';
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000a1', '2025-06-21', 100000, 'settlement', '00000000-0000-7000-8000-5200000005a6');
-- K2: parcela 1 recebida na Empresa.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-5200000005b1', '00000000-0000-7000-8000-520000020101', '2025-05-02', 100000,
   '00000000-0000-7000-8000-5200000000b1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-5200000000b1', '2025-05-02', 100000, 'settlement', '00000000-0000-7000-8000-5200000005b1');

-- Extratos: a linha da Empresa criou a baixa de P1 (transfer_settlement, automática); a da Casa criou a de P3.
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-5200000008b1', '00000000-0000-7000-8000-5200000000b1', 'ofx',
   '00000000-0000-7000-8000-5200000000f3', '2025-01-01', '2025-01-31'),
  ('00000000-0000-7000-8000-5200000008a1', '00000000-0000-7000-8000-5200000000a1', 'ofx',
   '00000000-0000-7000-8000-5200000000f3', '2025-03-01', '2025-03-31');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at, created_entry, auto_settled) VALUES
  ('00000000-0000-7000-8000-5200000009b1', '00000000-0000-7000-8000-5200000008b1', '00000000-0000-7000-8000-5200000000b1',
   1, '2025-01-15', -102166, 'PIX ALUGUEL', 'h1', 'matched', '00000000-0000-7000-8000-5200000006b1', now(),
   'transfer_settlement', true),
  ('00000000-0000-7000-8000-5200000009a1', '00000000-0000-7000-8000-5200000008a1', '00000000-0000-7000-8000-5200000000a1',
   1, '2025-03-12', -100000, 'ALUGUEL MARCO', 'h1', 'matched', '00000000-0000-7000-8000-5200000006a3', now(),
   'settlement', false);

-- Renovação, aditivo e documentos do K1 ----------------------------------------------------------------------------------
INSERT INTO contract_renewal_tasks (id, contract_id, contract_cycle_id, status, opened_on, due_on, decided_at, new_cycle_id) VALUES
  ('00000000-0000-7000-8000-520000000b01', '00000000-0000-7000-8000-52000000c001', '00000000-0000-7000-8000-5200000000d1',
   'approved', '2025-11-01', '2025-12-31', '2025-11-20', '00000000-0000-7000-8000-5200000000d2'),
  ('00000000-0000-7000-8000-520000000b02', '00000000-0000-7000-8000-52000000c001', '00000000-0000-7000-8000-5200000000d2',
   'open', '2026-11-01', '2026-12-31', NULL, NULL);
INSERT INTO contract_documents (id, contract_id, kind, format, title, attachment_id) VALUES
  ('00000000-0000-7000-8000-5200000000c7', '00000000-0000-7000-8000-52000000c001', 'contract', 'pdf', 'contrato.pdf',
   '00000000-0000-7000-8000-5200000000f1'),
  ('00000000-0000-7000-8000-5200000000c8', '00000000-0000-7000-8000-52000000c001', 'amendment', 'pdf', 'aditivo.pdf',
   '00000000-0000-7000-8000-5200000000f2');
INSERT INTO contract_documents (id, contract_id, kind, format, title, source_document_id) VALUES
  ('00000000-0000-7000-8000-5200000000c9', '00000000-0000-7000-8000-52000000c001', 'contract', 'markdown', 'contrato.md',
   '00000000-0000-7000-8000-5200000000c7');
INSERT INTO contract_document_versions (id, document_id, content, author_kind) VALUES
  ('00000000-0000-7000-8000-5200000000d9', '00000000-0000-7000-8000-5200000000c9', '# Contrato', 'agent');
INSERT INTO contract_document_versions (id, document_id, content, note) VALUES
  ('00000000-0000-7000-8000-5200000000da', '00000000-0000-7000-8000-5200000000c9', '# Contrato\n\nCláusula 1', 'revisão');
UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-5200000000da'
 WHERE id = '00000000-0000-7000-8000-5200000000c9';
INSERT INTO contract_amendments (id, contract_id, contract_cycle_id, document_id, effective_on, changes, affected_title_ids)
SELECT '00000000-0000-7000-8000-5200000000ad', '00000000-0000-7000-8000-52000000c001', '00000000-0000-7000-8000-5200000000d1',
       '00000000-0000-7000-8000-5200000000c8', '2025-07-01',
       '{"before": {"amount_cents": 100000}, "after": {"amount_cents": 110000}}',
       array_agg(('00000000-0000-7000-8000-5200000101' || lpad(i::text, 2, '0'))::uuid ORDER BY i)
  FROM generate_series(7, 12) i;
