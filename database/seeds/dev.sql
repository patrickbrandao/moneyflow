-- Dados de desenvolvimento (idempotente: pode rodar várias vezes).
-- Plano inicial de categorias em pt-BR, doméstico e empresarial.
-- Sem usuários: o primeiro admin nasce no boot da aplicação (spec 002).
BEGIN;

-- Grupos (cor = slot 1–12 do design system, token --port-N) -------------------------
INSERT INTO categories (kind, name, color_slot, icon) VALUES
  -- Despesas
  ('expense', 'Moradia',                  1, 'house'),
  ('expense', 'Alimentação',              2, 'utensils'),
  ('expense', 'Transporte',               3, 'car'),
  ('expense', 'Saúde',                    4, 'heart-pulse'),
  ('expense', 'Educação',                 5, 'graduation-cap'),
  ('expense', 'Lazer',                    6, 'party-popper'),
  ('expense', 'Vestuário e cuidados',     7, 'shirt'),
  ('expense', 'Família e pets',           8, 'users'),
  ('expense', 'Assinaturas e serviços',   9, 'repeat'),
  ('expense', 'Impostos e taxas',        10, 'landmark'),
  ('expense', 'Encargos financeiros',    11, 'percent'),
  ('expense', 'Pessoal',                 12, 'id-card'),
  ('expense', 'Operacional',              1, 'building-2'),
  ('expense', 'Comercial e marketing',    2, 'megaphone'),
  ('expense', 'Serviços profissionais',   3, 'briefcase'),
  ('expense', 'Tributos da empresa',      4, 'receipt'),
  ('expense', 'Outras despesas',          5, 'circle-ellipsis'),
  ('expense', 'Cartão de crédito',        6, 'credit-card'),
  -- Receitas
  ('income',  'Trabalho',                7, 'wallet'),
  ('income',  'Vendas e serviços',       8, 'store'),
  ('income',  'Investimentos',           9, 'trending-up'),
  ('income',  'Aluguéis recebidos',     10, 'key-round'),
  ('income',  'Reembolsos',             11, 'undo-2'),
  ('income',  'Outras receitas',        12, 'circle-ellipsis'),
  -- Lado do cartão da fatura-título (spec 007): "a receber" na caixa do cartão.
  ('income',  'Cartão de crédito',       6, 'credit-card')
ON CONFLICT (kind, parent_id, lower(name)) DO UPDATE
  SET color_slot = EXCLUDED.color_slot, icon = EXCLUDED.icon;

-- Subcategorias -------------------------------------------------------------------------
INSERT INTO categories (kind, parent_id, name)
SELECT v.kind, g.id, v.name
  FROM (VALUES
    ('expense', 'Moradia', 'Aluguel'),
    ('expense', 'Moradia', 'Condomínio'),
    ('expense', 'Moradia', 'IPTU'),
    ('expense', 'Moradia', 'Energia elétrica'),
    ('expense', 'Moradia', 'Água e esgoto'),
    ('expense', 'Moradia', 'Gás'),
    ('expense', 'Moradia', 'Internet e telefone'),
    ('expense', 'Moradia', 'Manutenção e reparos'),
    ('expense', 'Moradia', 'Funcionários domésticos'),
    ('expense', 'Moradia', 'Móveis e utensílios'),
    ('expense', 'Moradia', 'Seguro residencial'),

    ('expense', 'Alimentação', 'Supermercado'),
    ('expense', 'Alimentação', 'Feira e hortifrúti'),
    ('expense', 'Alimentação', 'Padaria'),
    ('expense', 'Alimentação', 'Restaurantes'),
    ('expense', 'Alimentação', 'Delivery'),

    ('expense', 'Transporte', 'Combustível'),
    ('expense', 'Transporte', 'Estacionamento'),
    ('expense', 'Transporte', 'Pedágio'),
    ('expense', 'Transporte', 'Manutenção do veículo'),
    ('expense', 'Transporte', 'Seguro do veículo'),
    ('expense', 'Transporte', 'IPVA e licenciamento'),
    ('expense', 'Transporte', 'Aplicativos e táxi'),
    ('expense', 'Transporte', 'Transporte público'),
    ('expense', 'Transporte', 'Multas'),

    ('expense', 'Saúde', 'Plano de saúde'),
    ('expense', 'Saúde', 'Consultas e exames'),
    ('expense', 'Saúde', 'Farmácia'),
    ('expense', 'Saúde', 'Odontologia'),
    ('expense', 'Saúde', 'Academia e esportes'),

    ('expense', 'Educação', 'Mensalidade escolar'),
    ('expense', 'Educação', 'Cursos'),
    ('expense', 'Educação', 'Material escolar'),
    ('expense', 'Educação', 'Livros'),

    ('expense', 'Lazer', 'Viagens'),
    ('expense', 'Lazer', 'Cinema e eventos'),
    ('expense', 'Lazer', 'Bares e passeios'),
    ('expense', 'Lazer', 'Hobbies'),

    ('expense', 'Vestuário e cuidados', 'Roupas e calçados'),
    ('expense', 'Vestuário e cuidados', 'Cabeleireiro e estética'),
    ('expense', 'Vestuário e cuidados', 'Higiene e cosméticos'),

    ('expense', 'Família e pets', 'Mesada'),
    ('expense', 'Família e pets', 'Presentes'),
    ('expense', 'Família e pets', 'Pensão alimentícia'),
    ('expense', 'Família e pets', 'Pet: alimentação'),
    ('expense', 'Família e pets', 'Pet: veterinário'),
    ('expense', 'Família e pets', 'Doações'),

    ('expense', 'Assinaturas e serviços', 'Streaming'),
    ('expense', 'Assinaturas e serviços', 'Software e apps'),
    ('expense', 'Assinaturas e serviços', 'Celular'),
    ('expense', 'Assinaturas e serviços', 'Clubes e associações'),

    ('expense', 'Impostos e taxas', 'Imposto de renda (pessoa física)'),
    ('expense', 'Impostos e taxas', 'Taxas e emolumentos'),
    ('expense', 'Impostos e taxas', 'Cartório'),

    ('expense', 'Encargos financeiros', 'Tarifas bancárias'),
    ('expense', 'Encargos financeiros', 'Juros'),
    ('expense', 'Encargos financeiros', 'Multas por atraso'),
    ('expense', 'Encargos financeiros', 'IOF'),
    ('expense', 'Encargos financeiros', 'Anuidade de cartão'),

    ('expense', 'Pessoal', 'Salários'),
    ('expense', 'Pessoal', 'Pró-labore'),
    ('expense', 'Pessoal', 'Férias e 13º'),
    ('expense', 'Pessoal', 'FGTS'),
    ('expense', 'Pessoal', 'INSS'),
    ('expense', 'Pessoal', 'Vale-transporte'),
    ('expense', 'Pessoal', 'Vale-refeição e alimentação'),
    ('expense', 'Pessoal', 'Plano de saúde dos colaboradores'),
    ('expense', 'Pessoal', 'Rescisões'),
    ('expense', 'Pessoal', 'Treinamentos'),

    ('expense', 'Operacional', 'Aluguel comercial'),
    ('expense', 'Operacional', 'Condomínio comercial'),
    ('expense', 'Operacional', 'Energia elétrica'),
    ('expense', 'Operacional', 'Água'),
    ('expense', 'Operacional', 'Internet e telefonia'),
    ('expense', 'Operacional', 'Material de escritório'),
    ('expense', 'Operacional', 'Material de limpeza'),
    ('expense', 'Operacional', 'Manutenção'),
    ('expense', 'Operacional', 'Equipamentos'),
    ('expense', 'Operacional', 'Software e sistemas'),
    ('expense', 'Operacional', 'Fretes e correios'),
    ('expense', 'Operacional', 'Mercadorias e insumos'),
    ('expense', 'Operacional', 'Seguros'),

    ('expense', 'Comercial e marketing', 'Publicidade e anúncios'),
    ('expense', 'Comercial e marketing', 'Comissões'),
    ('expense', 'Comercial e marketing', 'Brindes'),
    ('expense', 'Comercial e marketing', 'Eventos e feiras'),
    ('expense', 'Comercial e marketing', 'Viagens a negócios'),

    ('expense', 'Serviços profissionais', 'Contabilidade'),
    ('expense', 'Serviços profissionais', 'Jurídico'),
    ('expense', 'Serviços profissionais', 'Consultoria'),
    ('expense', 'Serviços profissionais', 'Terceirizados'),

    ('expense', 'Tributos da empresa', 'Simples Nacional (DAS)'),
    ('expense', 'Tributos da empresa', 'ISS'),
    ('expense', 'Tributos da empresa', 'ICMS'),
    ('expense', 'Tributos da empresa', 'PIS e COFINS'),
    ('expense', 'Tributos da empresa', 'IRPJ e CSLL'),
    ('expense', 'Tributos da empresa', 'IBS e CBS'),
    ('expense', 'Tributos da empresa', 'Alvarás e licenças'),

    -- Fatura-título na caixa pagadora (spec 007). As compras do cartão têm as próprias categorias.
    ('expense', 'Cartão de crédito', 'Fatura do cartão'),
    ('income', 'Cartão de crédito', 'Fatura a receber'),

    ('expense', 'Outras despesas', 'Diversos'),
    ('expense', 'Outras despesas', 'Ajustes'),

    ('income', 'Trabalho', 'Salário'),
    ('income', 'Trabalho', '13º salário'),
    ('income', 'Trabalho', 'Férias'),
    ('income', 'Trabalho', 'Pró-labore'),
    ('income', 'Trabalho', 'Distribuição de lucros'),
    ('income', 'Trabalho', 'Freelance e honorários'),
    ('income', 'Trabalho', 'Aposentadoria e pensão'),

    ('income', 'Vendas e serviços', 'Venda de produtos'),
    ('income', 'Vendas e serviços', 'Prestação de serviços'),
    ('income', 'Vendas e serviços', 'Mensalidades e contratos'),
    ('income', 'Vendas e serviços', 'Comissões recebidas'),

    ('income', 'Investimentos', 'Rendimentos'),
    ('income', 'Investimentos', 'Dividendos'),
    ('income', 'Investimentos', 'Juros recebidos'),
    ('income', 'Investimentos', 'Resgates'),

    ('income', 'Aluguéis recebidos', 'Aluguel de imóvel'),
    ('income', 'Aluguéis recebidos', 'Aluguel por temporada'),

    ('income', 'Reembolsos', 'Reembolso de despesas'),
    ('income', 'Reembolsos', 'Restituição de imposto de renda'),
    ('income', 'Reembolsos', 'Estornos'),

    ('income', 'Outras receitas', 'Presentes e doações'),
    ('income', 'Outras receitas', 'Prêmios'),
    ('income', 'Outras receitas', 'Venda de bens'),
    ('income', 'Outras receitas', 'Diversos')
  ) AS v (kind, parent_name, name)
  JOIN categories g ON g.kind = v.kind AND g.parent_id IS NULL AND lower(g.name) = lower(v.parent_name)
ON CONFLICT (kind, parent_id, lower(name)) DO NOTHING;

-- Agente de exemplo (spec 011) ------------------------------------------------------------
-- Sem provedor nem chave (segredos não entram em seed): nasce INATIVO. O admin escolhe o
-- provedor e o modelo na tela de agentes e o ativa.
-- Kit de ferramentas (spec 021) com todas as tools do registro (packages/shared/src/agents/tools.ts,
-- tools-operation.ts e tools-admin.ts: 155 tools, inclusive as das F13a/F13b, os orçamentos da F14, as tarefas
-- agendadas da F15 e a cópia de regras de classificação da F18) no modo sugerido de cada
-- uma (suggestedMode): leituras, notify_user e refresh_mcp_tools em allow, as demais escritas em ask; as tools
-- com segredos (digitados no cartão de aprovação) sempre em ask. Tool nova no registro entra aqui também. Kit já existente
-- ganha as que faltam; as que já estão nele ficam no modo que o admin escolheu.
INSERT INTO ai_tool_kits (name, description)
VALUES ('Padrão', 'Todas as ferramentas, com o modo sugerido: leituras e "avisar o usuário" direto, as demais escritas pedem aprovação.')
ON CONFLICT ((lower(name))) DO NOTHING;

INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode)
SELECT k.id, t.tool_name, t.mode
  FROM ai_tool_kits k
 CROSS JOIN (VALUES
  ('search_records', 'allow'), ('semantic_search', 'allow'), ('list_caixas', 'allow'), ('get_caixa', 'allow'),
  ('list_accounts', 'allow'), ('get_account_statement', 'allow'), ('list_entities', 'allow'),
  ('list_entity_tags', 'allow'), ('get_entity', 'allow'), ('list_categories', 'allow'), ('list_titles', 'allow'),
  ('get_title', 'allow'), ('list_transfers', 'allow'), ('get_card', 'allow'), ('get_invoice', 'allow'),
  ('list_card_purchases', 'allow'), ('calendar', 'allow'), ('report_categories', 'allow'),
  ('report_entities', 'allow'), ('report_projection', 'allow'), ('flow_graph', 'allow'),
  ('list_statement_imports', 'allow'), ('get_statement_import', 'allow'), ('list_line_candidates', 'allow'),
  ('list_message_destinations', 'allow'), ('create_entity', 'ask'), ('update_entity', 'ask'),
  ('set_entity_tags', 'ask'), ('set_entity_favorite', 'ask'), ('add_pix_key', 'ask'), ('create_title', 'ask'),
  ('update_title', 'ask'), ('end_series', 'ask'), ('settle_title', 'ask'), ('reverse_settlement', 'ask'),
  ('create_transfer', 'ask'), ('create_card_purchase', 'ask'), ('match_statement_line', 'ask'),
  ('match_statement_lines', 'ask'), ('confirm_statement_lines', 'ask'), ('unmatch_statement_line', 'ask'),
  ('ignore_statement_lines', 'ask'), ('unignore_statement_lines', 'ask'), ('create_from_statement_line', 'ask'),
  ('create_from_statement_lines', 'ask'), ('classify_statement_lines', 'ask'),
  ('apply_classification_suggestions', 'ask'), ('send_telegram_message', 'ask'), ('notify_user', 'allow'),
  ('list_contracts', 'allow'), ('get_contract', 'allow'), ('create_contract', 'ask'), ('update_contract', 'ask'),
  ('activate_contract', 'ask'), ('add_contract_amendment', 'ask'), ('terminate_contract', 'ask'),
  ('decide_contract_renewal', 'ask'), ('get_contract_document', 'allow'), ('save_contract_markdown', 'ask'),
  ('convert_contract_pdf', 'ask'), ('import_statement', 'ask'), ('import_nfe', 'ask'), ('read_document', 'allow'),
  ('parse_payment_code', 'allow'), ('attach_file', 'ask'), ('close_invoice', 'ask'), ('pay_invoice', 'ask'),
  ('reopen_invoice', 'ask'), ('create_card_charge', 'ask'), ('refund_card_purchase', 'ask'), ('create_caixa', 'ask'),
  ('update_caixa', 'ask'), ('archive_caixa', 'ask'), ('create_account', 'ask'), ('update_account', 'ask'),
  ('archive_account', 'ask'), ('create_adjustment', 'ask'), ('cancel_title', 'ask'), ('archive_title', 'ask'),
  ('delete_title', 'ask'), ('accept_mirror', 'ask'), ('dispute_mirror', 'ask'), ('delete_transfer', 'ask'),
  ('create_category', 'ask'), ('update_category', 'ask'), ('archive_category', 'ask'),
  ('list_classification_rules', 'allow'), ('create_classification_rule', 'ask'),
  ('update_classification_rule', 'ask'), ('archive_classification_rule', 'ask'),
  ('copy_classification_rules', 'ask'), ('create_entity_tag', 'ask'),
  ('update_entity_tag', 'ask'), ('archive_entity_tag', 'ask'), ('list_message_subscriptions', 'allow'),
  ('create_message_destination', 'ask'), ('update_message_destination', 'ask'),
  ('archive_message_destination', 'ask'), ('set_message_subscriptions', 'ask'), ('send_test_message', 'ask'),
  ('list_notifications', 'allow'), ('list_month_closings', 'allow'), ('close_month', 'ask'), ('reopen_month', 'ask'),
  ('get_audit_history', 'allow'), ('list_users', 'allow'), ('create_user', 'ask'), ('update_user', 'ask'),
  ('set_user_active', 'ask'), ('set_user_password', 'ask'), ('list_caixa_members', 'allow'),
  ('set_caixa_member', 'ask'), ('remove_caixa_member', 'ask'), ('list_api_tokens', 'allow'),
  ('revoke_api_token', 'ask'), ('list_ai_providers', 'allow'), ('create_ai_provider', 'ask'),
  ('update_ai_provider', 'ask'), ('archive_ai_provider', 'ask'), ('test_provider', 'allow'),
  ('list_provider_models', 'allow'), ('list_ai_prices', 'allow'), ('create_ai_price', 'ask'),
  ('delete_ai_price', 'ask'), ('list_ai_agents', 'allow'), ('create_ai_agent', 'ask'), ('update_ai_agent', 'ask'),
  ('archive_ai_agent', 'ask'), ('list_agent_tools', 'allow'), ('list_tool_kits', 'allow'),
  ('create_tool_kit', 'ask'), ('update_tool_kit', 'ask'), ('duplicate_tool_kit', 'ask'), ('delete_tool_kit', 'ask'),
  ('list_mcp_servers', 'allow'), ('create_mcp_server', 'ask'), ('update_mcp_server', 'ask'),
  ('archive_mcp_server', 'ask'), ('refresh_mcp_tools', 'allow'), ('get_app_settings', 'allow'),
  ('set_app_setting', 'ask'), ('get_ai_usage', 'allow'), ('list_ai_requests', 'allow'), ('export_backup', 'ask'),
  ('simulate_import', 'allow'), ('import_backup', 'ask'), ('list_ai_budgets', 'allow'), ('create_ai_budget', 'ask'),
  ('update_ai_budget', 'ask'), ('delete_ai_budget', 'ask'), ('list_agent_tasks', 'allow'),
  ('create_agent_task', 'ask'), ('update_agent_task', 'ask'), ('delete_agent_task', 'ask'),
  ('run_agent_task_now', 'ask')
       ) AS t (tool_name, mode)
 WHERE lower(k.name) = lower('Padrão')
ON CONFLICT (kit_id, tool_name) DO NOTHING;

INSERT INTO ai_agents (name, description, system_prompt, params, tool_kit_id, color_slot, icon, is_active)
VALUES ('Assistente geral',
        'Responde sobre contas, caixas e títulos e ajuda a lançar e conciliar, com as permissões de quem o aciona.',
        'Você é o assistente financeiro do MoneyFlow. Responda em português do Brasil, de forma objetiva. '
        'Valores em reais (R$). Use as ferramentas para consultar os dados antes de responder e nunca invente '
        'números. Antes de alterar qualquer registro, explique o que vai fazer.',
        '{"temperature": 0.3, "max_tool_iterations": 20}',
        (SELECT id FROM ai_tool_kits WHERE lower(name) = lower('Padrão')), 1, 'bot', false)
ON CONFLICT ((lower(name))) DO NOTHING;


-- Tags de entidade de exemplo (spec 003): catálogo global, cor = slot 1–12.
INSERT INTO entity_tags (name, color_slot) VALUES
  ('Cliente', 1), ('Fornecedor', 2), ('Família', 3), ('Governo', 4)
ON CONFLICT (name) DO NOTHING;

COMMIT;
