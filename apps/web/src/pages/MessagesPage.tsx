import { formatDateTime, type MessageDestinationDto, type TestSendResult, t } from '@moneyflow/shared';
import { ArchiveRestore, Bell, History, MoreHorizontal, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { DestinationFormModal } from '../components/messages/DestinationFormModal';
import { HistoryTab } from '../components/messages/HistoryTab';
import { SubscriptionsDrawer } from '../components/messages/SubscriptionsDrawer';
import { useToast } from '../components/Toast';
import { Badge, Button, cx, EmptyRow, EmptyState, Menu, MenuItem, MenuSeparator, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { useParamState, useSetParams } from '../lib/params';

/**
 * Mensagens (spec 013): cadastro central de destinos do Telegram (token
 * write-only), os eventos de cada um e o histórico de envios.
 */
export function MessagesPage() {
  const [tab, setTab] = useParamState('tab');
  const [isNew, setNew] = useParamState('new');
  const [openId, setOpenId] = useParamState('destination');
  const [editing, setEditing] = useState<MessageDestinationDto | null>(null);
  const setParams = useSetParams();
  const { data, error, reload } = useApi<MessageDestinationDto[]>('/api/message-destinations');
  const confirm = useConfirm();
  const toast = useToast();
  const { run, busy } = useAction();
  const history = tab === 'history';
  const opened = !history && openId ? (data?.find((d) => d.id === openId) ?? null) : null;

  // Esc fecha a gaveta do destino.
  useEffect(() => {
    if (!openId) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.modal')) setOpenId(null);
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [openId, setOpenId]);

  useRegisterCommands(
    [
      { id: 'msg-new', label: t.messages.newDestination, group: 'Criar', icon: <Plus />, run: () => setNew('1') },
      { id: 'msg-history', label: t.messages.history, group: 'Ir para', icon: <History />, run: () => setTab('history') },
    ],
    [],
  );

  async function sendTest(d: MessageDestinationDto) {
    const result = await run(() => api.post<TestSendResult>(`/api/message-destinations/${d.id}/test`));
    if (!result) return;
    if (result.status === 'sent') toast.success(t.messages.testSent);
    else if (result.status === 'failed') toast.error(t.messages.testFailed(result.error ?? ''));
    else toast.error(`${t.messages.testQueued}${result.error ? ` (${result.error})` : ''}`);
    void reload();
  }

  async function remove(d: MessageDestinationDto) {
    const ok = await confirm({
      title: t.messages.removeConfirm(d.name),
      description: t.messages.removeDescription,
      confirmLabel: t.common.remove,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ deleted: boolean; archived: boolean }>(`/api/message-destinations/${d.id}`),
      (r) => t.common.deletedOrArchived(r.archived),
    );
    if (result) {
      if (openId === d.id) setOpenId(null);
      void reload();
    }
  }

  async function restore(d: MessageDestinationDto) {
    if (await run(() => api.post(`/api/message-destinations/${d.id}/restore`), t.messages.restored)) void reload();
  }

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.messages}
        sub={t.messages.pageSub}
        actions={
          <Button onClick={() => setNew('1')}>
            <Plus /> {t.messages.newDestination}
          </Button>
        }
      />
      <Tabs
        value={history ? 'history' : 'destinations'}
        onChange={(key) => setTab(key === 'history' ? 'history' : null)}
        items={[
          { key: 'destinations', label: t.messages.tabs.destinations, icon: <Bell />, count: data?.length },
          { key: 'history', label: t.messages.tabs.history, icon: <History /> },
        ]}
      />

      {history ? (
        <HistoryTab destinations={data ?? []} />
      ) : error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : data && data.length === 0 ? (
        <EmptyState
          icon={<Send />}
          title={t.messages.noDestinations}
          description={t.messages.noDestinationsHint}
          action={
            <Button onClick={() => setNew('1')}>
              <Plus /> {t.messages.newDestination}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.messages.name}</th>
                <th>{t.messages.owner}</th>
                <th>{t.messages.chatId}</th>
                <th>{t.common.status}</th>
                <th className="num">{t.messages.subscriptions}</th>
                <th>{t.messages.lastSent}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={7} />}
              {data?.length === 0 && <EmptyRow colSpan={7}>{t.messages.noDestinations}</EmptyRow>}
              {data?.map((d) => (
                <tr
                  key={d.id}
                  className={cx('cursor-pointer', d.id === openId && 'is-selected', d.archivedAt && 'is-off')}
                  onClick={() => setOpenId(d.id)}
                >
                  <td>
                    <span className="row-title">{d.name}</span>
                    <span className="row-sub mono">bot {d.botId ?? '—'}</span>
                  </td>
                  <td>
                    <Badge tone={d.ownerKind === 'global' ? 'accent' : 'neutral'}>{t.messages.ownerShort[d.ownerKind]}</Badge>{' '}
                    <span className="text-[12px] text-muted">{d.ownerUsername ?? d.ownerCaixaName ?? ''}</span>
                  </td>
                  <td className="mono text-xs">{d.chatId}</td>
                  <td>
                    {d.archivedAt ? (
                      <Badge tone="outline">{t.messages.archived}</Badge>
                    ) : d.isActive ? (
                      <Badge tone="ok">{t.messages.active}</Badge>
                    ) : (
                      <Badge tone="danger">{t.messages.inactive}</Badge>
                    )}
                    {d.failedCount > 0 && (
                      <>
                        {' '}
                        <Badge tone="warn">{t.messages.failures(d.failedCount)}</Badge>
                      </>
                    )}
                  </td>
                  <td className="num">{d.subscriptions}</td>
                  <td className="text-xs text-muted">{d.lastSentAt ? formatDateTime(d.lastSentAt) : '—'}</td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()} onKeyDown={() => {}}>
                    {d.canManage && !d.archivedAt && d.isActive && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void sendTest(d)}>
                        <Send /> {t.messages.sendTest}
                      </Button>
                    )}
                    {d.canManage && (
                      <Menu
                        align="right"
                        trigger={(props) => (
                          <button type="button" className="row-action" aria-label={t.common.actions} {...props}>
                            <MoreHorizontal />
                          </button>
                        )}
                      >
                        {!d.archivedAt && (
                          <MenuItem icon={<Pencil />} onSelect={() => setEditing(d)}>
                            {t.common.edit}
                          </MenuItem>
                        )}
                        {d.archivedAt ? (
                          <MenuItem icon={<ArchiveRestore />} onSelect={() => void restore(d)}>
                            {t.messages.restore}
                          </MenuItem>
                        ) : (
                          <>
                            <MenuSeparator />
                            <MenuItem icon={<Trash2 />} danger onSelect={() => void remove(d)}>
                              {t.common.remove}
                            </MenuItem>
                          </>
                        )}
                      </Menu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {opened && (
        <SubscriptionsDrawer
          key={opened.id}
          destination={opened}
          onClose={() => setOpenId(null)}
          onChanged={() => void reload()}
          onTest={() => void sendTest(opened)}
        />
      )}

      {isNew && (
        <DestinationFormModal
          open
          onClose={() => setNew(null)}
          onSaved={(d) => {
            // Um setter só: dois seguidos se sobrescreveriam.
            setParams({ new: null, destination: d.id });
            void reload();
          }}
        />
      )}
      {editing && (
        <DestinationFormModal
          open
          destination={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
