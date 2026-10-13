/* Textos do backup e restauração (spec 019). */
export const backupStrings = {
  nav: 'Backup e restauração',
  title: 'Backup e restauração',
  sub: 'Exporte e importe cadastros, gere backups completos e restaure o sistema.',
  tabs: {
    categories: 'Categorias',
    entities: 'Entidades',
    caixas: 'Caixas',
    'ai-providers': 'Provedores de IA',
    users: 'Usuários',
    backup: 'Backup',
    restore: 'Restauração',
  } as Record<string, string>,

  resources: {
    categories: {
      title: 'Categorias',
      exportHint: 'Plano de categorias completo (receitas e despesas, com as subcategorias, cores e ícones).',
      importHint:
        'Categorias com o mesmo nome no mesmo nível e tipo são consideradas já cadastradas; as novas entram sob o pai correspondente.',
    },
    entities: {
      title: 'Entidades',
      exportHint:
        'Pessoas e empresas (com a marca de favorita) com contatos, endereços, dados bancários, chaves PIX, vínculos e as tags (o catálogo, arquivadas inclusive, e as ligações).',
      importHint:
        'Entidades com o mesmo documento (CPF/CNPJ) ou o mesmo identificador são mantidas como estão, inclusive contatos, endereços, chaves e tags. Tags com o mesmo nome são a mesma tag.',
    },
    caixas: {
      title: 'Caixas',
      exportHint: 'Caixas (gerais e de cartão) com as contas financeiras, os membros e as categorias ocultas.',
      importHint:
        'O titular de cada caixa precisa existir aqui (pelo identificador ou pelo documento): importe as entidades antes. Membros só entram para usuários existentes.',
    },
    'ai-providers': {
      title: 'Provedores de IA',
      exportHint: 'Provedores de IA com as chaves de API e a tabela de preços dos modelos.',
      importHint: 'Provedores com o mesmo nome são mantidos como estão (a chave atual não é trocada).',
    },
    users: {
      title: 'Usuários',
      exportHint: 'Usuários com todos os dados sigilosos: senhas, papéis, papéis por caixa e tokens pessoais (hash).',
      importHint:
        'Usuários com o mesmo nome de usuário ou e-mail são mantidos como estão (a senha atual não é trocada). Papéis por caixa só entram para caixas existentes.',
    },
  } as Record<string, { title: string; exportHint: string; importHint: string }>,

  exportTitle: 'Exportar',
  importTitle: 'Importar',
  exportJson: 'Exportar JSON',
  exporting: 'Exportando…',
  exported: 'Arquivo gerado.',
  secretWarning: 'O arquivo contém segredos em texto puro. Guarde-o em local seguro e não o compartilhe.',
  chooseFile: 'Arquivo de backup (.json ou .zip)',
  chooseDump: 'Arquivo do dump (.zip)',
  noFile: 'Escolha um arquivo.',
  simulate: 'Simular',
  simulating: 'Simulando…',
  import: 'Importar',
  importing: 'Importando…',
  importDone: 'Importação concluída.',
  simulationDone: 'Simulação concluída: nada foi gravado.',
  mergeRule:
    'A importação faz merge: o que já está cadastrado permanece como está, e nada que gere conflito é gravado. Os itens não importados aparecem com o motivo.',
  confirmImport: 'Importar este arquivo?',
  confirmImportHint: 'Os registros novos serão gravados. O que já existe não é alterado.',

  report: {
    title: 'Resultado',
    simulation: 'Simulação (nada foi gravado)',
    resource: 'Recurso',
    total: 'No arquivo',
    imported: 'Importados',
    existing: 'Já cadastrados',
    skipped: 'Mantidos',
    failed: 'Não importados',
    issues: 'Itens não importados',
    issuesFailed: 'Conflitos e erros',
    issuesExisting: 'Já cadastrados',
    item: 'Item',
    reason: 'Motivo',
    noIssues: 'Todos os itens do arquivo foram importados.',
    noneInFilter: 'Nenhum item nesta lista.',
    truncated: (shown: number, total: number) => `Mostrando ${shown} de ${total} itens.`,
    ignoredTables: (tables: string) => `Tabelas do arquivo ignoradas: ${tables}.`,
    schemaMismatch: (source: string, current: string) =>
      `O arquivo veio do schema ${source} e este banco está no ${current}; colunas que não existem aqui são ignoradas.`,
    duration: (seconds: string) => `Concluído em ${seconds} s.`,
    downloadCsv: 'Baixar CSV',
    statuses: { existing: 'Já cadastrado', skipped: 'Mantido', failed: 'Não importado' } as Record<string, string>,
  },

  backup: {
    dumpTitle: 'Dump do PostgreSQL',
    dumpHint:
      'Cópia exata do banco inteiro (estrutura e dados, inclusive segredos), no formato do pg_dump, dentro de um .zip. É o arquivo usado na restauração completa.',
    dumpButton: 'Gerar dump (.zip)',
    dumpRunning: 'Gerando dump…',
    jsonTitle: 'JSON completo',
    jsonHint:
      'Todo o conteúdo do sistema em JSON, tabela por tabela (inclusive segredos e anexos), dentro de um .zip. Serve para importar com merge em outro sistema ou neste.',
    jsonButton: 'Exportar JSON completo (.zip)',
    jsonRunning: 'Exportando…',
    excluded:
      'Ficam de fora do JSON: sessões, log de auditoria, fila de mensagens, notificações do sino, execuções dos agentes e embeddings (estado operacional ou recalculável).',
    unavailable: 'Indisponível',
    pgDump: (version: string) => `pg_dump ${version}`,
    schema: (version: string) => `Schema ${version}`,
  },

  restore: {
    dumpTitle: 'Restaurar dump do PostgreSQL',
    dumpHint:
      'Apaga o banco atual e o recria 100% a partir do dump: todos os dados, usuários e sessões passam a ser os do backup. A restauração roda numa transação única: se falhar, nada muda.',
    dumpWarning: 'Ação destrutiva e irreversível. Gere um dump do banco atual antes, por segurança.',
    typeToConfirm: (word: string) => `Digite ${word} para confirmar`,
    restoreButton: 'Restaurar banco',
    restoring: 'Restaurando…',
    confirmTitle: 'Restaurar o banco a partir do dump?',
    confirmBody: 'Todo o conteúdo atual será substituído pelo do arquivo. Você provavelmente precisará entrar de novo.',
    restored: 'Banco restaurado. Entre novamente.',
    jsonTitle: 'Importar JSON completo',
    jsonHint:
      'Faz merge recurso por recurso: registros novos entram, os já cadastrados permanecem e nada que gere conflito é gravado. Simule antes para ver o resultado.',
  },

  reasons: {
    existsId: 'Já cadastrado (mesmo identificador); o registro atual foi mantido.',
    existsKey: (key: string) => `Já cadastrado (mesmo ${key}); o registro atual foi mantido.`,
    owned: (parent: string) => `Pertence a ${parent} já cadastrado; os dados atuais foram mantidos.`,
    dependsFailed: (table: string, label: string) => `Depende de ${table} «${label}», que não foi importado.`,
    dependsMissing: (table: string, label: string) => `Depende de ${table} «${label}», que não existe neste sistema.`,
    noId: 'Registro sem identificador válido.',
    cycle: 'Dependência circular entre registros do arquivo.',
    db: (message: string) => `Rejeitado pelo banco: ${message}`,
    linked: (reason: string) => `Não importado com os registros ligados a ele: ${reason}`,
  },

  keyLabels: {
    username: 'nome de usuário',
    email: 'e-mail',
    name: 'nome',
    document: 'documento',
    model: 'modelo e vigência',
    access_key: 'chave de acesso',
    user_id: 'usuário e caixa',
    caixa_id: 'caixa e categoria',
    attachment_id: 'mensagem e anexo',
  } as Record<string, string>,

  /** Tabelas que a auditoria não nomeia (as demais vêm de t.audit.tables). */
  tables: {
    ai_providers: 'Provedores de IA',
    ai_model_prices: 'Preços de modelos',
    ai_agents: 'Agentes de IA',
    mcp_servers: 'Servidores MCP',
    agent_mcp_servers: 'MCP dos agentes',
    ai_conversations: 'Conversas',
    ai_messages: 'Mensagens das conversas',
    ai_message_attachments: 'Anexos das conversas',
    ai_usage: 'Uso de IA',
    user_api_tokens: 'Tokens pessoais',
    message_destinations: 'Destinos de mensagens',
    message_subscriptions: 'Assinaturas de mensagens',
    message_subscription_caixas: 'Caixas das assinaturas',
    canvas_node_positions: 'Posições do canvas',
  } as Record<string, string>,

  errors: {
    invalidFile: 'Arquivo inválido: não é um backup do MoneyFlow (.json ou .zip).',
    newerFormat: 'O arquivo foi gerado por uma versão mais nova do MoneyFlow.',
    emptyFile: 'O arquivo não contém registros deste recurso.',
    tooLarge: 'Arquivo grande demais para importar.',
    dumpUnavailable: 'Dump indisponível: configure DATABASE_OWNER_URL (conexão do dono do banco) e o pg_dump 18.',
    noOwnerUrl: 'DATABASE_OWNER_URL (conexão do dono do banco) não está configurada.',
    noPgDump: 'pg_dump não encontrado (instale o cliente do PostgreSQL 18 ou ajuste PG_BIN_DIR).',
    oldPgDump: (version: string) => `pg_dump ${version} é antigo: o servidor é PostgreSQL 18.`,
    dumpFailed: 'Falha ao gerar o dump do banco.',
    invalidDump: 'Arquivo inválido: envie o .zip gerado pelo "Gerar dump" (com moneyflow.dump dentro).',
    schemaMismatch: (dump: string, current: string) =>
      `O dump é do schema ${dump} e este banco está no ${current}. Restaure com a mesma versão do MoneyFlow que gerou o dump.`,
    restoreFailed: (detail: string) => `A restauração falhou e nada foi alterado: ${detail}`,
    confirmation: 'Confirmação inválida.',
    busy: 'Já existe uma operação de backup ou restauração em andamento.',
  },
};
