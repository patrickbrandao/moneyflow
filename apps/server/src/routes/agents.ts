import {
  agentSessionStartInput,
  agentSessionsQuery,
  agentThreadsQuery,
  aiAgentCreateInput,
  aiAgentUpdateInput,
  aiPriceInput,
  aiProviderCreateInput,
  aiProviderUpdateInput,
  aiRequestBodyQuery,
  aiRequestListQuery,
  aiUsageQuery,
  apiTokenCreateInput,
  appSettingInput,
  confirmationDecisionInput,
  conversationCreateInput,
  conversationForkInput,
  conversationListQuery,
  conversationUpdateInput,
  formatSse,
  mcpServerCreateInput,
  mcpServerUpdateInput,
  messageSendInput,
  promptPreviewInput,
  suggestionDecisionInput,
  toolKitCreateInput,
  toolKitDuplicateInput,
  toolKitUpdateInput,
  userAiSettingsInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import type { RunEventsHub } from '../agents/events-hub';
import { AppError } from '../errors';
import { param, parse, type Req } from '../http';
import * as admin from '../services/ai-admin';
import { suggestImportClassifications } from '../services/ai-flows';
import * as requests from '../services/ai-requests';
import * as aiSettings from '../services/ai-settings';
import * as tokens from '../services/api-tokens';
import * as chatMedia from '../services/chat-media';
import * as conversations from '../services/conversations';
import { decideSuggestions } from '../services/reconciliation';
import { contentDisposition, UPLOAD_BODY_LIMIT } from './attachments';

declare module 'fastify' {
  interface FastifyInstance {
    runEvents: RunEventsHub;
  }
}

const FINAL = new Set(['completed', 'failed', 'canceled']);

/** Chave de configuração na URL (`area.nome`); a lista das conhecidas fica no serviço (404 nas demais). */
const settingKey = (r: Req) => {
  const key = String((r.params as Record<string, string>).key ?? '');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(key)) throw new AppError(404, 'not_found', 'Configuração não encontrada.');
  return key;
};

/* Agentes de IA (spec 011): conversas, execuções (SSE), administração, tokens e a IA nos fluxos. */
export async function agentRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  /* ---------------- sessões por agente (spec 026) ---------------- */
  app.get('/api/agents', (r: Req) => conversations.listAgentOptions(r.ctx));
  app.get('/api/agents/threads', (r: Req) => conversations.listThreads(r.ctx, parse(agentThreadsQuery, r.query)));
  app.get('/api/agents/:agentId/thread', (r: Req) => conversations.getThread(r.ctx, param(r, 'agentId')));
  app.get('/api/agents/:agentId/sessions', (r: Req) =>
    conversations.listSessions(r.ctx, param(r, 'agentId'), parse(agentSessionsQuery, r.query)),
  );
  app.post('/api/agents/:agentId/sessions', (r: Req) =>
    conversations.startSession(r.ctx, param(r, 'agentId'), parse(agentSessionStartInput, r.body ?? {}).screenContext ?? null),
  );
  app.post('/api/agents/:agentId/messages', (r: Req) =>
    conversations.sendToAgent(r.ctx, param(r, 'agentId'), parse(messageSendInput, r.body)),
  );
  app.post('/api/conversations/:id/finish', (r: Req) => conversations.finishSession(r.ctx, id(r)));

  /* ---------------- conversas (sessões, por id) ---------------- */
  app.get('/api/conversations', (r: Req) => conversations.listConversations(r.ctx, parse(conversationListQuery, r.query)));
  app.post('/api/conversations', (r: Req) => conversations.createConversation(r.ctx, parse(conversationCreateInput, r.body)));
  app.get('/api/conversations/:id', (r: Req) => conversations.getConversation(r.ctx, id(r)));
  app.patch('/api/conversations/:id', (r: Req) => conversations.updateConversation(r.ctx, id(r), parse(conversationUpdateInput, r.body)));
  app.delete('/api/conversations/:id', (r: Req) => conversations.deleteConversation(r.ctx, id(r)));
  app.post('/api/conversations/:id/fork', (r: Req) => conversations.forkConversation(r.ctx, id(r), parse(conversationForkInput, r.body)));
  // Upload do chat (spec 025): o arquivo cru no corpo; fileName e, no áudio, durationMs (do navegador) na query.
  app.post('/api/conversations/:id/attachments', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, (r: Req) =>
    chatMedia.uploadChatAttachment(r.ctx, id(r), {
      name: String(r.query.fileName ?? 'arquivo'),
      mime: r.headers['content-type'] ?? '',
      content: r.body,
      durationMs: r.query.durationMs,
    }),
  );
  app.post('/api/conversations/:id/messages', (r: Req) => conversations.sendMessage(r.ctx, id(r), parse(messageSendInput, r.body)));
  // Modo áudio (spec 025): gera (ou devolve o já gerado) o áudio da mensagem.
  app.post('/api/conversations/:id/messages/:messageId/speech', (r: Req) => chatMedia.messageSpeech(r.ctx, id(r), param(r, 'messageId')));
  // Derivados de um anexo (transcrição, descrição) e o "tentar de novo" da transcrição.
  app.get('/api/attachments/:id/derivatives', (r: Req) => chatMedia.listDerivatives(r.ctx, id(r)));
  app.post('/api/attachments/:id/transcribe', (r: Req) => chatMedia.retryTranscription(r.ctx, id(r)));

  /* ---------------- execuções ---------------- */
  app.get('/api/runs/:id', (r: Req) => conversations.getRun(r.ctx, id(r)));
  app.post('/api/runs/:id/cancel', (r: Req) => conversations.cancelRun(r.ctx, id(r)));
  app.post('/api/runs/:id/confirmations', (r: Req) =>
    conversations.decideConfirmations(r.ctx, id(r), parse(confirmationDecisionInput, r.body)),
  );

  // SSE: tudo depois de Last-Event-ID (ou ?after), depois ao vivo pelo LISTEN; fecha no "done".
  app.get('/api/runs/:id/events', async (r: Req, reply) => {
    const runId = id(r);
    const run = await conversations.getRun(r.ctx, runId);
    const header = r.headers['last-event-id'];
    let last = Number(Array.isArray(header) ? header[0] : (header ?? r.query.after ?? 0)) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': conectado\n\n');

    let closed = false;
    let running = false;
    let again = false;
    let unsubscribe: () => void = () => {};
    let ping: NodeJS.Timeout | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (ping) clearInterval(ping);
      res.end();
    };
    const pump = async () => {
      if (closed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        // Repete enquanto chegarem avisos durante a leitura (nenhum NOTIFY se perde).
        do {
          again = false;
          const events = await conversations.runEvents(app.db, runId, last);
          for (const event of events) {
            res.write(formatSse({ id: event.seq, event: event.type, data: { type: event.type, ...event.payload } }));
            last = event.seq;
            if (event.type === 'done') {
              close();
              return;
            }
          }
          if (events.length === 500) {
            again = true;
            continue;
          }
          // Execução já terminada sem o "done" (eventos expurgados): encerra com o estado final.
          const current = await conversations.getRun(r.ctx, runId);
          if (FINAL.has(current.status) && !again) {
            const tail = await conversations.runEvents(app.db, runId, last);
            if (tail.length > 0) {
              again = true;
              continue;
            }
            res.write(formatSse({ event: 'done', data: { type: 'done', status: current.status, error: current.error } }));
            close();
            return;
          }
        } while (again && !closed);
      } catch (error) {
        r.log.warn({ err: error, runId }, 'sse: falha ao ler eventos');
        close();
      } finally {
        running = false;
      }
    };
    unsubscribe = app.runEvents.subscribe(runId, () => void pump());
    // Ping a cada 15 s e, por segurança (conexão de LISTEN caindo), uma releitura a cada 5 s.
    let ticks = 0;
    ping = setInterval(() => {
      if (closed) return;
      ticks += 1;
      if (ticks % 3 === 0) res.write(': ping\n\n');
      void pump();
    }, 5_000);
    r.raw.on('close', close);
    void run;
    await pump();
  });

  /* ---------------- Minha conta → IA (spec 022) ---------------- */
  app.get('/api/account/ai', (r: Req) => aiSettings.getMyAiSettings(r.ctx));
  app.put('/api/account/ai', (r: Req) => aiSettings.putMyAiSettings(r.ctx, parse(userAiSettingsInput, r.body)));
  app.get('/api/users/:id/ai', (r: Req) => aiSettings.getUserAiSettings(r.ctx, id(r)));

  /* ---------------- tokens pessoais ---------------- */
  app.get('/api/account/api-tokens', (r: Req) => tokens.listApiTokens(r.ctx));
  app.post('/api/account/api-tokens', (r: Req) => tokens.createApiToken(r.ctx, parse(apiTokenCreateInput, r.body)));
  app.delete('/api/account/api-tokens/:id', (r: Req) => tokens.revokeApiToken(r.ctx, id(r)));

  /* ---------------- IA na conciliação ---------------- */
  app.post('/api/statement-imports/:id/ai-suggest', (r: Req) => suggestImportClassifications(r.ctx, id(r)));
  app.post('/api/statement-lines/suggestions', (r: Req) => {
    const input = parse(suggestionDecisionInput, r.body);
    return decideSuggestions(r.ctx, input.lineIds, input.decision);
  });

  /* ---------------- administração ---------------- */
  app.get('/api/admin/ai/providers', (r: Req) => admin.listProviders(r.ctx));
  app.post('/api/admin/ai/providers', (r: Req) => admin.createProvider(r.ctx, parse(aiProviderCreateInput, r.body)));
  app.patch('/api/admin/ai/providers/:id', (r: Req) => admin.updateProvider(r.ctx, id(r), parse(aiProviderUpdateInput, r.body)));
  app.delete('/api/admin/ai/providers/:id', (r: Req) => admin.deleteProvider(r.ctx, id(r)));
  app.post('/api/admin/ai/providers/:id/test', (r: Req) => admin.testProvider(r.ctx, id(r)));
  app.get('/api/admin/ai/prices', (r: Req) => admin.listPrices(r.ctx));
  app.post('/api/admin/ai/prices', (r: Req) => admin.createPrice(r.ctx, parse(aiPriceInput, r.body)));
  app.delete('/api/admin/ai/prices/:id', (r: Req) => admin.deletePrice(r.ctx, id(r)));
  app.get('/api/admin/ai/tools', async (r: Req) => admin.listToolCatalog(r.ctx));
  app.get('/api/admin/ai/tool-kits', (r: Req) => admin.listToolKits(r.ctx));
  app.post('/api/admin/ai/tool-kits', (r: Req) => admin.createToolKit(r.ctx, parse(toolKitCreateInput, r.body)));
  app.get('/api/admin/ai/tool-kits/:id', (r: Req) => admin.getToolKit(r.ctx, id(r)));
  app.patch('/api/admin/ai/tool-kits/:id', (r: Req) => admin.updateToolKit(r.ctx, id(r), parse(toolKitUpdateInput, r.body)));
  app.delete('/api/admin/ai/tool-kits/:id', (r: Req) => admin.deleteToolKit(r.ctx, id(r)));
  app.post('/api/admin/ai/tool-kits/:id/duplicate', (r: Req) =>
    admin.duplicateToolKit(r.ctx, id(r), parse(toolKitDuplicateInput, r.body ?? {})),
  );
  app.get('/api/admin/ai/agents', (r: Req) => admin.listAgents(r.ctx));
  app.post('/api/admin/ai/agents', (r: Req) => admin.createAgent(r.ctx, parse(aiAgentCreateInput, r.body)));
  app.patch('/api/admin/ai/agents/:id', (r: Req) => admin.updateAgent(r.ctx, id(r), parse(aiAgentUpdateInput, r.body)));
  app.delete('/api/admin/ai/agents/:id', (r: Req) => admin.deleteAgent(r.ctx, id(r)));
  app.get('/api/admin/ai/agents/:id/prompt-versions', (r: Req) => admin.listPromptVersions(r.ctx, id(r)));
  app.post('/api/admin/ai/agents/:id/prompt-versions/:versionId/restore', (r: Req) =>
    admin.restorePromptVersion(r.ctx, id(r), param(r, 'versionId')),
  );
  app.post('/api/admin/ai/agents/:id/prompt-preview', (r: Req) =>
    admin.previewPrompt(r.ctx, id(r), parse(promptPreviewInput, r.body).userId),
  );
  app.get('/api/admin/ai/mcp-servers', (r: Req) => admin.listMcpServers(r.ctx));
  app.post('/api/admin/ai/mcp-servers', (r: Req) => admin.createMcpServer(r.ctx, parse(mcpServerCreateInput, r.body)));
  app.patch('/api/admin/ai/mcp-servers/:id', (r: Req) => admin.updateMcpServer(r.ctx, id(r), parse(mcpServerUpdateInput, r.body)));
  app.delete('/api/admin/ai/mcp-servers/:id', (r: Req) => admin.deleteMcpServer(r.ctx, id(r)));
  app.post('/api/admin/ai/mcp-servers/:id/refresh', (r: Req) => admin.refreshMcpServer(r.ctx, id(r)));
  app.get('/api/admin/ai/usage', (r: Req) => admin.usageReport(r.ctx, parse(aiUsageQuery, r.query)));

  /* ---------------- requisições ao provedor e configurações (spec 023) ---------------- */
  app.get('/api/admin/ai/requests', (r: Req) => requests.listRequests(r.ctx, parse(aiRequestListQuery, r.query)));
  app.get('/api/admin/ai/requests/:id', (r: Req) => requests.getRequest(r.ctx, id(r)));
  app.get('/api/admin/ai/requests/:id/body', async (r: Req, reply) => {
    const file = await requests.requestBody(r.ctx, id(r), parse(aiRequestBodyQuery, r.query).part);
    reply
      .header('content-type', file.mime)
      .header('content-disposition', contentDisposition(file.fileName))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff');
    return reply.send(file.body);
  });
  app.get('/api/admin/ai/providers/:id/summary', (r: Req) => requests.providerSummary(r.ctx, id(r)));
  app.get('/api/admin/settings/:key', (r: Req) => requests.getSetting(r.ctx, settingKey(r)));
  app.put('/api/admin/settings/:key', (r: Req) => requests.putSetting(r.ctx, settingKey(r), parse(appSettingInput, r.body).value));
  app.delete('/api/admin/settings/:key', (r: Req) => requests.deleteSetting(r.ctx, settingKey(r)));
}
