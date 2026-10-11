-- Testes de 0011_attachments: anexos em bytea, limite de 20 MB, hash e ligações.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['attachments', 'title_attachments', 'settlement_attachments',
                                      'movement_attachments', 'entity_attachments']) t;
SELECT has_view('attachment_links');
SELECT columns_are('attachments', ARRAY['id', 'file_name', 'mime_type', 'content', 'size_bytes', 'sha256',
                                        'uploaded_by_user_id', 'created_at', 'updated_at']);
SELECT col_type_is('attachments', 'content', 'bytea');
SELECT col_is_pk('attachments', 'id');
SELECT fk_ok('attachments', 'uploaded_by_user_id', 'users', 'id');
SELECT fk_ok('title_attachments', 'title_id', 'titles', 'id');
SELECT fk_ok('title_attachments', 'attachment_id', 'attachments', 'id');
SELECT fk_ok('settlement_attachments', 'settlement_id', 'settlements', 'id');
SELECT fk_ok('movement_attachments', 'movement_id', 'movements', 'id');
SELECT fk_ok('entity_attachments', 'entity_id', 'entities', 'id');
SELECT has_index('attachments', 'attachments_sha256_idx');
SELECT has_index(t, t || '_attachment_id_idx') FROM unnest(ARRAY['title_attachments', 'settlement_attachments',
                                                                  'movement_attachments', 'entity_attachments']) t;
SELECT has_trigger('attachments', 'attachments_validate');

-- Dados base
INSERT INTO users (id, username, email, password) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'x');
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true);
INSERT INTO categories (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable',
   '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Energia', '2026-10-01', '2026-10-15', 1000);

-- Anexo: tamanho e hash calculados pelo banco
SELECT lives_ok($$INSERT INTO attachments (id, file_name, mime_type, content, uploaded_by_user_id)
                  VALUES ('00000000-0000-7000-8000-0000000a7001', 'boleto.pdf', 'application/pdf', convert_to('abc', 'UTF8'),
                          '00000000-0000-7000-8000-0000000000a1')$$, 'insere anexo');
SELECT results_eq($$SELECT size_bytes, sha256 FROM attachments WHERE id = '00000000-0000-7000-8000-0000000a7001'$$,
                  $$VALUES (3, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')$$,
                  'size_bytes e sha256 gerados');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content, size_bytes) VALUES ('a.txt', 'text/plain', '\x00', 99)$$,
                 '428C9', NULL, 'size_bytes não é informado pela aplicação');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('a.txt', 'text/plain', '')$$,
                 '23514', NULL, 'arquivo vazio');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content)
                   VALUES ('grande.bin', 'application/octet-stream', decode(repeat('00', 20971521), 'hex'))$$,
                 '23514', NULL, 'acima de 20 MB');
SELECT lives_ok($$INSERT INTO attachments (file_name, mime_type, content)
                  VALUES ('limite.bin', 'application/octet-stream', decode(repeat('00', 20971520), 'hex'))$$,
                'exatamente 20 MB');
DELETE FROM attachments WHERE file_name = 'limite.bin';
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('a/b.pdf', 'application/pdf', '\x01')$$,
                 '23514', NULL, 'nome sem caminho');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('  ', 'application/pdf', '\x01')$$,
                 '23514', NULL, 'nome vazio');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('a.pdf', 'PDF', '\x01')$$,
                 '23514', NULL, 'mime inválido');
SELECT throws_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('a.pdf', 'application/pdf; charset=x', '\x01')$$,
                 '23514', NULL, 'mime sem parâmetros');
SELECT throws_ok($$UPDATE attachments SET content = '\x02' WHERE id = '00000000-0000-7000-8000-0000000a7001'$$,
                 '23514', 'attachments: content of attachment 00000000-0000-7000-8000-0000000a7001 cannot change (upload a new file)',
                 'conteúdo imutável');
SELECT lives_ok($$UPDATE attachments SET file_name = 'boleto-energia.pdf' WHERE id = '00000000-0000-7000-8000-0000000a7001'$$,
                'renomear é permitido');

-- Ligações
SELECT lives_ok($$INSERT INTO title_attachments (title_id, attachment_id)
                  VALUES ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000a7001')$$, 'liga ao título');
SELECT throws_ok($$INSERT INTO title_attachments (title_id, attachment_id)
                   VALUES ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000a7001')$$,
                 '23505', NULL, 'mesma ligação duas vezes');
SELECT lives_ok($$INSERT INTO entity_attachments (entity_id, attachment_id)
                  VALUES ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-0000000a7001')$$,
                'o mesmo anexo em outro registro');
SELECT results_eq($$SELECT target_kind, target_id FROM attachment_links
                     WHERE attachment_id = '00000000-0000-7000-8000-0000000a7001' ORDER BY 1$$,
                  $$VALUES ('entity', '00000000-0000-7000-8000-00000000e005'::uuid),
                           ('title', '00000000-0000-7000-8000-0000000b0001'::uuid)$$, 'attachment_links lista as ligações');
SELECT lives_ok($$DELETE FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'$$, 'excluir o título leva a ligação');
SELECT is((SELECT count(*)::int FROM title_attachments), 0, 'ligação removida');
SELECT is((SELECT count(*)::int FROM attachments WHERE id = '00000000-0000-7000-8000-0000000a7001'), 1, 'o anexo continua');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['attachments', 'title_attachments', 'settlement_attachments', 'movement_attachments',
                    'entity_attachments']) t;
SELECT ok(has_table_privilege('moneyflow_app', 'attachment_links', 'SELECT'), 'app lê attachment_links');
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO attachments (file_name, mime_type, content) VALUES ('app.txt', 'text/plain', '\x41')$$,
                'app envia anexo');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
