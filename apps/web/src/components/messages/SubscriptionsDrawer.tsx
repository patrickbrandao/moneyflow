import {
  type CaixaSummary,
  DEFAULT_MESSAGE_PARAMS,
  formatDateTime,
  MESSAGE_EVENT_KINDS,
  type MessageDestinationDto,
  type MessageEventKind,
  type MessageSubscriptionDto,
  t,
} from '@moneyflow/shared';
import { Bell, Save, Send, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { MoneyInput } from '../forms';
import { Badge, Button, cx, Skel } from '../ui';

/** Lista "3, 1, 0" → [3, 1, 0] (ignora o que não é número). */
const parseList = (text: string) =>
  text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));

/**
 * Gaveta de um destino: dados (sem o token) e as assinaturas de eventos, cada
 * uma com os parâmetros dela e o filtro de caixas.
 */
export function SubscriptionsDrawer({
  destination,
  onClose,
  onChanged,
  onTest,
}: {
  destination: MessageDestinationDto;
  onClose: () => void;
  onChanged: () => void;
  onTest: () => void;
}) {
  const subs = useApi<MessageSubscriptionDto[]>(`/api/message-destinations/${destination.id}/subscriptions`);
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const visible = (caixas.data ?? []).filter(
    (c) => !c.archivedAt && (destination.ownerKind !== 'caixa' || c.id === destination.ownerCaixaId || c.kind === 'credit_card'),
  );

  return (
    <aside className="drawer page-drawer" aria-label={destination.name}>
      <div className="dh">
        <Bell size={18} />
        <span className="t">{destination.name}</span>
        <button type="button" className="icon-btn" onClick={onClose} title={`${t.common.close} (Esc)`} aria-label={t.common.close}>
          <X />
        </button>
      </div>
      <div className="db">
        <div className="sec">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="accent">{t.messages.ownerShort[destination.ownerKind]}</Badge>
            {destination.archivedAt ? (
              <Badge tone="outline">{t.messages.archived}</Badge>
            ) : destination.isActive ? (
              <Badge tone="ok">{t.messages.active}</Badge>
            ) : (
              <Badge tone="danger">{t.messages.inactive}</Badge>
            )}
          </div>
          <dl className="kv mt-3">
            <dt>{t.messages.owner}</dt>
            <dd>{destination.ownerUsername ?? destination.ownerCaixaName ?? t.messages.ownerShort.global}</dd>
            <dt>{t.messages.botToken}</dt>
            <dd className="mono">{t.messages.botTokenSaved(destination.botId)}</dd>
            <dt>{t.messages.chatId}</dt>
            <dd className="mono">{destination.chatId}</dd>
            <dt>{t.messages.lastSent}</dt>
            <dd>{destination.lastSentAt ? formatDateTime(destination.lastSentAt) : '—'}</dd>
          </dl>
          {destination.canManage && destination.isActive && !destination.archivedAt && (
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClick={onTest}>
                <Send /> {t.messages.sendTest}
              </Button>
            </div>
          )}
        </div>

        <div className="sec">
          <p className="eyebrow">{t.messages.subscriptions}</p>
          <p className="hint mb-3">{t.messages.subscriptionsSub}</p>
          {subs.error ? (
            <LoadError error={subs.error} onRetry={() => void subs.reload()} />
          ) : !subs.data ? (
            <Skel h={240} />
          ) : (
            <div className="grid gap-2">
              {MESSAGE_EVENT_KINDS.map((kind) => (
                <SubscriptionEditor
                  key={kind}
                  destinationId={destination.id}
                  kind={kind}
                  current={subs.data!.find((s) => s.eventKind === kind) ?? null}
                  caixas={visible}
                  readOnly={!destination.canManage || Boolean(destination.archivedAt)}
                  onSaved={(list) => {
                    subs.setData(list);
                    onChanged();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function SubscriptionEditor({
  destinationId,
  kind,
  current,
  caixas,
  readOnly,
  onSaved,
}: {
  destinationId: string;
  kind: MessageEventKind;
  current: MessageSubscriptionDto | null;
  caixas: CaixaSummary[];
  readOnly: boolean;
  onSaved: (list: MessageSubscriptionDto[]) => void;
}) {
  const initial = (current?.params ?? DEFAULT_MESSAGE_PARAMS[kind]) as Record<string, unknown>;
  const [enabled, setEnabled] = useState(Boolean(current?.isActive));
  const [daysBefore, setDaysBefore] = useState(((initial.days_before as number[] | undefined) ?? [3, 1, 0]).join(', '));
  const [sendAt, setSendAt] = useState((initial.send_at as string | undefined) ?? '08:00');
  const [repeat, setRepeat] = useState<number | ''>((initial.repeat_every_days as number | undefined) ?? '');
  const [weekday, setWeekday] = useState((initial.weekday as number | undefined) ?? 1);
  const [thresholds, setThresholds] = useState(((initial.thresholds_percent as number[] | undefined) ?? [80, 100]).join(', '));
  const [minDiff, setMinDiff] = useState<number | null>((initial.min_difference_cents as number | undefined) ?? 0);
  const [selected, setSelected] = useState<string[]>(current?.caixaIds ?? []);
  const [dirty, setDirty] = useState(false);
  const { run, busy } = useAction();
  const touch =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setDirty(true);
    };

  function params(): Record<string, unknown> {
    switch (kind) {
      case 'due_reminder':
        return { days_before: parseList(daysBefore), send_at: sendAt };
      case 'overdue':
        return repeat === '' ? { send_at: sendAt } : { send_at: sendAt, repeat_every_days: repeat };
      case 'daily_summary':
        return { send_at: sendAt };
      case 'weekly_summary':
        return { send_at: sendAt, weekday };
      case 'card_limit':
        return { thresholds_percent: parseList(thresholds) };
      case 'reconciliation_divergence':
        return { min_difference_cents: minDiff ?? 0 };
      default:
        return {};
    }
  }

  async function save(nextEnabled = enabled) {
    const list = await run(
      () =>
        api.put<MessageSubscriptionDto[]>(`/api/message-destinations/${destinationId}/subscriptions`, {
          eventKind: kind,
          params: params(),
          isActive: nextEnabled,
          caixaIds: selected,
        }),
      t.messages.subscriptionSaved,
    );
    if (list) {
      setDirty(false);
      onSaved(list);
    }
  }

  const hasTime = kind === 'due_reminder' || kind === 'overdue' || kind === 'daily_summary' || kind === 'weekly_summary';
  const scoped = kind !== 'agent_completed' && kind !== 'agent_message';

  return (
    <div className={cx('sub-card well', enabled && 'on')}>
      <label className="check sub-head">
        <input
          type="checkbox"
          checked={enabled}
          disabled={readOnly || busy}
          onChange={(e) => {
            setEnabled(e.target.checked);
            // Ligar/desligar grava na hora; os parâmetros pedem "Salvar".
            void save(e.target.checked);
          }}
        />
        <span className="font-medium text-ink">{t.messages.events[kind]}</span>
      </label>
      <p className="hint">{t.messages.eventHints[kind]}</p>
      {enabled && (
        <div className="sub-params">
          {kind === 'due_reminder' && (
            <label>
              <span className="label">{t.messages.params.days_before}</span>
              <input
                className="field field-sm field-mono"
                value={daysBefore}
                onChange={(e) => touch(setDaysBefore)(e.target.value)}
                disabled={readOnly}
                title={t.messages.params.days_beforeHint}
                aria-label={t.messages.params.days_before}
              />
            </label>
          )}
          {hasTime && (
            <label>
              <span className="label">{t.messages.params.send_at}</span>
              <input
                type="time"
                className="field field-sm field-mono"
                value={sendAt}
                onChange={(e) => touch(setSendAt)(e.target.value)}
                disabled={readOnly}
                aria-label={t.messages.params.send_at}
              />
            </label>
          )}
          {kind === 'overdue' && (
            <label>
              <span className="label">{t.messages.params.repeat_every_days}</span>
              <input
                type="number"
                min={1}
                max={30}
                className="field field-sm field-mono"
                value={repeat}
                placeholder={t.messages.params.repeatNever}
                onChange={(e) => touch(setRepeat)(e.target.value === '' ? '' : Number(e.target.value))}
                disabled={readOnly}
                aria-label={t.messages.params.repeat_every_days}
              />
            </label>
          )}
          {kind === 'weekly_summary' && (
            <label>
              <span className="label">{t.messages.params.weekday}</span>
              <select
                className="field field-sm"
                value={weekday}
                onChange={(e) => touch(setWeekday)(Number(e.target.value))}
                disabled={readOnly}
                aria-label={t.messages.params.weekday}
              >
                {t.messages.weekdays.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'card_limit' && (
            <label>
              <span className="label">{t.messages.params.thresholds_percent}</span>
              <input
                className="field field-sm field-mono"
                value={thresholds}
                onChange={(e) => touch(setThresholds)(e.target.value)}
                disabled={readOnly}
                title={t.messages.params.thresholds_percentHint}
                aria-label={t.messages.params.thresholds_percent}
              />
            </label>
          )}
          {kind === 'reconciliation_divergence' && (
            <label>
              <span className="label">{t.messages.params.min_difference_cents}</span>
              <MoneyInput value={minDiff} onChange={touch(setMinDiff)} ariaLabel={t.messages.params.min_difference_cents} />
            </label>
          )}
          {scoped && caixas.length > 0 && (
            <div className="sub-caixas">
              <span className="label">
                {t.messages.caixaFilter} <span className="text-faint">· {t.messages.caixaFilterHint}</span>
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {caixas.map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      disabled={readOnly}
                      onChange={() =>
                        touch(setSelected)(selected.includes(c.id) ? selected.filter((x) => x !== c.id) : [...selected, c.id])
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {!readOnly && (
            <div>
              <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
                <Save /> {t.common.save}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
