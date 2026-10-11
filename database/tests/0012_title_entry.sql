-- Testes de 0012_title_entry: boleto, PIX copia-e-cola e NF-e.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('nfe_documents');
SELECT has_table('nfe_items');
SELECT has_column('titles', c) FROM unnest(ARRAY['boleto_barcode', 'pix_payload', 'nfe_document_id']) c;
SELECT columns_are('nfe_documents', ARRAY['id', 'access_key', 'issuer_entity_id', 'recipient_entity_id', 'number', 'series',
                                          'issued_at', 'total_cents', 'xml_attachment_id', 'created_at', 'updated_at']);
SELECT columns_are('nfe_items', ARRAY['id', 'nfe_document_id', 'item_number', 'product_code', 'description', 'ncm', 'cfop',
                                      'unit', 'quantity', 'unit_price_cents', 'total_cents', 'created_at', 'updated_at']);
SELECT fk_ok('titles', 'nfe_document_id', 'nfe_documents', 'id');
SELECT fk_ok('nfe_documents', 'issuer_entity_id', 'entities', 'id');
SELECT fk_ok('nfe_documents', 'recipient_entity_id', 'entities', 'id');
SELECT fk_ok('nfe_documents', 'xml_attachment_id', 'attachments', 'id');
SELECT fk_ok('nfe_items', 'nfe_document_id', 'nfe_documents', 'id');
SELECT has_index('titles', i) FROM unnest(ARRAY['titles_nfe_document_id_idx', 'titles_caixa_boleto_barcode_key']) i;
SELECT has_index('nfe_documents', i) FROM unnest(ARRAY['nfe_documents_issuer_entity_id_idx',
  'nfe_documents_recipient_entity_id_idx', 'nfe_documents_xml_attachment_id_idx']) i;
SELECT has_function(f, ARRAY['text']) FROM unnest(ARRAY['is_valid_boleto_barcode', 'is_valid_brcode', 'is_valid_nfe_access_key']) f;

-- Boleto: código de barras de 44 dígitos com DV
SELECT ok(is_valid_boleto_barcode('00193373700000001000500940144816060680935031'), 'bancário (exemplo do Banco do Brasil)');
SELECT ok(is_valid_boleto_barcode('34191111111111111111111111111111111111111111'), 'bancário: DV 0/10/11 vira 1');
SELECT ok(NOT is_valid_boleto_barcode('00194373700000001000500940144816060680935031'), 'bancário com DV errado');
SELECT ok(is_valid_boleto_barcode('82670000000000123456789012345678901234567890'), 'convênio módulo 10 (3º dígito 6)');
SELECT ok(NOT is_valid_boleto_barcode('82610000000000123456789012345678901234567890'), 'convênio módulo 10 com DV errado');
SELECT ok(is_valid_boleto_barcode('83860000000000987654321098765432109876543210'), 'convênio módulo 11 (3º dígito 8)');
SELECT ok(NOT is_valid_boleto_barcode('83850000000000987654321098765432109876543210'), 'convênio módulo 11 com DV errado');
SELECT ok(NOT is_valid_boleto_barcode('81560000000000987654321098765432109876543210'), 'convênio com identificador de valor inválido');
SELECT ok(NOT is_valid_boleto_barcode('0019337370000000100050094014481606068093503'), '43 dígitos');
SELECT ok(NOT is_valid_boleto_barcode('00190.50095 40144.816069 06809.350314 3 37370000000100'), 'linha digitável formatada não é código de barras');
SELECT is(is_valid_boleto_barcode(NULL), NULL, 'NULL => NULL');

-- PIX copia-e-cola: CRC-16/CCITT-FALSE
SELECT ok(is_valid_brcode('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR'
                          '5913Fulano de Tal6008BRASILIA62070503***63041D3D'), 'exemplo do manual do BR Code');
SELECT ok(is_valid_brcode('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR'
                          '5913Fulano de Tal6008BRASILIA62070503***63041d3d'), 'CRC em minúsculas');
SELECT ok(is_valid_brcode('00020101021126330014br.gov.bcb.pix0111123456789095204000053039865406100.005802BR'
                          '5909Loja Teste6009SAO PAULO62070503***630497DF'), 'com valor');
SELECT ok(NOT is_valid_brcode('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR'
                              '5913Fulano de Tal6008BRASILIA62070503***63041D3E'), 'CRC errado');
SELECT ok(NOT is_valid_brcode('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR'
                              '5913Fulano de Ta16008BRASILIA62070503***63041D3D'), 'payload adulterado');
SELECT ok(NOT is_valid_brcode('0002012658001400000000000000000000000000000000000000000000000000000000000000000063041D3D'),
          'sem o GUI br.gov.bcb.pix');

-- NF-e: chave de 44 dígitos com DV módulo 11
SELECT ok(is_valid_nfe_access_key('35261001234567000190550010000001231000001232'), 'chave válida');
SELECT ok(NOT is_valid_nfe_access_key('35261001234567000190550010000001231000001233'), 'DV errado');
SELECT ok(NOT is_valid_nfe_access_key('3526 1001 2345 6700 0190 5500 1000 0001 2310 0000 1232'), 'chave formatada');

-- Dados base
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Kalunga');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Casa Praia', 'general', '00000000-0000-7000-8000-00000000e001', false);
INSERT INTO categories (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Escritório');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'nfe.xml', 'application/xml', convert_to('<nfeProc/>', 'UTF8'));

-- Campos do título
SELECT lives_ok($$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                      amount_cents, boleto_barcode)
                  VALUES ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable',
                          '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Boleto', '2026-10-01',
                          '2026-10-15', 1000, '00193373700000001000500940144816060680935031')$$, 'título com boleto');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                       amount_cents, boleto_barcode)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'Boleto 2', '2026-10-01', '2026-10-15', 1000,
                           '00193373700000001000500940144816060680935031')$$,
                 '23505', NULL, 'o mesmo boleto duas vezes na caixa');
SELECT lives_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                      amount_cents, boleto_barcode)
                  VALUES ('00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e005',
                          '00000000-0000-7000-8000-00000000ca01', 'Boleto', '2026-10-01', '2026-10-15', 1000,
                          '00193373700000001000500940144816060680935031')$$, 'o mesmo boleto em outra caixa');
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT lives_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                      amount_cents, boleto_barcode)
                  VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                          '00000000-0000-7000-8000-00000000ca01', 'Boleto relançado', '2026-10-01', '2026-10-15', 1000,
                          '00193373700000001000500940144816060680935031')$$, 'cancelado não conta na unicidade');
SELECT throws_ok($$UPDATE titles SET status = 'open' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23505', NULL, 'reabrir o cancelado duplicaria o boleto');
SELECT throws_ok($$UPDATE titles SET boleto_barcode = '00194373700000001000500940144816060680935031'
                    WHERE id = '00000000-0000-7000-8000-0000000b0001'$$, '23514', NULL, 'boleto com DV errado');
SELECT lives_ok($$UPDATE titles SET pix_payload = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000'
                                                  '5204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D'
                   WHERE caixa_id = '00000000-0000-7000-8000-0000000c0002'$$, 'título com PIX copia-e-cola');
SELECT throws_ok($$UPDATE titles SET pix_payload = 'chave@pix.com' WHERE caixa_id = '00000000-0000-7000-8000-0000000c0002'$$,
                 '23514', NULL, 'PIX copia-e-cola inválido');

-- NF-e
SELECT lives_ok($$INSERT INTO nfe_documents (id, access_key, issuer_entity_id, recipient_entity_id, number, series, issued_at,
                                             total_cents, xml_attachment_id)
                  VALUES ('00000000-0000-7000-8000-0000000fe001', '35261001234567000190550010000001231000001232',
                          '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000e001', 123, 1,
                          '2026-10-05 10:00-03', 120000, '00000000-0000-7000-8000-0000000a7001')$$, 'NF-e importada');
SELECT throws_ok($$INSERT INTO nfe_documents (access_key, issuer_entity_id, number, series, issued_at, total_cents)
                   VALUES ('35261001234567000190550010000001231000001232', '00000000-0000-7000-8000-00000000e005', 123, 1,
                           '2026-10-05', 120000)$$, '23505', NULL, 'chave de acesso única');
SELECT throws_ok($$INSERT INTO nfe_documents (access_key, issuer_entity_id, number, series, issued_at, total_cents)
                   VALUES ('35261001234567000190550010000001231000001233', '00000000-0000-7000-8000-00000000e005', 124, 1,
                           '2026-10-05', 1)$$, '23514', NULL, 'chave com DV errado');
SELECT throws_ok($$INSERT INTO nfe_documents (access_key, issuer_entity_id, recipient_entity_id, number, series, issued_at, total_cents)
                   VALUES ('35261001234567000190550010000001241000001248', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000e005', 124, 1, '2026-10-05', 1)$$,
                 '23514', NULL, 'emitente ≠ destinatário');
SELECT lives_ok($$INSERT INTO nfe_items (nfe_document_id, item_number, product_code, description, ncm, cfop, unit, quantity,
                                         unit_price_cents, total_cents)
                  VALUES ('00000000-0000-7000-8000-0000000fe001', 1, 'P1', 'Papel A4', '48025610', '5102', 'CX', 10, 6000.5, 60005),
                         ('00000000-0000-7000-8000-0000000fe001', 2, NULL, 'Caneta', NULL, NULL, 'UN', 1.5, 3995, 5993)$$,
                'itens da nota');
SELECT throws_ok($$INSERT INTO nfe_items (nfe_document_id, item_number, description, quantity, unit_price_cents, total_cents)
                   VALUES ('00000000-0000-7000-8000-0000000fe001', 1, 'Repetido', 1, 1, 1)$$, '23505', NULL, 'número do item único na nota');
SELECT throws_ok($$INSERT INTO nfe_items (nfe_document_id, item_number, description, quantity, unit_price_cents, total_cents)
                   VALUES ('00000000-0000-7000-8000-0000000fe001', 3, 'X', 0, 1, 1)$$, '23514', NULL, 'quantidade > 0');
SELECT throws_ok($$INSERT INTO nfe_items (nfe_document_id, item_number, description, cfop, quantity, unit_price_cents, total_cents)
                   VALUES ('00000000-0000-7000-8000-0000000fe001', 3, 'X', '9102', 1, 1, 1)$$, '23514', NULL, 'CFOP inválido');
SELECT lives_ok($$UPDATE titles SET nfe_document_id = '00000000-0000-7000-8000-0000000fe001'
                   WHERE caixa_id IN ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0002')$$,
                'vários títulos (parcelas) apontam para a mesma nota');
SELECT throws_ok($$DELETE FROM nfe_documents WHERE id = '00000000-0000-7000-8000-0000000fe001'$$,
                 '23503', NULL, 'nota com títulos não é excluída');
SELECT results_eq($$SELECT target_kind FROM attachment_links WHERE attachment_id = '00000000-0000-7000-8000-0000000a7001'$$,
                  $$VALUES ('nfe_document')$$, 'o XML aparece em attachment_links');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['nfe_documents', 'nfe_items']) t;
SELECT ok(has_function_privilege('moneyflow_app', f || '(text)', 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['is_valid_boleto_barcode', 'is_valid_brcode', 'is_valid_nfe_access_key']) f;
SELECT ok(NOT has_function_privilege('public', f || '(text)', 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['is_valid_boleto_barcode', 'is_valid_brcode', 'is_valid_nfe_access_key']) f;

SELECT * FROM finish();
ROLLBACK;
