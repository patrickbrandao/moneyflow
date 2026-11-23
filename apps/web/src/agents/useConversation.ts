import {
  type AgentOptionDto,
  type AgentSendResult,
  type AgentThreadView,
  type AiMessageDto,
  type AiRunDto,
  type AiRunEvent,
  type ChatAttachmentDto,
  type ConversationDetail,
  type ConversationDto,
  createLiveBuffer,
  type DecideResult,
  type ScreenContext,
  type SendMessageResult,
  type ToolConfirmationDto,
} from '@moneyflow/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { upload } from '../lib/upload';
import { useAgentActions, useAgentVersions } from './AgentsProvider';
import { isActiveStatus } from './format';
import { followRun } from './stream';

/*
 * Uma sessão aberta: o histórico mais o que chega ao vivo pelo SSE da execução
 * ativa (texto parcial, raciocínio, tools em andamento, confirmações, uso e
 * título). Ao terminar, recarrega o detalhe.
 *
 * Na janela do agente (spec 026) o alvo é o fio: GET /api/agents/:id/thread
 * traz a sessão ativa (ou nenhuma), a mensagem vai para o agente (a API cria a
 * sessão se preciso) e "Finalizar sessão" volta ao fio vazio. Na janela de
 * leitura o alvo é uma sessão fixa (GET /api/conversations/:id).
 */

export type PaneTarget =
  | { kind: 'agent'; agentId: string; windowId: string }
  | { kind: 'session'; conversationId: string; windowId: string };

/** O detalhe da tela: o de uma sessão, ou o fio ainda sem sessão ativa (conversation null). */
export type PaneDetail = Omit<ConversationDetail, 'conversation'> & { conversation: ConversationDto | null };

const emptyDetail = (media: ConversationDetail['media']): PaneDetail => ({
  conversation: null,
  messages: [],
  activeRun: null,
  confirmations: [],
  usage: [],
  readOnly: false,
  attachments: [],
  media,
});

export type LiveTool = { name: string; title?: string; status: 'running' | 'ok' | 'error'; summary?: string };

const bySeq = (a: AiMessageDto, b: AiMessageDto) => a.seq - b.seq;

/** Consulta da execução que espera aprovação (decidida em outra aba ou no Telegram). */
const AWAITING_POLL_MS = 10_000;

function upsertMessage(list: AiMessageDto[], message: AiMessageDto): AiMessageDto[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index === -1) return [...list, message].sort(bySeq);
  const next = [...list];
  next[index] = message;
  return next;
}

/** Junta confirmações sem "desdecidir": uma pendente reprisada não apaga uma decisão já conhecida. */
function mergeConfirmations(current: ToolConfirmationDto[], incoming: ToolConfirmationDto[]): ToolConfirmationDto[] {
  const map = new Map(current.map((c) => [c.id, c]));
  for (const c of incoming) {
    const known = map.get(c.id);
    if (known && known.status !== 'pending' && c.status === 'pending') continue;
    map.set(c.id, c);
  }
  return [...map.values()];
}

export function useConversation(target: PaneTarget) {
  // Só as ações e as versões (tarefa 120): a conversa não re-renderiza a cada clique ou arrasto nas janelas.
  const { updateMeta, bumpList, screenContext } = useAgentActions();
  const { sessionsVersion } = useAgentVersions();
  const [detail, setDetail] = useState<PaneDetail | null>(null);
  const [agent, setAgent] = useState<AgentOptionDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [run, setRun] = useState<AiRunDto | null>(null);
  // Texto e raciocínio ao vivo fora do estado (tarefa 120): um aviso por quadro, só para a bolha ao vivo.
  const [live] = useState(() =>
    createLiveBuffer(
      (flush) => requestAnimationFrame(flush),
      (handle) => cancelAnimationFrame(handle),
    ),
  );
  const [liveTools, setLiveTools] = useState<Record<string, LiveTool>>({});
  const [streamError, setStreamError] = useState<string | null>(null);
  /** Volta à fila por erro temporário do provedor (tarefa 151): aviso passageiro até a nova tentativa responder. */
  const [retrying, setRetryingState] = useState(false);
  // O valor atual fora do estado: os deltas desligam o aviso sem marcar um render a cada token (tarefa 120).
  const retryingNow = useRef(false);
  const setRetrying = useCallback((value: boolean) => {
    if (retryingNow.current === value) return;
    retryingNow.current = value;
    setRetryingState(value);
  }, []);
  const [reconnecting, setReconnecting] = useState(false);
  const alive = useRef(true);
  /** Anexos enviados nesta tela (spec 025): entram nos metadados do detalhe ao enviar a mensagem. */
  const uploaded = useRef(new Map<string, ChatAttachmentDto>());
  const windowId = target.windowId;
  const agentId = target.kind === 'agent' ? target.agentId : null;
  const fixedId = target.kind === 'session' ? target.conversationId : null;
  const conversationId = detail?.conversation?.id ?? null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      live.dispose();
    };
  }, [live]);

  const apply = useCallback(
    (value: PaneDetail) => {
      setDetail(value);
      setError(null);
      setRun(value.activeRun && isActiveStatus(value.activeRun.status) ? value.activeRun : null);
      if (value.conversation) {
        updateMeta({
          id: windowId,
          conversationId: value.conversation.id,
          title: value.conversation.title,
          agentName: value.conversation.agentName,
          colorSlot: value.conversation.agentColorSlot,
        });
      } else {
        updateMeta({ id: windowId, conversationId: null, title: null });
      }
    },
    [windowId, updateMeta],
  );

  const load = useCallback(async () => {
    try {
      if (agentId) {
        const value = await api.get<AgentThreadView>(`/api/agents/${agentId}/thread`);
        if (!alive.current) return;
        setAgent(value.agent);
        updateMeta({ id: windowId, agentName: value.agent.name, colorSlot: value.agent.colorSlot });
        apply(value.session ?? emptyDetail(value.media));
      } else if (fixedId) {
        const value = await api.get<ConversationDetail>(`/api/conversations/${fixedId}`);
        if (!alive.current) return;
        apply(value);
      }
    } catch (err) {
      if (alive.current) setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
    }
  }, [agentId, fixedId, windowId, apply, updateMeta]);

  useEffect(() => {
    void load();
  }, [load]);

  // Na janela do agente: a ativa mudou por fora (bifurcar numa janela de leitura) → relê o fio.
  const seenVersion = useRef(sessionsVersion);
  useEffect(() => {
    if (seenVersion.current === sessionsVersion) return;
    seenVersion.current = sessionsVersion;
    if (agentId) void load();
  }, [sessionsVersion, agentId, load]);

  const resetLive = useCallback(() => {
    setRun(null);
    live.clear();
    setLiveTools({});
    setStreamError(null);
    setRetrying(false);
    setReconnecting(false);
  }, [live, setRetrying]);

  const handleEvent = useCallback(
    (event: AiRunEvent) => {
      switch (event.type) {
        case 'status':
          setRun((r) => (r ? { ...r, status: event.status, error: event.error ?? r.error } : r));
          break;
        case 'text_delta':
          setRetrying(false);
          live.push('text', event.text);
          break;
        case 'thinking_delta':
          setRetrying(false);
          live.push('thinking', event.text);
          break;
        case 'tool_start':
          setLiveTools((tools) => ({ ...tools, [event.toolUseId]: { name: event.name, title: event.title, status: 'running' } }));
          break;
        case 'tool_result':
          setLiveTools((tools) => ({
            ...tools,
            [event.toolUseId]: {
              name: event.name,
              title: tools[event.toolUseId]?.title,
              status: event.isError ? 'error' : 'ok',
              summary: event.summary,
            },
          }));
          break;
        case 'message':
          setDetail((d) => (d ? { ...d, messages: upsertMessage(d.messages, event.message) } : d));
          if (event.message.role === 'assistant') {
            live.clear();
            setRetrying(false);
          }
          break;
        case 'confirmation':
          setDetail((d) => (d ? { ...d, confirmations: mergeConfirmations(d.confirmations, event.confirmations) } : d));
          break;
        case 'usage':
          setRun(event.run);
          break;
        case 'title':
          setDetail((d) => (d?.conversation ? { ...d, conversation: { ...d.conversation, title: event.title } } : d));
          updateMeta({ id: windowId, title: event.title });
          bumpList();
          break;
        case 'error':
          if (event.code === 'provider_retry') {
            // A execução volta à fila e a resposta recomeça do zero: o texto parcial da tentativa que caiu sai da tela.
            live.clear();
            setRetrying(true);
            break;
          }
          setStreamError(event.message);
          break;
        case 'done':
          setRun((r) => (r ? { ...r, status: event.status, error: event.error ?? r.error } : r));
          setRetrying(false);
          if (event.error) setStreamError(event.error);
          else if (event.status === 'completed') setStreamError(null);
          break;
      }
    },
    [windowId, updateMeta, bumpList, live, setRetrying],
  );

  /** O último evento visto da execução seguida: o SSE retoma dele depois da espera por aprovação. */
  const seen = useRef<{ runId: string; seq: number } | null>(null);
  // Execução que terminou (pelo SSE ou pela consulta da espera): limpa o ao vivo e relê o detalhe.
  const finished = useCallback(() => {
    seen.current = null;
    setReconnecting(false);
    setRetrying(false);
    setRun(null);
    live.clear();
    setLiveTools({});
    bumpList();
    void load();
  }, [live, bumpList, load, setRetrying]);

  // Segue o SSE só enquanto a execução anda, na fila ou rodando (tarefa 122): esperando aprovação, a
  // conexão fecha e volta ao decidir, do último evento visto (`seen`). Com a aba escondida, o
  // `followRun` fecha sozinho e retoma ao voltar.
  const streamRunId = run && (run.status === 'queued' || run.status === 'running') ? run.id : null;
  useEffect(() => {
    if (!streamRunId) return;
    const controller = new AbortController();
    const resume = seen.current?.runId === streamRunId ? seen.current.seq : null;
    if (resume === null) live.clear();
    void followRun(streamRunId, {
      signal: controller.signal,
      after: resume,
      onEvent: (event, seq) => {
        if (seq !== null) seen.current = { runId: streamRunId, seq };
        handleEvent(event);
      },
      onConnection: (connected) => setReconnecting(!connected),
    }).then((result) => {
      if (result === 'aborted' || !alive.current) return;
      finished();
    });
    return () => controller.abort();
  }, [streamRunId, handleEvent, finished, live]);

  // Esperando aprovação: sem conexão aberta; uma consulta leve a cada 10 s, só com a aba visível, percebe a
  // decisão tomada em outro lugar (outra aba, o Telegram) e retoma o SSE ou relê o fim.
  const awaitingRunId = run?.status === 'awaiting_confirmation' ? run.id : null;
  const checkAwaiting = useCallback(async () => {
    if (!awaitingRunId) return;
    const current = await api.get<AiRunDto>(`/api/runs/${awaitingRunId}`).catch(() => null);
    if (!current || !alive.current || current.status === 'awaiting_confirmation') return;
    // Voltou a andar: relê o detalhe (as confirmações decididas lá) e o SSE retoma do último evento visto.
    if (isActiveStatus(current.status)) void load();
    else finished();
  }, [awaitingRunId, finished, load]);
  usePolling(checkAwaiting, AWAITING_POLL_MS, Boolean(awaitingRunId));

  const send = useCallback(
    async (text: string, attachmentIds: string[], context?: ScreenContext) => {
      const body = { text, attachmentIds, screenContext: context ?? screenContext() };
      // Na janela do agente a mensagem vai para o fio: a API usa a sessão ativa ou cria uma.
      const result = agentId
        ? await api.post<AgentSendResult>(`/api/agents/${agentId}/messages`, body)
        : await api.post<SendMessageResult>(`/api/conversations/${fixedId}/messages`, body);
      setStreamError(null);
      setLiveTools({});
      const sent = attachmentIds.map((id) => uploaded.current.get(id)).filter((a): a is ChatAttachmentDto => Boolean(a));
      const session = agentId ? (result as AgentSendResult).conversation : null;
      setDetail((d) => {
        if (!d) return d;
        // Outra sessão (a ativa mudou noutra aba, ou o fio estava vazio): começa dela.
        const base = session && d.conversation?.id !== session.id ? { ...emptyDetail(d.media), conversation: session } : d;
        return {
          ...base,
          conversation: session ?? base.conversation,
          messages: upsertMessage(base.messages, result.message),
          attachments: [...base.attachments.filter((a) => !attachmentIds.includes(a.id)), ...sent],
        };
      });
      if (session) updateMeta({ id: windowId, conversationId: session.id, title: session.title });
      setRun(result.run);
      bumpList();
      return result;
    },
    [agentId, fixedId, windowId, screenContext, bumpList, updateMeta],
  );

  /** Finalizar sessão (spec 026): a API para a execução e arquiva; a janela volta ao fio vazio. */
  const finish = useCallback(async () => {
    if (!conversationId) return null;
    const finished = await api.post<ConversationDto>(`/api/conversations/${conversationId}/finish`);
    resetLive();
    setDetail((d) => (d ? emptyDetail(d.media) : d));
    updateMeta({ id: windowId, conversationId: null, title: null });
    bumpList();
    return finished;
  }, [conversationId, windowId, resetLive, updateMeta, bumpList]);

  const cancel = useCallback(async () => {
    if (!run) return;
    const result = await api.post<AiRunDto>(`/api/runs/${run.id}/cancel`);
    setRun((r) => (r && r.id === result.id ? { ...r, ...result } : r));
  }, [run]);

  const decide = useCallback(
    async (
      decision: 'approved' | 'rejected',
      ids?: string[],
      reason?: string,
      /** Segredos digitados no cartão (spec 027): id da confirmação → campo → valor; nunca guardados aqui. */
      secrets?: Record<string, Record<string, string>>,
    ) => {
      const pending = detail?.confirmations.filter((c) => c.status === 'pending') ?? [];
      const targetRun = pending[0]?.runId ?? run?.id;
      if (!targetRun) return null;
      const result = await api.post<DecideResult>(`/api/runs/${targetRun}/confirmations`, {
        decision,
        ...(ids ? { ids } : {}),
        ...(reason ? { reason } : {}),
        ...(decision === 'approved' && secrets && Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      const decidedIds = new Set(ids ?? pending.map((c) => c.id));
      setDetail((d) =>
        d
          ? {
              ...d,
              confirmations: d.confirmations.map((c) =>
                decidedIds.has(c.id) && c.status === 'pending'
                  ? { ...c, status: decision, reason: reason ?? null, decidedAt: new Date().toISOString() }
                  : c,
              ),
            }
          : d,
      );
      setRun((r) => (r ? { ...r, status: result.runStatus } : r));
      // Decidida e já encerrada (sem voltar à fila): não há SSE para reabrir; relê o fim.
      if (!isActiveStatus(result.runStatus)) finished();
      return result;
    },
    [detail, run, finished],
  );

  // Upload do chat: no áudio, a duração medida pelo navegador vai junto (spec 025). No fio ainda
  // sem sessão, o anexo abre a sessão ativa antes (o upload é sempre de uma sessão).
  const attach = useCallback(
    async (file: File, durationMs?: number | null) => {
      let id = conversationId ?? fixedId;
      if (!id && agentId) {
        const session = await api.post<ConversationDto>(`/api/agents/${agentId}/sessions`, { screenContext: screenContext() });
        id = session.id;
        setDetail((d) => (d && !d.conversation ? { ...d, conversation: session } : d));
        updateMeta({ id: windowId, conversationId: session.id, title: session.title });
        bumpList();
      }
      const row = await upload<ChatAttachmentDto>(
        `/api/conversations/${id}/attachments`,
        file,
        durationMs ? { durationMs: Math.round(durationMs) } : undefined,
      );
      uploaded.current.set(row.id, row);
      return row;
    },
    [conversationId, fixedId, agentId, windowId, screenContext, updateMeta, bumpList],
  );

  return {
    target,
    detail,
    agent,
    conversationId,
    error,
    run,
    busy: Boolean(run && isActiveStatus(run.status)),
    /** Texto e raciocínio ao vivo (assinados só pela bolha ao vivo). */
    live,
    liveTools,
    streamError,
    retrying,
    reconnecting,
    reload: load,
    send,
    finish,
    cancel,
    decide,
    attach,
    clearStreamError: () => setStreamError(null),
  };
}

export type ConversationState = ReturnType<typeof useConversation>;
