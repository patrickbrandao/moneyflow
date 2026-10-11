/* Agentes de IA (spec 011): textos usados pela API, pelo worker e pelas tools. */
export const agentsStrings = {
  errors: {
    agentNotFound: 'Agente não encontrado.',
    agentInactive: 'Este agente está desativado.',
    agentNotReady: 'Para ativar o agente, escolha o provedor e o modelo.',
    runActive: 'Já há uma execução em andamento nesta conversa. Aguarde ou pare a execução.',
    runNotActive: 'Esta execução já terminou.',
    readOnly: 'Você está lendo a conversa de outro usuário (somente leitura).',
    providerInactive: 'O provedor de IA deste agente está desativado.',
    providerMissing: 'Nenhum agente de IA ativo está configurado. Peça ao administrador para configurar um provedor e um agente.',
    providerError: (message: string) => `O provedor de IA respondeu com erro: ${message}`,
    toolUnknown: (name: string) => `Tool desconhecida ou não habilitada: ${name}`,
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
  },
  notifications: {
    completedTitle: (title: string | null) => (title ? `Agente concluiu: ${title}` : 'Agente concluiu a tarefa'),
    failedTitle: (title: string | null) => (title ? `Agente falhou: ${title}` : 'O agente não concluiu a tarefa'),
    awaitingTitle: (title: string | null) => (title ? `Agente aguarda sua confirmação: ${title}` : 'Agente aguarda sua confirmação'),
  },
  flows: {
    documentConversation: (file: string) => `Leitura de documento: ${file}`,
    classifyConversation: (file: string) => `Sugestões de classificação: ${file}`,
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
      'Tools de escrita podem pedir a confirmação do usuário: explique o que vai fazer e chame a tool; se ele recusar, não insista.',
      'Nunca peça, revele ou registre senhas, tokens ou chaves.',
    ].join('\n'),
    today: (date: string, user: string) => `Hoje é ${date} (America/Sao_Paulo). Usuário: ${user}.`,
    screen: 'Contexto da tela do usuário (o que ele está vendo agora):',
  },
} as const;
