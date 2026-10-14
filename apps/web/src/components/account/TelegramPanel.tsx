import { formatDateTime, type TelegramAccountDto, type TelegramLinkDto, type TelegramPairingCodeDto, t } from '@moneyflow/shared';
import { MessageCircle, Unlink } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { Badge, Button, CopyButton, cx, EmptyRow, Field, Panel, useConfirm } from '../ui';

const k = t.agentsUi.telegram;

/**
 * Minha conta → Telegram (spec 029): gerar o código de pareamento de um bot
 * com "Receber mensagens" ligado, ver e desfazer os pareamentos. O admin vê
 * os de todos os usuários.
 */
export function TelegramPanel() {
  const user = useUser();
  const [all, setAll] = useState(false);
  const { data, error, reload } = useApi<TelegramAccountDto>(`/api/account/telegram${all ? '?all=true' : ''}`);
  const [destinationId, setDestinationId] = useState('');
  const [code, setCode] = useState<TelegramPairingCodeDto | null>(null);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const chosen = destinationId || data?.destinations[0]?.id || '';

  async function generate() {
    const created = await run(() => api.post<TelegramPairingCodeDto>('/api/account/telegram/pairing-codes', { destinationId: chosen }));
    if (created) setCode(created);
  }

  async function unpair(link: TelegramLinkDto) {
    const ok = await confirm({ title: k.unpairConfirm, description: k.unpairHint, confirmLabel: k.unpair, danger: true });
    if (ok && (await run(() => api.del(`/api/account/telegram/links/${link.id}`), k.unpaired))) void reload();
  }

  return (
    <Panel title={k.title} icon={<MessageCircle />}>
      <p className="panel-hint">{k.hint}</p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <div className="table-wrap mt-3">
          <table className="data">
            <tbody>
              <SkelRows cols={3} rows={2} />
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {data.destinations.length === 0 ? (
            <p className="panel-hint mt-3">{k.noDestinations}</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label={k.destination}>
                <select
                  className="field"
                  value={chosen}
                  onChange={(e) => setDestinationId(e.target.value)}
                  data-testid="telegram-destination"
                >
                  {data.destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.agentName ? ` · ${d.agentName}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Button onClick={() => void generate()} disabled={busy || !chosen} data-testid="telegram-generate">
                {k.generate}
              </Button>
            </div>
          )}
          {code && (
            <div className="well mt-3" data-testid="telegram-code">
              <span className="label">{k.code}</span>
              <p className="hint">{k.codeHint(10)}</p>
              <div className="flex items-center gap-2">
                <code className="mono text-[15px]" data-testid="telegram-code-value">
                  /start {code.code}
                </code>
                <CopyButton text={`/start ${code.code}`} />
              </div>
              <p className="hint">{k.expiresAt(formatDateTime(code.expiresAt))}</p>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between">
            <span className="label">{k.links}</span>
            {user.role === 'admin' && (
              <label className="check text-xs">
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {k.showAll}
              </label>
            )}
          </div>
          <div className="table-wrap mt-2">
            <table className="data" data-testid="telegram-links">
              <thead>
                <tr>
                  <th>{k.destination}</th>
                  <th>{k.chat}</th>
                  {all && <th>{k.user}</th>}
                  <th>{k.since}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.links.length === 0 && <EmptyRow colSpan={all ? 5 : 4}>{k.linksEmpty}</EmptyRow>}
                {data.links.map((link) => (
                  <tr key={link.id} className={cx(link.revokedAt && 'is-off')}>
                    <td>{link.destinationName}</td>
                    <td className="mono text-xs">
                      {link.telegramUsername ? `@${link.telegramUsername}` : link.chatId}
                      {link.telegramUsername && <span className="row-sub">{link.chatId}</span>}
                    </td>
                    {all && <td className="mono text-xs">@{link.username}</td>}
                    <td className="mono text-xs">{formatDateTime(link.createdAt)}</td>
                    <td className="text-right">
                      {link.revokedAt ? (
                        <Badge tone="outline">{k.revoked}</Badge>
                      ) : (
                        <button
                          type="button"
                          className="row-action danger"
                          title={k.unpair}
                          aria-label={`${k.unpair} ${link.destinationName}`}
                          onClick={() => void unpair(link)}
                        >
                          <Unlink />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
