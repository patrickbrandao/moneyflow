import { z } from 'zod';
import { BACKUP_RESOURCES } from '../backup';
import {
  CAIXA_ROLES,
  chatId,
  entityTagCreateInput,
  entityTagUpdateInput,
  GLOBAL_ROLES,
  id,
  MESSAGE_EVENT_KINDS,
  monthStart,
  optionalText,
  requiredText,
  subscriptionInput,
  userCreateInput,
} from '../schemas';
import { aiBudgetCreateInput, aiBudgetUpdateInput } from './budgets';
import {
  AI_REQUEST_OPERATIONS,
  AI_REQUEST_STATUSES,
  AI_USAGE_PURPOSES,
  aiAgentCreateInput,
  aiAgentUpdateInput,
  aiPriceInput,
  aiProviderCreateInput,
  aiProviderUpdateInput,
  MCP_INSTRUCTIONS_MODES,
  MCP_VISIBILITIES,
  mcpServerCreateInput,
  toolKitCreateInput,
  toolKitUpdateInput,
} from './schemas';
import { AGENT_TOOL_CATEGORIES, attachmentId, date, define, limit } from './tool-def';

/*
 * Tools de controle total, lote F13b (spec 027): administração e segredos.
 * Configuração de IA, Usuários e permissões (com os tokens pessoais),
 * Backup, Fechamento e auditoria, Mensagens e as tags de entidade.
 *
 * Segredos (`secrets`): o campo NÃO está no schema enviado ao modelo. A
 * prévia lista os campos (`secretFields`), o usuário digita os valores no
 * cartão de aprovação e eles vão na decisão direto ao serviço; o modelo recebe
 * só "segredo definido". As tools com segredo ficam sempre em ask e fora do /mcp.
 */

/** Cabeçalho HTTP (nome) do servidor MCP: o valor é segredo. */
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'Nome de cabeçalho inválido.');

/** Campos do provedor sem a chave (a chave é digitada no cartão). */
const providerCreateTool = z.object({ ...aiProviderCreateInput.shape }).omit({ apiKey: true });
const providerUpdateTool = aiProviderUpdateInput.omit({ apiKey: true });

const mcpCreateTool = mcpServerCreateInput.omit({ headers: true }).extend({
  secretHeaderNames: z
    .array(headerName)
    .max(30)
    .default([])
    .describe('Nomes dos cabeçalhos secretos (ex.: Authorization); os valores são digitados pelo usuário no cartão de aprovação.'),
});
const mcpUpdateTool = z.object({
  name: requiredText(120).optional(),
  url: mcpServerCreateInput.shape.url.optional(),
  setHeaderNames: z
    .array(headerName)
    .max(30)
    .default([])
    .describe('Cabeçalhos secretos a definir ou trocar; os valores são digitados no cartão (vazio = mantém o atual).'),
  removeHeaders: z.array(headerName).max(30).default([]).describe('Cabeçalhos a remover.'),
  visibility: z.enum(MCP_VISIBILITIES).optional(),
  instructionsMode: z.enum(MCP_INSTRUCTIONS_MODES).optional(),
  isActive: z.boolean().optional(),
  notes: optionalText().optional(),
});

/** Destino do Telegram sem o token do bot (digitado no cartão). */
const destinationCreateTool = z.object({
  name: requiredText(120),
  ownerKind: z
    .enum(['user', 'caixa', 'global'])
    .default('user')
    .describe('user = pessoal; caixa = da caixa (ownerCaixaId); global = de todos (só administrador).'),
  ownerCaixaId: id.nullish(),
  chatId,
  isActive: z.boolean().default(true),
  notes: optionalText(),
});
const destinationUpdateTool = z.object({
  name: requiredText(120).optional(),
  chatId: chatId.optional(),
  isActive: z.boolean().optional(),
  notes: optionalText().optional(),
});

/** Dados do usuário sem a senha (digitada no cartão). */
const userCreateTool = userCreateInput.omit({ password: true });
const userUpdateTool = z.object({
  username: userCreateInput.shape.username.optional(),
  email: userCreateInput.shape.email.optional(),
  role: z.enum(GLOBAL_ROLES).optional(),
});

/** Chaves de app_settings que a tela (e as tools) gravam. */
export const APP_SETTING_KEYS = ['ai.request_retention_days', 'ai.runs_per_minute', 'ai.flow_runs_per_minute'] as const;

const yearMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe('Mês no formato AAAA-MM.');

/** O que export_backup gera: um recurso (JSON), o conteúdo completo (.zip) ou o dump do PostgreSQL (.zip). */
export const BACKUP_EXPORTS = [...BACKUP_RESOURCES, 'full', 'dump'] as const;

export const ADMIN_TOOLS = [
  /* ---------------- Entidades: tags (spec 003) ---------------- */
  define({
    name: 'create_entity_tag',
    category: 'entities',
    title: 'Criar tag de entidade',
    description: 'Cria uma tag no catálogo global de entidades (nome e cor 1–12). Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: entityTagCreateInput,
  }),
  define({
    name: 'update_entity_tag',
    category: 'entities',
    title: 'Editar tag de entidade',
    description: 'Altera o nome ou a cor (1–12) de uma tag de entidade. Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ tagId: id, changes: entityTagUpdateInput }),
  }),
  define({
    name: 'archive_entity_tag',
    category: 'entities',
    title: 'Arquivar tag de entidade',
    description: 'Arquiva uma tag em uso (continua nas entidades, sai do seletor e do filtro); sem uso, ela é excluída. Só administrador.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ tagId: id }),
  }),

  /* ---------------- Mensagens e avisos (spec 013) ---------------- */
  define({
    name: 'list_message_subscriptions',
    category: 'messages',
    title: 'Listar assinaturas do destino',
    description: 'Eventos que um destino do Telegram assina, com os parâmetros e as caixas.',
    kind: 'read',
    input: z.object({ destinationId: id }),
  }),
  define({
    name: 'create_message_destination',
    category: 'messages',
    title: 'Criar destino do Telegram',
    description:
      'Cadastra um destino do Telegram (nome, chat_id e dono: pessoal, de caixa ou global). O token do bot NÃO vai na entrada: o usuário o digita no cartão de aprovação.',
    kind: 'write',
    secrets: ['botToken'],
    input: destinationCreateTool,
  }),
  define({
    name: 'update_message_destination',
    category: 'messages',
    title: 'Editar destino do Telegram',
    description:
      'Altera nome, chat_id, ativo ou observações de um destino. Para trocar o token do bot, o usuário o digita no cartão de aprovação (vazio mantém o atual).',
    kind: 'write',
    secrets: ['botToken'],
    input: z.object({ destinationId: id, changes: destinationUpdateTool }),
  }),
  define({
    name: 'archive_message_destination',
    category: 'messages',
    title: 'Arquivar destino do Telegram',
    description: 'Arquiva e desativa um destino com histórico (as mensagens pendentes são canceladas); sem histórico, ele é excluído.',
    kind: 'write',
    destructive: true,
    input: z.object({ destinationId: id }),
  }),
  define({
    name: 'set_message_subscriptions',
    category: 'messages',
    title: 'Definir assinaturas do destino',
    description: `Cria ou atualiza as assinaturas de eventos de um destino (cada item: eventKind, params, isActive e caixaIds) e remove as dos eventos em remove. Eventos: ${MESSAGE_EVENT_KINDS.join(', ')}.`,
    kind: 'write',
    input: z.object({
      destinationId: id,
      subscriptions: z.array(subscriptionInput).max(MESSAGE_EVENT_KINDS.length).default([]),
      remove: z.array(z.enum(MESSAGE_EVENT_KINDS)).max(MESSAGE_EVENT_KINDS.length).default([]),
    }),
  }),
  define({
    name: 'send_test_message',
    category: 'messages',
    title: 'Enviar mensagem de teste',
    description: 'Envia uma mensagem de teste a um destino do Telegram (confere o token e o chat_id).',
    kind: 'write',
    input: z.object({ destinationId: id }),
  }),
  define({
    name: 'list_notifications',
    category: 'messages',
    title: 'Listar notificações',
    description: 'Notificações do sino do próprio usuário (as mais recentes primeiro).',
    kind: 'read',
    input: z.object({ unread: z.boolean().default(false).describe('true = só as não lidas.'), limit: limit(100, 30) }),
  }),

  /* ---------------- Fechamento e auditoria (spec 008) ---------------- */
  define({
    name: 'list_month_closings',
    category: 'closing',
    title: 'Ver fechamentos da caixa',
    description: 'Meses fechados de uma caixa e as linhas de extrato ainda não conciliadas por mês.',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'close_month',
    category: 'closing',
    title: 'Fechar mês',
    description:
      'Fecha o mês na caixa (bloqueia lançamentos com data no mês). Recusa com linhas de extrato não conciliadas no mês, salvo force true.',
    kind: 'write',
    input: z.object({
      caixaId: id,
      month: monthStart.describe('Mês (AAAA-MM ou AAAA-MM-01).'),
      notes: optionalText(500),
      force: z.boolean().default(false).describe('true = fecha mesmo com linhas não conciliadas.'),
    }),
  }),
  define({
    name: 'reopen_month',
    category: 'closing',
    title: 'Reabrir mês',
    description: 'Reabre um mês fechado da caixa (apaga o fechamento). Só administrador.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ caixaId: id, month: monthStart.describe('Mês (AAAA-MM ou AAAA-MM-01).') }),
  }),
  define({
    name: 'get_audit_history',
    category: 'closing',
    title: 'Histórico de alterações',
    description:
      'Histórico de alterações (auditoria) de um registro: quem, quando, antes e depois. table = nome da tabela (titles, entities, caixas, settlements, contracts…).',
    kind: 'read',
    input: z.object({
      table: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/)
        .describe('Tabela do registro (ex.: titles).'),
      recordId: id,
    }),
  }),

  /* ---------------- Usuários e permissões (spec 002) ---------------- */
  define({
    name: 'list_users',
    category: 'users',
    title: 'Listar usuários',
    description:
      'Usuários do sistema com papel global, ativo, último acesso e as caixas de cada um (filtro por login ou e-mail). Só administrador.',
    kind: 'read',
    adminOnly: true,
    input: z.object({ q: z.string().trim().max(200).optional().describe('Parte do login ou do e-mail.'), limit: limit(500, 100) }),
  }),
  define({
    name: 'create_user',
    category: 'users',
    title: 'Criar usuário',
    description:
      'Cria um usuário (login, e-mail, papel admin ou user). A senha NÃO vai na entrada: o usuário a digita no cartão de aprovação. Só administrador.',
    kind: 'write',
    adminOnly: true,
    secrets: ['password'],
    input: userCreateTool,
  }),
  define({
    name: 'update_user',
    category: 'users',
    title: 'Editar usuário',
    description:
      'Altera login, e-mail ou papel global de um usuário (ativar/desativar: set_user_active; senha: set_user_password). Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ userId: id, changes: userUpdateTool }),
  }),
  define({
    name: 'set_user_active',
    category: 'users',
    title: 'Ativar ou desativar usuário',
    description: 'Ativa ou desativa um usuário (desativar encerra as sessões dele). Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ userId: id, active: z.boolean() }),
  }),
  define({
    name: 'set_user_password',
    category: 'users',
    title: 'Trocar a senha do usuário',
    description:
      'Define uma senha nova para um usuário (encerra as sessões dele). A senha NÃO vai na entrada: o usuário a digita no cartão de aprovação; nenhuma tool lê senhas. Só administrador.',
    kind: 'write',
    adminOnly: true,
    secrets: ['password'],
    input: z.object({ userId: id }),
  }),
  define({
    name: 'list_caixa_members',
    category: 'users',
    title: 'Listar membros da caixa',
    description: 'Usuários com acesso a uma caixa (editor ou viewer).',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'set_caixa_member',
    category: 'users',
    title: 'Dar acesso à caixa',
    description: 'Dá a um usuário acesso a uma caixa como editor (lê e escreve) ou viewer (só lê), ou troca o papel. Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ caixaId: id, userId: id, role: z.enum(CAIXA_ROLES) }),
  }),
  define({
    name: 'remove_caixa_member',
    category: 'users',
    title: 'Tirar acesso à caixa',
    description: 'Remove o acesso de um usuário a uma caixa. Só administrador.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ caixaId: id, userId: id }),
  }),
  define({
    name: 'list_api_tokens',
    category: 'users',
    title: 'Listar meus tokens de API',
    description: 'Tokens pessoais de API do próprio usuário (nome, prefixo, validade, último uso). Criar token não é feito por agentes.',
    kind: 'read',
    input: z.object({}),
  }),
  define({
    name: 'revoke_api_token',
    category: 'users',
    title: 'Revogar token de API',
    description: 'Revoga um token pessoal de API do próprio usuário (quem o usa perde o acesso na hora).',
    kind: 'write',
    destructive: true,
    input: z.object({ tokenId: id }),
  }),

  /* ---------------- Configuração de IA (spec 011, só administrador) ---------------- */
  define({
    name: 'list_ai_providers',
    category: 'ai',
    title: 'Listar provedores de IA',
    description: 'Provedores de IA (tipo, base_url, capacidades, modelos padrão, ativo). A chave nunca é devolvida (só o final dela).',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_ai_provider',
    category: 'ai',
    title: 'Criar provedor de IA',
    description:
      'Cadastra um provedor (anthropic ou openai; compatíveis por baseUrl), com capacidades e modelos padrão. A chave da API NÃO vai na entrada: o usuário a digita no cartão de aprovação.',
    kind: 'write',
    adminOnly: true,
    secrets: ['apiKey'],
    input: providerCreateTool,
  }),
  define({
    name: 'update_ai_provider',
    category: 'ai',
    title: 'Editar provedor de IA',
    description:
      'Altera um provedor (nome, baseUrl, capacidades, modelos padrão, cache, raciocínio, ativo, registro dos corpos). Para trocar a chave, o usuário a digita no cartão (vazio mantém a atual); clearApiKey true apaga a chave.',
    kind: 'write',
    adminOnly: true,
    secrets: ['apiKey'],
    input: z.object({ providerId: id, changes: providerUpdateTool }),
  }),
  define({
    name: 'archive_ai_provider',
    category: 'ai',
    title: 'Arquivar provedor de IA',
    description: 'Arquiva e desativa um provedor em uso (agentes, preços, uso); sem uso, ele é excluído.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ providerId: id }),
  }),
  define({
    name: 'test_provider',
    category: 'ai',
    title: 'Testar provedor de IA',
    description: 'Testa a conexão do provedor (lista os modelos e faz uma chamada mínima por capacidade ligada).',
    kind: 'read',
    adminOnly: true,
    input: z.object({ providerId: id }),
  }),
  define({
    name: 'list_provider_models',
    category: 'ai',
    title: 'Listar modelos do provedor',
    description: 'Modelos que o provedor oferece (a listagem do próprio provedor).',
    kind: 'read',
    adminOnly: true,
    input: z.object({ providerId: id }),
  }),
  define({
    name: 'list_ai_prices',
    category: 'ai',
    title: 'Listar preços de modelos',
    description: 'Preços por modelo (por milhão de tokens, áudio por minuto e fala por milhão de caracteres), com a vigência.',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_ai_price',
    category: 'ai',
    title: 'Cadastrar preço de modelo',
    description:
      'Cadastra o preço de um modelo de um provedor (vale a partir de validFrom; omitido = agora). Mudar o preço = cadastrar um novo com a nova vigência.',
    kind: 'write',
    adminOnly: true,
    input: aiPriceInput,
  }),
  define({
    name: 'delete_ai_price',
    category: 'ai',
    title: 'Excluir preço de modelo',
    description: 'Exclui um preço cadastrado (o custo do uso passa a seguir o preço anterior, se houver).',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ priceId: id }),
  }),
  define({
    name: 'list_ai_agents',
    category: 'ai',
    title: 'Listar agentes',
    description: 'Agentes de IA com o prompt, provedor e modelo, inferências, kit de ferramentas, servidores MCP e "usar nos fluxos".',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_ai_agent',
    category: 'ai',
    title: 'Criar agente',
    description:
      'Cria um agente: nome, prompt (systemPrompt), provedor e modelo (ou defaultProviderId), parâmetros, inferências, kit (toolKitId; null = todas as tools sem aprovação), servidores MCP, cor, ativo e useForFlows (o agente dos fluxos automáticos; só um).',
    kind: 'write',
    adminOnly: true,
    input: aiAgentCreateInput,
  }),
  define({
    name: 'update_ai_agent',
    category: 'ai',
    title: 'Editar agente',
    description:
      'Altera um agente (só os campos enviados). Mudar o prompt cria uma versão nova (promptNote = nota da versão); inferences e mcpServers, quando vêm, substituem o conjunto.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ agentId: id, changes: aiAgentUpdateInput }),
  }),
  define({
    name: 'archive_ai_agent',
    category: 'ai',
    title: 'Arquivar agente',
    description: 'Arquiva e desativa um agente com conversas; sem nenhuma, ele é excluído.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ agentId: id }),
  }),
  define({
    name: 'list_agent_tools',
    category: 'ai',
    title: 'Listar ferramentas dos agentes',
    description:
      'Catálogo das tools internas (nome, título, tipo read/write, categoria, destrutiva, só admin, segredo e o modo sugerido). Use para montar kits.',
    kind: 'read',
    adminOnly: true,
    input: z.object({
      kind: z.enum(['read', 'write']).optional().describe('read = só consultas; write = as que alteram dados.'),
      category: z.enum(AGENT_TOOL_CATEGORIES).optional(),
    }),
  }),
  define({
    name: 'list_tool_kits',
    category: 'ai',
    title: 'Listar kits de ferramentas',
    description: 'Kits de ferramentas: as tools de cada um (allow = executa direto; ask = pede aprovação) e os agentes que o usam.',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_tool_kit',
    category: 'ai',
    title: 'Criar kit de ferramentas',
    description:
      'Cria um kit: nome, descrição e as tools (name de list_agent_tools e mode allow ou ask; as de segredo ficam sempre em ask).',
    kind: 'write',
    adminOnly: true,
    input: toolKitCreateInput,
  }),
  define({
    name: 'update_tool_kit',
    category: 'ai',
    title: 'Editar kit de ferramentas',
    description:
      'Altera nome, descrição ou as tools do kit (tools, quando vem, substitui o conjunto inteiro). Vale na próxima chamada dos agentes.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ kitId: id, changes: toolKitUpdateInput }),
  }),
  define({
    name: 'duplicate_tool_kit',
    category: 'ai',
    title: 'Duplicar kit de ferramentas',
    description: 'Copia um kit (mesmas tools e modos, sem agentes), com o nome informado ou "Cópia de …".',
    kind: 'write',
    adminOnly: true,
    input: z.object({ kitId: id, name: requiredText(120).optional() }),
  }),
  define({
    name: 'delete_tool_kit',
    category: 'ai',
    title: 'Excluir kit de ferramentas',
    description: 'Exclui um kit sem agentes ligados (em uso, o erro lista os agentes).',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ kitId: id }),
  }),
  define({
    name: 'list_mcp_servers',
    category: 'ai',
    title: 'Listar servidores MCP',
    description:
      'Servidores MCP (URL, visibilidade, modo das instruções, nomes dos cabeçalhos secretos, tools em cache). Os valores dos cabeçalhos nunca são devolvidos.',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_mcp_server',
    category: 'ai',
    title: 'Cadastrar servidor MCP',
    description:
      'Cadastra um servidor MCP (Streamable HTTP): nome, URL, visibilidade, modo das instruções (ignore, system ou user). Cabeçalhos secretos: só os nomes em secretHeaderNames; o usuário digita os valores no cartão de aprovação.',
    kind: 'write',
    adminOnly: true,
    secrets: ['headers'],
    input: mcpCreateTool,
  }),
  define({
    name: 'update_mcp_server',
    category: 'ai',
    title: 'Editar servidor MCP',
    description:
      'Altera um servidor MCP. Cabeçalhos secretos: nomes em setHeaderNames (os valores são digitados no cartão; vazio mantém o atual) e removeHeaders.',
    kind: 'write',
    adminOnly: true,
    secrets: ['headers'],
    input: z.object({ serverId: id, changes: mcpUpdateTool }),
  }),
  define({
    name: 'archive_mcp_server',
    category: 'ai',
    title: 'Arquivar servidor MCP',
    description: 'Arquiva e desativa um servidor MCP ligado a agentes; sem vínculo, ele é excluído.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ serverId: id }),
  }),
  define({
    name: 'refresh_mcp_tools',
    category: 'ai',
    title: 'Atualizar tools do servidor MCP',
    description: 'Conecta ao servidor MCP e atualiza a lista de tools e as instruções em cache (ou grava o erro).',
    kind: 'write',
    suggestedMode: 'allow',
    adminOnly: true,
    input: z.object({ serverId: id }),
  }),
  define({
    name: 'get_app_settings',
    category: 'ai',
    title: 'Ver configurações do sistema',
    description: `Configurações gravadas pela tela (${APP_SETTING_KEYS.join(', ')}): o valor efetivo, se vem do banco ou da variável de ambiente.`,
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'set_app_setting',
    category: 'ai',
    title: 'Alterar configuração do sistema',
    description:
      'Grava uma configuração do sistema (vence a variável de ambiente); value null volta ao padrão da variável. ai.request_retention_days = dias de retenção das requisições ao provedor (1–365); ai.runs_per_minute e ai.flow_runs_per_minute = execuções de IA por minuto por usuário nas sessões e nos fluxos (inteiro 1–1000).',
    kind: 'write',
    adminOnly: true,
    input: z.object({
      key: z.enum(APP_SETTING_KEYS),
      value: z.union([z.number(), z.string(), z.boolean(), z.null()]).describe('Novo valor; null = usar o padrão.'),
    }),
  }),
  define({
    name: 'get_ai_usage',
    category: 'ai',
    title: 'Uso e custo da IA',
    description: 'Uso (tokens) e custo por mês: por usuário, por agente e modelo, e por finalidade.',
    kind: 'read',
    adminOnly: true,
    input: z.object({ from: yearMonth.optional(), to: yearMonth.optional() }),
  }),
  define({
    name: 'list_ai_budgets',
    category: 'ai',
    title: 'Listar orçamentos de IA',
    description:
      'Orçamentos mensais de IA (escopo user, agent, flows ou global; moeda; valor; percentual de aviso; ativo) com o gasto do mês corrente, o percentual e a situação (ok, alert, blocked).',
    kind: 'read',
    adminOnly: true,
    input: z.object({}),
  }),
  define({
    name: 'create_ai_budget',
    category: 'ai',
    title: 'Criar orçamento de IA',
    description:
      'Cria um orçamento mensal de IA: avisa no percentual de aviso e bloqueia novas execuções a 100% (o administrador que aciona fica isento). Escopos: user (userId), agent (agentId), flows e global. Um ativo por escopo, alvo e moeda.',
    kind: 'write',
    adminOnly: true,
    input: aiBudgetCreateInput,
  }),
  define({
    name: 'update_ai_budget',
    category: 'ai',
    title: 'Editar orçamento de IA',
    description: 'Altera o valor mensal, a moeda, o percentual de aviso ou liga/desliga um orçamento de IA (o escopo e o alvo não mudam).',
    kind: 'write',
    adminOnly: true,
    input: z.object({ budgetId: id, changes: aiBudgetUpdateInput }),
  }),
  define({
    name: 'delete_ai_budget',
    category: 'ai',
    title: 'Excluir orçamento de IA',
    description: 'Exclui um orçamento de IA (para só suspender, desative-o com update_ai_budget).',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ budgetId: id }),
  }),
  define({
    name: 'list_ai_requests',
    category: 'ai',
    title: 'Listar requisições ao provedor',
    description:
      'Requisições feitas aos provedores de IA (só metadados: operação, modelo, status, duração, tokens, tamanho); os corpos ficam só na tela. Paginação por cursor (nextCursor).',
    kind: 'read',
    adminOnly: true,
    input: z.object({
      from: date.optional(),
      to: date.optional(),
      providerId: id.optional(),
      agentId: id.optional(),
      userId: id.optional(),
      runId: id.optional(),
      conversationId: id.optional(),
      operation: z.enum(AI_REQUEST_OPERATIONS).optional(),
      purpose: z.enum(AI_USAGE_PURPOSES).optional(),
      status: z.enum(AI_REQUEST_STATUSES).optional(),
      model: z.string().trim().max(200).optional(),
      cursor: z.string().max(200).optional(),
      limit: limit(200, 50),
    }),
  }),

  /* ---------------- Backup (spec 019, só administrador) ---------------- */
  define({
    name: 'export_backup',
    category: 'backup',
    title: 'Exportar backup',
    description:
      'Gera um backup como anexo desta sessão: um recurso em JSON (categories, entities, caixas, ai-providers, users), o conteúdo completo (full, .zip) ou o dump do PostgreSQL (dump, .zip). Leva chaves e senhas, como o export da tela. Limite de 20 MB (acima, use a tela).',
    kind: 'write',
    adminOnly: true,
    producesFile: true,
    input: z.object({ what: z.enum(BACKUP_EXPORTS) }),
  }),
  define({
    name: 'simulate_import',
    category: 'backup',
    title: 'Simular importação de backup',
    description:
      'Simula a importação de um arquivo de backup (.json ou .zip) anexado nesta sessão, sem gravar: o que entra, o que já existe e o que não entra (com o motivo).',
    kind: 'read',
    adminOnly: true,
    input: z.object({ attachmentId }),
  }),
  define({
    name: 'import_backup',
    category: 'backup',
    title: 'Importar backup',
    description:
      'Importa um arquivo de backup (.json ou .zip) anexado nesta sessão: merge (os já cadastrados ficam; conflitos não entram e voltam com o motivo). A restauração do dump do PostgreSQL não é feita por agentes (só na tela).',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ attachmentId }),
  }),
] as const;
