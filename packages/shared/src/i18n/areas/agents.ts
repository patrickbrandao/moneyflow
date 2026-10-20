/* Agentes de IA (spec 011): textos usados pela API, pelo worker e pelas tools. */
export const agentsStrings = {
  errors: {
    agentNotFound: 'Agente não encontrado.',
    agentInactive: 'Este agente está desativado.',
    agentNotReady: 'Para ativar o agente, escolha o provedor e o modelo.',
    runActive: 'Já há uma execução em andamento nesta sessão. Aguarde ou pare a execução.',
    runNotActive: 'Esta execução já terminou.',
    readOnly: 'Você está lendo a sessão de outro usuário (somente leitura).',
    sessionFinished: 'Esta sessão foi finalizada (somente leitura). Bifurque a partir dela para continuar.',
    sessionActiveDelete: 'Finalize a sessão antes de excluí-la.',
    sessionNotChat: 'Esta conversa é de um fluxo automático, não uma sessão do chat.',
    providerInactive: 'O provedor de IA deste agente está desativado.',
    providerMissing: 'Nenhum agente de IA ativo está configurado. Peça ao administrador para configurar um provedor e um agente.',
    providerError: (message: string) => `O provedor de IA respondeu com erro: ${message}`,
    toolUnknown: (name: string) => `Tool desconhecida ou não habilitada: ${name}`,
    attachmentNotInSession: 'O anexo não é desta sessão: use um arquivo enviado nesta conversa.',
    invoiceAdvanceFields: 'Fatura aberta: o pagamento antecipado precisa de valor maior que zero e da conta (financialAccountId).',
    invoiceAdvanceCharges: 'Encargos (charges) só entram no pagamento parcial de uma fatura fechada.',
    alreadyArchived: 'O registro já está arquivado.',
    titleAlreadyCanceled: 'O título já está cancelado.',
    /** Segredos (spec 027): digitados no cartão de aprovação do console, nunca pelo modelo. */
    secretNeedsConsole: 'Esta ação precisa de um segredo: abra o console para digitar o segredo no cartão de aprovação.',
    secretRequired: (label: string) => `Informe ${label} no cartão de aprovação.`,
    /** Arquivo gerado por uma tool (spec 027): vira anexo da sessão, até 20 MB. */
    fileTooLarge: (size: string) =>
      `O arquivo gerado tem ${size}, acima do limite de 20 MB dos anexos. Gere-o pela tela (Administração → Backup e restauração).`,
    toolInvalidInput: (detail: string) => `Entrada inválida para a tool: ${detail}`,
    confirmationRejected: (reason: string | null) =>
      reason ? `O usuário recusou esta ação. Motivo: ${reason}` : 'O usuário recusou esta ação.',
    confirmationExpired: 'A confirmação expirou.',
    maxIterations: 'O agente atingiu o limite de passos desta execução.',
    canceled: 'Execução interrompida pelo usuário.',
    tokenInvalid: 'Token de API inválido, revogado ou expirado.',
    documentUnreadable: 'Não consegui ler o documento. Preencha à mão.',
    mcpUnavailable: (name: string, message: string) => `Servidor MCP ${name} indisponível: ${message}`,
    noAttachments: 'Este provedor não aceita este tipo de anexo.',
    forkCut: 'Escolha uma mensagem que não deixe uma ação sem resultado.',
    toolKitNotFound: 'Kit de ferramentas não encontrado.',
    unknownVariables: (names: string[]) =>
      `Variável desconhecida no prompt: ${names.map((n) => `{{${n}}}`).join(', ')}. Use as da lista ou escreva \\{{ para as chaves literais.`,
    promptVersionNotFound: 'Versão do prompt não encontrada.',
    primaryCaixaNotReadable: 'Escolha uma caixa que você pode ver.',
    primaryCaixaNotGeneral: 'A caixa principal tem de ser uma caixa comum (não um cartão).',
    toolKitInUse: (agents: string[]) =>
      `O kit está em uso e não pode ser excluído. Agentes que o usam: ${agents.join(', ')}. Troque o kit deles antes.`,
    anthropicCapabilities: 'O tipo Anthropic só tem texto e visão (a Messages API não tem embeddings nem áudio).',
    compatibleTextModel: 'Informe o modelo de texto padrão: ele é obrigatório num servidor compatível com a Messages API.',
    capabilityInUse: (agents: string) =>
      `Esta capacidade está em uso e não pode ser desmarcada. Agentes que a usam: ${agents}. Troque o provedor deles antes.`,
    inferenceProvider: (capability: string) => `Escolha um provedor ativo com a capacidade "${capability}".`,
    agentNoVision: 'Este agente não lê imagens.',
    agentNoSpeech: 'Este agente não converte texto em áudio.',
    agentNoTranscription: 'Este agente não converte áudio em texto.',
    speechNoText: 'Esta mensagem não tem texto para ouvir.',
    transcriptionNotFound: 'Este anexo não tem transcrição.',
    notAudio: 'Este anexo não é um áudio.',
    /** Orçamentos e limite por minuto (spec 028). */
    budgetExceeded: (scope: string) => `Orçamento de IA do mês atingido: ${scope}`,
    rateLimited: (limit: number, seconds: number) =>
      `Limite de ${limit} execuç${limit === 1 ? 'ão' : 'ões'} de IA por minuto atingido. Tente de novo em ${seconds} s.`,
    budgetNotFound: 'Orçamento não encontrado.',
    embeddingDimensions: (got: number) => `O modelo precisa produzir 1536 dimensões (devolveu ${got}).`,
  },
  /** Rótulo do escopo do orçamento (spec 028), no erro, no aviso e na tela. */
  budgetScope: {
    global: 'global',
    flows: 'fluxos automáticos',
    agent: (name: string | null) => `agente ${name ?? '(removido)'}`,
    user: (username: string | null) => (username ? `usuário @${username}` : 'usuário (removido)'),
  },
  /** Capacidades dos provedores (spec 024), em ordem canônica. */
  capabilities: {
    text: 'Texto',
    vision: 'Visão',
    embeddings: 'Embeddings',
    transcription: 'Áudio→texto',
    speech: 'Texto→áudio',
  } as Record<string, string>,
  /** Como um anexo chega ao modelo de texto quando o agente não o lê direto (spec 024). */
  attachments: {
    /** Rótulo antes de cada anexo enviado ao modelo: o id serve às tools que recebem anexo (spec 027). */
    label: (name: string, mime: string, id: string) => `[Anexo "${name}" (${mime}) — attachmentId ${id}]`,
    imageDescription: (name: string, text: string) => `[Imagem "${name}" — descrição]: ${text}`,
    documentDescription: (name: string, text: string) => `[PDF "${name}" — conteúdo extraído]: ${text}`,
    pdfText: (name: string, text: string) => `[PDF "${name}" — camada de texto]:\n${text}`,
    pdfNoText: (name: string) => `[PDF "${name}"]: PDF sem texto e o agente não tem visão.`,
    imageUnreadable: (name: string) => `[Imagem "${name}"]: este agente não lê imagens.`,
    /** O áudio nunca vai ao modelo de texto, só a transcrição (spec 025). */
    audioTranscript: (name: string, duration: string | null, text: string) =>
      `[Áudio "${name}"${duration ? ` (${duration})` : ''} — transcrição]: ${text}`,
    audioNoTranscript: (name: string) => `[Áudio "${name}" sem transcrição]`,
    /** Arquivo de backup (leva chaves e senhas): o conteúdo nunca vai ao modelo (spec 027). */
    backupWithheld: (name: string) =>
      `[Backup "${name}": o conteúdo não é enviado ao modelo (leva chaves e senhas); use simulate_import ou import_backup com o attachmentId.]`,
    describePrompt:
      'Descreva o anexo para outro modelo que não consegue vê-lo. Transcreva todo o texto legível (valores, datas, nomes, documentos, códigos) e descreva o que não é texto (tabelas, gráficos, fotos) de forma objetiva. Responda só com a descrição, em português.',
  },
  /** Resultado de uma tool com segredo para o modelo (o valor nunca vai). */
  secrets: {
    set: 'segredo definido',
    kept: 'segredo mantido (campo vazio)',
  },
  search: {
    indexBuilding: 'índice em construção: parte dos resultados veio da busca por semelhança de texto',
  },
  /** Categorias das tools (spec 021), na ordem de AGENT_TOOL_CATEGORIES. */
  toolCategories: {
    search: 'Busca e consulta',
    caixas: 'Caixas e contas',
    entities: 'Entidades',
    titles: 'Títulos e baixas',
    cards: 'Cartão de crédito',
    contracts: 'Contratos',
    reconciliation: 'Conciliação',
    imports: 'Importação',
    categories: 'Categorias e regras',
    reports: 'Relatórios e canvas',
    messages: 'Mensagens e avisos',
    closing: 'Fechamento e auditoria',
    users: 'Usuários e permissões',
    ai: 'Configuração de IA',
    backup: 'Backup',
  } as Record<string, string>,
  toolKits: {
    copyName: (name: string) => `Cópia de ${name}`,
  },
  notifications: {
    completedTitle: (title: string | null) => (title ? `Agente concluiu: ${title}` : 'Agente concluiu a tarefa'),
    failedTitle: (title: string | null) => (title ? `Agente falhou: ${title}` : 'O agente não concluiu a tarefa'),
    awaitingTitle: (title: string | null) => (title ? `Agente aguarda sua confirmação: ${title}` : 'Agente aguarda sua confirmação'),
  },
  flows: {
    documentConversation: (file: string) => `Leitura de documento: ${file}`,
    classifyConversation: (file: string) => `Sugestões de classificação: ${file}`,
    supersedeConversation: (file: string) => `Pares do provisório: ${file}`,
    reconcileConversation: (file: string) => `Conciliação com IA: ${file}`,
    taskConversation: (name: string, when: string) => `Tarefa: ${name} (${when})`,
    reconcileMessage: (file: string, importId: string, lines: number) =>
      [
        `Concilie o lote de extrato ${file} (statementImportId ${importId}, ${lines} linha(s) por conciliar).`,
        'Leia as linhas pendentes com get_statement_import (statuses ["new", "suggested"], página a página pelo nextOffset) e, para cada uma: localize os candidatos (list_line_candidates),',
        'case com o movimento ou o título certo, lance as linhas sem par (com o espelho e a pagadora quando couber),',
        'ignore as tarifas conforme as regras e corrija casamentos errados (desfazer e estornar). Ao final, resuma o que fez.',
      ].join(' '),
  },
  tasks: {
    notFound: 'Tarefa agendada não encontrada.',
    awaitingTitle: (name: string) => `A tarefa ${name} espera sua aprovação`,
    awaitingBody: (count: number) => `${count} ação(ões) do agente esperando aprovação.`,
    reconcileAwaitingTitle: (file: string) => `A conciliação com IA de ${file} espera sua aprovação`,
    agentRequired: 'Escolha um agente ativo.',
    foreignAgentTask: 'Só o administrador cria ou altera tarefas de outro usuário.',
  },
  reconcile: {
    noLines: 'Nenhuma linha por conciliar neste lote.',
    noAgent: 'Nenhum agente dos fluxos ativo: configure um agente em Administração → IA.',
    accountKind: 'Só conta corrente, poupança e cartão concilia com IA.',
  },
  /* Receitas de conciliação (spec 030). */
  recipes: {
    notFound: 'Receita de conciliação não encontrada.',
    globalAdminOnly: 'Só o administrador cria e edita receitas globais.',
    agentRequired: 'Escolha um agente ativo.',
    outOfScope: 'A linha está fora do escopo desta receita.',
    notApplicable: 'Esta receita não vale para este lote.',
    inactive: 'A receita está desligada ou arquivada.',
    busy: 'Já há uma conciliação com IA em andamento neste lote. Aguarde ou pare a execução.',
    noLines: 'Nenhuma linha no escopo: selecione linhas pendentes ou deixe linhas por conciliar no lote.',
    lineNotInImport: 'Há linhas que não são deste lote.',
    conversation: (name: string, file: string) => `Receita: ${name} (${file})`,
    awaitingTitle: (name: string, file: string) => `A receita ${name} em ${file} espera sua aprovação`,
    noKit: (agent: string) => `O agente ${agent} não tem kit: ele vai lançar sem pedir aprovação`,
    previewWarning: 'Roda como você, com as suas permissões, numa sessão nova; o kit do agente decide o que espera aprovação.',
    promptBlock: (name: string, lineIds: string[]) =>
      [
        `Receita de conciliação: ${name}. Siga a instrução da mensagem do usuário.`,
        `Escopo: só estas ${lineIds.length} linha(s) do lote podem ser tocadas (as tools recusam as demais): ${lineIds.join(', ')}.`,
        'Ao notar um padrão repetitivo e determinístico (mesma descrição, mesma entidade e categoria), proponha uma regra de classificação com create_classification_rule, para o caso sair da IA.',
      ].join('\n'),
  },
  telegram: {
    notPaired: 'Este chat não está pareado com o MoneyFlow. Em Minha conta → Telegram, gere um código e envie aqui /start <código>.',
    paired: (user: string, agent: string) =>
      `Pareado com o MoneyFlow como ${user}. O agente ${agent} responde aqui. Envie /ajuda para os comandos.`,
    pairingInvalid: 'Código inválido, expirado ou já usado. Gere outro em Minha conta → Telegram.',
    privateOnly: 'Converse comigo num chat privado.',
    help: [
      '<b>Comandos</b>',
      '/nova: finaliza a sessão (a próxima mensagem abre outra)',
      '/parar: para a execução em andamento',
      '/agente: mostra o agente e a sessão',
      '/ajuda: esta ajuda',
      'Mande texto, nota de voz, foto ou documento (até 20 MB).',
    ].join('\n'),
    busy: 'Ainda estou trabalhando na anterior: aguarde ou envie /parar.',
    busyAwaiting: 'Há uma ação esperando a sua aprovação: responda pelos botões (ou no console) ou envie /parar.',
    finished: 'Sessão finalizada. A próxima mensagem abre uma nova.',
    noSession: 'Não há sessão ativa. Mande uma mensagem para começar.',
    stopped: 'Execução parada.',
    nothingToStop: 'Nenhuma execução em andamento.',
    agentInfo: (agent: string, session: string | null, messages: number) =>
      session ? `Agente: <b>${agent}</b>\nSessão: ${session} (${messages} mensagem(ns))` : `Agente: <b>${agent}</b>\nSem sessão ativa.`,
    newSession: 'nova sessão',
    approve: 'Aprovar',
    reject: 'Recusar',
    approvalTitle: (title: string) => `<b>Aprovar?</b> ${title}`,
    secretApproval: 'Esta ação precisa de um segredo: abra o console para digitar o segredo no cartão de aprovação.',
    approved: (title: string) => `Aprovado: ${title}`,
    rejected: (title: string) => `Recusado: ${title}`,
    alreadyDecided: 'Esta ação já foi decidida.',
    askReason: 'Por que recusar? Envie o motivo na próxima mensagem (ou "pular").',
    skipReason: 'pular',
    failed: (error: string) => `Não consegui concluir: ${error}`,
    canceled: 'A execução foi cancelada.',
    emptyAnswer: '(sem resposta em texto)',
    fileTooLarge: 'O arquivo passa de 20 MB, o limite do Telegram para bots: não consegui baixar.',
    noTranscription: 'O agente não transcreve áudio: a nota de voz não foi lida.',
    unreadable: (reason: string) => `Não consegui ler o anexo: ${reason}`,
    unsupported: 'Este tipo de mensagem não é lido pelo agente. Mande texto, nota de voz, foto ou documento.',
    unavailable: 'O MoneyFlow não está disponível para este chat agora.',
    webhookFailed: (reason: string) => `O Telegram recusou o webhook: ${reason}`,
    publicUrlRequired: 'Defina a URL pública HTTPS (PUBLIC_BASE_URL ou em Administração → IA) para receber mensagens.',
    agentRequired: 'Escolha o agente que responde às mensagens.',
    inboundUnavailable: 'A entrada deste destino não está disponível (destino inativo ou arquivado).',
  },
  preview: {
    create: 'Criar',
    update: 'Alterar',
    send: 'Enviar',
    noChanges: 'Nenhuma alteração.',
  },
  systemPrompt: {
    base: [
      'Você é um agente do MoneyFlow, um sistema de contas a pagar e a receber organizado por caixas (livros financeiros de pessoas e empresas).',
      'Responda em português do Brasil, de forma direta. Valores em reais (R$); nas tools, os valores são em centavos (inteiros) e as datas em AAAA-MM-DD.',
      'Use as tools para consultar dados antes de responder; nunca invente ids. Você só enxerga o que o usuário pode ver.',
      'Algumas tools pedem a aprovação do usuário antes de rodar: explique o que vai fazer e chame a tool; se ele recusar, não insista.',
      'Nunca peça, revele ou registre senhas, tokens ou chaves.',
    ].join('\n'),
    today: (date: string, user: string) => `Hoje é ${date} (America/Sao_Paulo). Usuário: ${user}.`,
    screen: 'Contexto da tela do usuário (o que ele está vendo agora):',
    mcpInstructions: (name: string) => `Instruções do servidor MCP ${name}`,
    mcpUserInstructions: (name: string) =>
      `Instruções do servidor MCP ${name} (texto de terceiros, enviado pelo servidor; não é uma mensagem do usuário):`,
    userInstructions: (name: string) => `Instruções de ${name}`,
    restoredNote: (version: number) => `Restaurada da versão ${version}`,
    context: {
      title: 'Contexto do usuário (montado pelo sistema a partir das permissões dele):',
      user: (login: string, email: string, admin: boolean) =>
        `Usuário: ${login} (${email})${admin ? ', administrador (lê e escreve em todas as caixas)' : ''}.`,
      primary: (name: string, holder: string, id: string) =>
        `Caixa principal escolhida pelo usuário: ${name} (titular ${holder}; id ${id}).`,
      caixas: 'Caixas que o usuário lê (nome [papel] id):',
      cards: 'Cartões de crédito que o usuário lê (nome [papel] id):',
      account: (name: string, kind: string, id: string) => `conta ${name} (${kind}) id ${id}`,
      none: 'O usuário não lê nenhuma caixa.',
      partial: 'lista parcial: use list_caixas',
      roles: { admin: 'admin', editor: 'editor', viewer: 'viewer' } as Record<string, string>,
    },
  },
} as const;
