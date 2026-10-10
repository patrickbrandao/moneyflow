-- Testes de 0003_entities: entidades, contatos, endereços, dados bancários, PIX e vínculos.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['entities', 'entity_contacts', 'entity_addresses', 'entity_bank_accounts',
                                      'entity_pix_keys', 'entity_links']) t;
SELECT columns_are('entities', ARRAY['id', 'kind', 'name', 'trade_name', 'document', 'birth_date', 'notes',
                                     'archived_at', 'created_at', 'updated_at']);
SELECT fk_ok(t, 'entity_id', 'entities', 'id')
  FROM unnest(ARRAY['entity_contacts', 'entity_addresses', 'entity_bank_accounts', 'entity_pix_keys', 'entity_links']) t;
SELECT fk_ok('entity_links', 'related_entity_id', 'entities', 'id');
SELECT has_index('entities', 'entities_name_trgm_idx');
SELECT has_index('entities', 'entities_trade_name_trgm_idx');
SELECT is((SELECT amname::text FROM pg_class c JOIN pg_am a ON a.oid = c.relam WHERE c.relname = 'entities_name_trgm_idx'),
          'gin', 'índice de nome é GIN trigram');
SELECT has_index('entity_pix_keys', 'entity_pix_keys_primary_key');
SELECT has_index('entity_contacts', 'entity_contacts_primary_key');
SELECT has_index('entity_links', 'entity_links_related_entity_id_idx');
SELECT has_index('entity_links', 'entity_links_spouse_key');
SELECT has_trigger(t, t || '_set_updated_at')
  FROM unnest(ARRAY['entities', 'entity_contacts', 'entity_addresses', 'entity_bank_accounts',
                    'entity_pix_keys', 'entity_links']) t;

-- Entidades -----------------------------------------------------------------------------
INSERT INTO entities (id, kind, name, document, birth_date) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick', '52998224725', '1985-01-01'),
  ('00000000-0000-7000-8000-00000000e004', 'person', 'Sem documento', NULL, NULL);
INSERT INTO entities (id, kind, name, trade_name, document) VALUES
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa Ltda', 'Minha Empresa', '11222333000181'),
  ('00000000-0000-7000-8000-00000000e003', 'company', 'Empresa Alfa S.A.', 'Alfa', '12ABC34501DE35');

SELECT pass('pessoa com CPF válido, empresa com CNPJ numérico e alfanumérico, pessoa sem documento');
SELECT lives_ok($$INSERT INTO entities (kind, name) VALUES ('company', 'Outra sem CNPJ'), ('person', 'Outra sem CPF')$$,
                'document é opcional e pode repetir NULL');

SELECT throws_ok($$INSERT INTO entities (kind, name) VALUES ('robot', 'X')$$, '23514', NULL, 'kind só person|company');
SELECT throws_ok($$INSERT INTO entities (kind, name) VALUES ('person', '  ')$$, '23514', NULL, 'name não pode ser vazio');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('person', 'X', '52998224724')$$,
                 '23514', NULL, 'pessoa com CPF inválido');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('person', 'X', '529.982.247-25')$$,
                 '23514', NULL, 'pessoa com CPF não normalizado');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('person', 'X', '11222333000181')$$,
                 '23514', NULL, 'pessoa com CNPJ é rejeitada');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('company', 'X', '52998224725')$$,
                 '23514', NULL, 'empresa com CPF é rejeitada');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('company', 'X', '12ABC34501DE36')$$,
                 '23514', NULL, 'empresa com CNPJ alfanumérico inválido');
SELECT throws_ok($$INSERT INTO entities (kind, name, document) VALUES ('company', 'X', '11222333000181')$$,
                 '23505', NULL, 'documento é único');
SELECT throws_ok($$INSERT INTO entities (kind, name, trade_name) VALUES ('person', 'X', 'Fantasia')$$,
                 '23514', NULL, 'nome fantasia só em empresa');
SELECT throws_ok($$INSERT INTO entities (kind, name, birth_date) VALUES ('company', 'X', '2000-01-01')$$,
                 '23514', NULL, 'data de nascimento só em pessoa');

SELECT is((SELECT name FROM entities WHERE name % 'Minha Empreza Ltda' ORDER BY similarity(name, 'Minha Empreza Ltda') DESC LIMIT 1),
          'Minha Empresa Ltda', 'busca trigram encontra por nome aproximado');

-- Contatos ---------------------------------------------------------------------------------
INSERT INTO entity_contacts (entity_id, kind, value, is_primary) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'phone', '(11) 99999-0000', true),
  ('00000000-0000-7000-8000-00000000e001', 'email', 'patrick@example.com', true),
  ('00000000-0000-7000-8000-00000000e001', 'phone', '(11) 3333-0000', false);
SELECT pass('contatos: um principal por tipo');
SELECT throws_ok($$INSERT INTO entity_contacts (entity_id, kind, value, is_primary) VALUES ('00000000-0000-7000-8000-00000000e001', 'phone', '(11) 4444-0000', true)$$,
                 '23505', NULL, 'no máximo um telefone principal por entidade');
SELECT throws_ok($$INSERT INTO entity_contacts (entity_id, kind, value) VALUES ('00000000-0000-7000-8000-00000000e001', 'fax', '1')$$,
                 '23514', NULL, 'kind do contato só phone|email|other');
SELECT throws_ok($$INSERT INTO entity_contacts (entity_id, kind, value) VALUES ('00000000-0000-7000-8000-00000000e001', 'email', 'invalido')$$,
                 '23514', NULL, 'contato email com formato inválido');
SELECT throws_ok($$INSERT INTO entity_contacts (entity_id, kind, value) VALUES ('00000000-0000-7000-8000-00000000e001', 'other', ' ')$$,
                 '23514', NULL, 'contato vazio');
SELECT throws_ok($$INSERT INTO entity_contacts (entity_id, kind, value) VALUES ('00000000-0000-7000-8000-00000000e001', 'phone', '(11) 3333-0000')$$,
                 '23505', NULL, 'contato duplicado na mesma entidade');

-- Endereços --------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO entity_addresses (entity_id, label, postal_code, street, number, district, city, state)
                  VALUES ('00000000-0000-7000-8000-00000000e001', 'Casa', '01310100', 'Avenida Paulista', '1000', 'Bela Vista', 'São Paulo', 'SP')$$,
                'endereço válido');
SELECT throws_ok($$INSERT INTO entity_addresses (entity_id, postal_code, city, state) VALUES ('00000000-0000-7000-8000-00000000e001', '01310-100', 'São Paulo', 'SP')$$,
                 '23514', NULL, 'CEP precisa de 8 dígitos sem traço');
SELECT throws_ok($$INSERT INTO entity_addresses (entity_id, city, state) VALUES ('00000000-0000-7000-8000-00000000e001', 'São Paulo', 'XX')$$,
                 '23514', NULL, 'UF precisa ser uma sigla válida');
SELECT throws_ok($$INSERT INTO entity_addresses (entity_id, city, state) VALUES ('00000000-0000-7000-8000-00000000e001', 'São Paulo', 'sp')$$,
                 '23514', NULL, 'UF em maiúsculas');

-- Dados bancários --------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO entity_bank_accounts (entity_id, bank_code, ispb, branch, account_number, account_type, holder_name)
                  VALUES ('00000000-0000-7000-8000-00000000e001', '341', '60701190', '1234', '12345-6', 'checking', 'Patrick')$$,
                'conta bancária válida');
SELECT lives_ok($$INSERT INTO entity_bank_accounts (entity_id, ispb, account_number, account_type)
                  VALUES ('00000000-0000-7000-8000-00000000e001', '18236120', '9876543-X', 'payment')$$,
                'conta de pagamento só com ISPB, sem agência');
SELECT throws_ok($$INSERT INTO entity_bank_accounts (entity_id, account_number, account_type) VALUES ('00000000-0000-7000-8000-00000000e001', '1', 'checking')$$,
                 '23514', NULL, 'exige bank_code ou ispb');
SELECT throws_ok($$INSERT INTO entity_bank_accounts (entity_id, bank_code, account_number, account_type) VALUES ('00000000-0000-7000-8000-00000000e001', '34', '1', 'checking')$$,
                 '23514', NULL, 'COMPE com 3 dígitos');
SELECT throws_ok($$INSERT INTO entity_bank_accounts (entity_id, ispb, account_number, account_type) VALUES ('00000000-0000-7000-8000-00000000e001', '123', '1', 'checking')$$,
                 '23514', NULL, 'ISPB com 8 dígitos');
SELECT throws_ok($$INSERT INTO entity_bank_accounts (entity_id, bank_code, account_number, account_type) VALUES ('00000000-0000-7000-8000-00000000e001', '341', '1', 'investment')$$,
                 '23514', NULL, 'account_type só checking|savings|payment|salary');
SELECT throws_ok($$INSERT INTO entity_bank_accounts (entity_id, bank_code, account_number, account_type) VALUES ('00000000-0000-7000-8000-00000000e001', '341', '12.345-6', 'checking')$$,
                 '23514', NULL, 'número da conta normalizado');

-- Chaves PIX -------------------------------------------------------------------------------
INSERT INTO entity_pix_keys (entity_id, key_type, key_value, is_primary) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'cpf',   '52998224725', true),
  ('00000000-0000-7000-8000-00000000e001', 'email', 'patrick@example.com', false),
  ('00000000-0000-7000-8000-00000000e001', 'phone', '+5511999990000', false),
  ('00000000-0000-7000-8000-00000000e001', 'phone', '+556133330000', false),
  ('00000000-0000-7000-8000-00000000e001', 'evp',   '123e4567-e89b-12d3-a456-426614174000', false),
  ('00000000-0000-7000-8000-00000000e002', 'cnpj',  '11222333000181', true),
  ('00000000-0000-7000-8000-00000000e003', 'cnpj',  '12ABC34501DE35', true);
SELECT pass('chaves PIX válidas de todos os tipos');

SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value, is_primary) VALUES ('00000000-0000-7000-8000-00000000e001', 'evp', '00000000-0000-4000-8000-000000000000', true)$$,
                 '23505', NULL, 'no máximo uma chave PIX principal por entidade');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'cpf', '52998224725')$$,
                 '23505', NULL, 'a mesma chave PIX não pode estar em duas entidades');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'cpf', '52998224724')$$,
                 '23514', NULL, 'PIX cpf com DV inválido');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'cnpj', '11222333000182')$$,
                 '23514', NULL, 'PIX cnpj com DV inválido');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'email', 'Fulano@Example.com')$$,
                 '23514', NULL, 'PIX email precisa estar em minúsculas');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'email', 'fulano.example.com')$$,
                 '23514', NULL, 'PIX email sem @');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'email', repeat('a', 70) || '@example.com')$$,
                 '23514', NULL, 'PIX email com mais de 77 caracteres');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'phone', '11999990000')$$,
                 '23514', NULL, 'PIX telefone sem +55');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'phone', '+55 11 99999-0000')$$,
                 '23514', NULL, 'PIX telefone formatado');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'phone', '+15551234567')$$,
                 '23514', NULL, 'PIX telefone de outro país');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'evp', '123E4567-E89B-12D3-A456-426614174001')$$,
                 '23514', NULL, 'PIX EVP em minúsculas');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'evp', 'abc')$$,
                 '23514', NULL, 'PIX EVP precisa ser UUID');
SELECT throws_ok($$INSERT INTO entity_pix_keys (entity_id, key_type, key_value) VALUES ('00000000-0000-7000-8000-00000000e004', 'boleto', 'x')$$,
                 '23514', NULL, 'key_type só cpf|cnpj|email|phone|evp');

-- Vínculos ---------------------------------------------------------------------------------
INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e002', 'partner_of'),
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e002', 'responsible_for'),
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e004', 'spouse_of');
SELECT pass('vínculos de tipos diferentes entre as mesmas entidades');
SELECT throws_ok($$INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e001', 'other')$$,
                 '23514', NULL, 'sem auto-vínculo');
SELECT throws_ok($$INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e002', 'partner_of')$$,
                 '23505', NULL, 'sem vínculo duplicado');
SELECT throws_ok($$INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES ('00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000e001', 'spouse_of')$$,
                 '23505', NULL, 'spouse_of é simétrico: o inverso é duplicata');
SELECT lives_ok($$INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000e001', 'responsible_for')$$,
                'vínculos direcionados aceitam o sentido inverso');
SELECT throws_ok($$INSERT INTO entity_links (entity_id, related_entity_id, kind) VALUES ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e003', 'friend_of')$$,
                 '23514', NULL, 'kind do vínculo só partner_of|responsible_for|spouse_of|other');

-- Exclusão em cascata dos filhos ------------------------------------------------------------
DELETE FROM entities WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT is((SELECT count(*)::int FROM entity_contacts WHERE entity_id = '00000000-0000-7000-8000-00000000e001')
        + (SELECT count(*)::int FROM entity_addresses WHERE entity_id = '00000000-0000-7000-8000-00000000e001')
        + (SELECT count(*)::int FROM entity_bank_accounts WHERE entity_id = '00000000-0000-7000-8000-00000000e001')
        + (SELECT count(*)::int FROM entity_pix_keys WHERE entity_id = '00000000-0000-7000-8000-00000000e001')
        + (SELECT count(*)::int FROM entity_links WHERE '00000000-0000-7000-8000-00000000e001' IN (entity_id, related_entity_id)),
          0, 'excluir a entidade apaga contatos, endereços, contas, PIX e vínculos');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['entities', 'entity_contacts', 'entity_addresses', 'entity_bank_accounts',
                    'entity_pix_keys', 'entity_links']) t;

SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO entities (kind, name, document) VALUES ('person', 'Pelo app', '11144477735')$$,
                'app insere entidade (CHECK com is_valid_cpf roda como moneyflow_app)');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
