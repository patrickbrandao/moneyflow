import type {
  AiMessageDto,
  AiRunDto,
  AiRunEvent,
  AttachmentRow,
  ConversationDetail,
  DecideResult,
  ScreenContext,
  SendMessageResult,
  ToolConfirmationDto,
} from '@moneyflow/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { upload } from '../lib/upload';
import { useAgents } from './AgentsProvider';
import { isActiveStatus } from './format';
import { followRun } from './stream';

/*
 * Uma conversa aberta: o histórico (GET /api/conversations/:id) mais o que
 * chega ao vivo pelo SSE da execução ativa (texto parcial, raciocínio, tools
 * em andamento, confirmações, uso e título). Ao terminar, recarrega o detalhe.
 */

export type LiveTool = { name: string; title?: string; status: 'running' | 'ok' | 'error'; summary?: string };

const bySeq = (a: AiMessageDto, b: AiMessageDto) => a.seq - b.seq;

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

export function useConversation(conversationId: string) {
  const agents = useAgents();
  const { updateMeta, bumpList, screenContext } = agents;
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [run, setRun] = useState<AiRunDto | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [liveTools, setLiveTools] = useState<Record<string, LiveTool>>({});
  const [streamError, setStreamError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const value = await api.get<ConversationDetail>(`/api/conversations/${conversationId}`);
      if (!alive.current) return;
      setDetail(value);
      setError(null);
      setRun(value.activeRun && isActiveStatus(value.activeRun.status) ? value.activeRun : null);
      updateMeta({
        id: conversationId,
        title: value.conversation.title,
        agentName: value.conversation.agentName,
        colorSlot: value.conversation.agentColorSlot,
      });
    } catch (err) {
      if (alive.current) setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
    }
  }, [conversationId, updateMeta]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleEvent = useCallback(
    (event: AiRunEvent) => {
      switch (event.type) {
        case 'status':
          setRun((r) => (r ? { ...r, status: event.status, error: event.error ?? r.error } : r));
          break;
        case 'text_delta':
          setLiveText((text) => text + event.text);
          break;
        case 'thinking_delta':
          setLiveThinking((text) => text + event.text);
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
            setLiveText('');
            setLiveThinking('');
          }
          break;
        case 'confirmation':
          setDetail((d) => (d ? { ...d, confirmations: mergeConfirmations(d.confirmations, event.confirmations) } : d));
          break;
        case 'usage':
          setRun(event.run);
          break;
        case 'title':
          setDetail((d) => (d ? { ...d, conversation: { ...d.conversation, title: event.title } } : d));
          updateMeta({ id: conversationId, title: event.title });
          bumpList();
          break;
        case 'error':
          setStreamError(event.message);
          break;
        case 'done':
          setRun((r) => (r ? { ...r, status: event.status, error: event.error ?? r.error } : r));
          if (event.error) setStreamError(event.error);
          break;
      }
    },
    [conversationId, updateMeta, bumpList],
  );

  // Segue o SSE enquanto houver execução ativa.
  const runId = run && isActiveStatus(run.status) ? run.id : null;
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setLiveText('');
    setLiveThinking('');
    void followRun(runId, {
      signal: controller.signal,
      onEvent: handleEvent,
      onConnection: (connected) => setReconnecting(!connected),
    }).then((result) => {
      if (result === 'aborted' || !alive.current) return;
      setReconnecting(false);
      setRun(null);
      setLiveText('');
      setLiveThinking('');
      setLiveTools({});
      bumpList();
      void load();
    });
    return () => controller.abort();
  }, [runId, handleEvent, load, bumpList]);

  const send = useCallback(
    async (text: string, attachmentIds: string[], context?: ScreenContext) => {
      const result = await api.post<SendMessageResult>(`/api/conversations/${conversationId}/messages`, {
        text,
        attachmentIds,
        screenContext: context ?? screenContext(),
      });
      setStreamError(null);
      setLiveTools({});
      setDetail((d) => (d ? { ...d, messages: upsertMessage(d.messages, result.message) } : d));
      setRun(result.run);
      bumpList();
      return result;
    },
    [conversationId, screenContext, bumpList],
  );

  const cancel = useCallback(async () => {
    if (!run) return;
    const result = await api.post<AiRunDto>(`/api/runs/${run.id}/cancel`);
    setRun((r) => (r && r.id === result.id ? { ...r, ...result } : r));
  }, [run]);

  const decide = useCallback(
    async (decision: 'approved' | 'rejected', ids?: string[], reason?: string) => {
      const pending = detail?.confirmations.filter((c) => c.status === 'pending') ?? [];
      const targetRun = pending[0]?.runId ?? run?.id;
      if (!targetRun) return null;
      const result = await api.post<DecideResult>(`/api/runs/${targetRun}/confirmations`, {
        decision,
        ...(ids ? { ids } : {}),
        ...(reason ? { reason } : {}),
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
      return result;
    },
    [detail, run],
  );

  const attach = useCallback(
    (file: File) => upload<AttachmentRow>(`/api/conversations/${conversationId}/attachments`, file),
    [conversationId],
  );

  return {
    detail,
    error,
    run,
    busy: Boolean(run && isActiveStatus(run.status)),
    liveText,
    liveThinking,
    liveTools,
    streamError,
    reconnecting,
    reload: load,
    send,
    cancel,
    decide,
    attach,
    clearStreamError: () => setStreamError(null),
  };
}

export type ConversationState = ReturnType<typeof useConversation>;
