import {
  type AgentPromptPreviewDto,
  type AgentPromptVersionDto,
  type AiAgentDto,
  diffLines,
  diffStats,
  formatDateTime,
  PROMPT_VARIABLES,
  t,
  type UserRow,
} from '@moneyflow/shared';
import { ArrowLeft, Eye, GitCompare, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { ModalActions } from '../forms';
import { Badge, Button, cx, Field, useConfirm } from '../ui';

/*
 * Prompt do agente (spec 022): a lista de variáveis (clicar insere), o
 * histórico de versões com diff e restaurar, e o "Ver prompt montado". O
 * histórico e o prompt montado abrem dentro do próprio formulário do agente
 * (sem modal sobre modal).
 */

const g = t.agentsUi.admin.agents;
const p = t.agentsUi.admin.prompt;

export function PromptVariables({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div>
      <span className="label">{g.variables}</span>
      <p className="hint !mt-0 mb-1.5">{g.variablesHint}</p>
      <div className="flex flex-wrap gap-1.5" data-testid="prompt-variables">
        {PROMPT_VARIABLES.map((v) => (
          <button
            key={v.name}
            type="button"
            className="prompt-var"
            title={`${v.description}${v.kind === 'volatile' ? ` (${g.variableVolatile})` : ''}`}
            onClick={() => onInsert(`{{${v.name}}}`)}
          >
            {`{{${v.name}}}`}
            {v.kind === 'volatile' && <span className="text-faint"> ·</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Histórico das versões: conteúdo de uma, diff entre duas (A → B) e restaurar. */
export function PromptHistory({
  agent,
  onBack,
  onRestored,
}: {
  agent: AiAgentDto;
  onBack: () => void;
  onRestored: (agent: AiAgentDto) => void;
}) {
  const { data, error, reload } = useApi<AgentPromptVersionDto[]>(`/api/admin/ai/agents/${agent.id}/prompt-versions`);
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const current = data?.[0]?.id ?? null;
  const byId = useMemo(() => new Map((data ?? []).map((v) => [v.id, v])), [data]);

  async function restore(version: AgentPromptVersionDto) {
    const ok = await confirm({ title: p.restoreConfirm(version.version), description: p.restoreDescription, confirmLabel: p.restore });
    if (!ok) return;
    const saved = await run(
      () => api.post<AiAgentDto>(`/api/admin/ai/agents/${agent.id}/prompt-versions/${version.id}/restore`),
      p.restored(version.version),
    );
    if (!saved) return;
    setShown(null);
    setLeft(null);
    setRight(null);
    await reload();
    onRestored(saved);
  }

  const a = left ? byId.get(left) : undefined;
  const b = right ? byId.get(right) : undefined;
  const view = shown ? byId.get(shown) : undefined;
  return (
    <>
      <div className="modal-body form-grid">
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {data && data.length === 0 && <p className="hint">{p.versionsEmpty}</p>}
        <ul className="item-list max-h-[38vh] overflow-auto" data-testid="prompt-versions">
          {(data ?? []).map((v) => (
            <li key={v.id} className={cx('item', shown === v.id && 'bg-s2')} data-testid={`prompt-version-${v.version}`}>
              <button type="button" className="grow min-w-0 text-left" onClick={() => setShown(shown === v.id ? null : v.id)}>
                <span className="row-title">
                  {g.promptVersion(v.version)} {v.id === current && <Badge tone="ok">{p.current}</Badge>}
                </span>
                <span className="row-sub">
                  {formatDateTime(v.createdAt)} · {v.createdByUsername ? `@${v.createdByUsername}` : p.unknownAuthor}
                  {v.note ? ` · ${v.note}` : ''}
                </span>
              </button>
              <span className="row-actions">
                <label className="check" title={p.compareA(v.version)}>
                  <input
                    type="radio"
                    name="prompt-a"
                    checked={left === v.id}
                    onChange={() => setLeft(v.id)}
                    aria-label={p.compareA(v.version)}
                  />{' '}
                  A
                </label>
                <label className="check" title={p.compareB(v.version)}>
                  <input
                    type="radio"
                    name="prompt-b"
                    checked={right === v.id}
                    onChange={() => setRight(v.id)}
                    aria-label={p.compareB(v.version)}
                  />{' '}
                  B
                </label>
                {v.id !== current && (
                  <button type="button" className="row-action" title={p.restore} aria-label={p.restore} onClick={() => void restore(v)}>
                    <RotateCcw />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {view ? (
          <pre className="panel contract-raw" data-testid="prompt-version-content">
            {view.content || p.emptyPrompt}
          </pre>
        ) : a && b && a.id !== b.id ? (
          <PromptDiff before={a} after={b} />
        ) : (
          <p className="hint">
            <GitCompare className="inline size-4" /> {p.compare}
          </p>
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> {t.common.back}
        </Button>
      </ModalActions>
    </>
  );
}

function PromptDiff({ before, after }: { before: AgentPromptVersionDto; after: AgentPromptVersionDto }) {
  const lines = useMemo(() => diffLines(before.content, after.content), [before, after]);
  const stats = diffStats(lines);
  const title = p.diffTitle(before.version, after.version);
  return (
    <div>
      <p className="mb-2 text-sm font-medium">
        {title} <span className="text-ok">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
      </p>
      {stats.added + stats.removed === 0 ? (
        <p className="hint">{p.noDiff}</p>
      ) : (
        <div className="panel diff-view" aria-label={title} data-testid="prompt-diff">
          {lines.map((line, i) => (
            <div key={`${i}-${line.kind}`} className={cx('diff-line', line.kind)}>
              <span className="ln">{line.oldLine ?? ''}</span>
              <span className="ln">{line.newLine ?? ''}</span>
              <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
              <span className="txt">{line.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Ver prompt montado": escolhe um usuário e mostra o prompt final, com os pontos de cache, sem chamar o modelo. */
export function PromptPreview({ agent, dirty, onBack }: { agent: AiAgentDto; dirty: boolean; onBack: () => void }) {
  const users = useApi<UserRow[]>('/api/users');
  const [userId, setUserId] = useState('');
  const [preview, setPreview] = useState<AgentPromptPreviewDto | null>(null);
  const { run, busy } = useAction();

  async function build(id: string) {
    setUserId(id);
    setPreview(null);
    if (!id) return;
    const result = await run(() => api.post<AgentPromptPreviewDto>(`/api/admin/ai/agents/${agent.id}/prompt-preview`, { userId: id }));
    if (result) setPreview(result);
  }

  return (
    <>
      <div className="modal-body form-grid">
        <p className="panel-hint">{p.previewHint}</p>
        {dirty && <p className="notice mt-0">{p.previewSaveFirst}</p>}
        <Field label={p.previewUser}>
          <select className="field" value={userId} onChange={(e) => void build(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {(users.data ?? [])
              .filter((u) => u.isActive)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  @{u.username}
                </option>
              ))}
          </select>
        </Field>
        {preview?.volatileVariables && <p className="notice warn mt-0">{g.volatileWarning}</p>}
        {preview && (
          <div className="grid gap-2" data-testid="prompt-preview">
            {preview.parts.map((part, index) => (
              <div key={`${part.kind}-${index}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="label !mb-0">{p.parts[part.kind]}</span>
                  <span className="text-[11.5px] text-faint">{p.chars(part.text.length)}</span>
                </div>
                <pre className="panel contract-raw !max-h-[30vh]">{part.text}</pre>
                {part.cacheBreakpoint && (
                  <p className="prompt-cache-mark" data-testid="prompt-cache-mark">
                    {p.cacheBreakpoint} {index + 1}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {!preview && !busy && (
          <p className="hint">
            <Eye className="inline size-4" /> {p.previewUser}
          </p>
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> {t.common.back}
        </Button>
      </ModalActions>
    </>
  );
}
