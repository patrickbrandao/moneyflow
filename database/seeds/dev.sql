-- Dados de desenvolvimento (idempotente: pode rodar várias vezes).
-- Plano inicial de categorias em pt-BR, doméstico e empresarial.
-- Sem usuários: o primeiro admin nasce no boot da aplicação (spec 002).
BEGIN;

-- Grupos ------------------------------------------------------------------------------
INSERT INTO categories (kind, name, color, icon) VALUES
  -- Despesas
  ('expense', 'Moradia',                 'blue',    'house'),
  ('expense', 'Alimentação',             'orange',  'utensils'),
  ('expense', 'Transporte',              'amber',   'car'),
  ('expense', 'Saúde',                   'red',     'heart-pulse'),
  ('expense', 'Educação',                'indigo',  'graduation-cap'),
  ('expense', 'Lazer',                   'pink',    'party-popper'),
  ('expense', 'Vestuário e cuidados',    'fuchsia', 'shirt'),
  ('expense', 'Família e pets',          'rose',    'users'),
  ('expense', 'Assinaturas e serviços',  'violet',  'repeat'),
  ('expense', 'Impostos e taxas',        'slate',   'landmark'),
  ('expense', 'Encargos financeiros',    'stone',   'percent'),
  ('expense', 'Pessoal',                 'teal',    'id-card'),
  ('expense', 'Operacional',             'cyan',    'building-2'),
  ('expense', 'Comercial e marketing',   'purple',  'megaphone'),
  ('expense', 'Serviços profissionais',  'sky',     'briefcase'),
  ('expense', 'Tributos da empresa',     'zinc',    'receipt'),
  ('expense', 'Outras despesas',         'gray',    'circle-ellipsis'),
  -- Receitas
  ('income',  'Trabalho',                'green',   'wallet'),
  ('income',  'Vendas e serviços',       'emerald', 'store'),
  ('income',  'Investimentos',           'lime',    'trending-up'),
  ('income',  'Aluguéis recebidos',      'teal',    'key-round'),
  ('income',  'Reembolsos',              'sky',     'undo-2'),
  ('income',  'Outras receitas',         'gray',    'circle-ellipsis')
ON CONFLICT (kind, parent_id, lower(name)) DO NOTHING;

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

COMMIT;
