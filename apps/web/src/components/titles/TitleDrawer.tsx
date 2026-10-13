import { contractLink, formatBRL, formatDate, formatDateTime, type TitleDetail, t } from '@moneyflow/shared';
import {
  Ban,
  CalendarDays,
  Check,
  CircleDollarSign,
  CreditCard,
  Handshake,
  History,
  Paperclip,
  Pencil,
  RotateCcw,
  ThumbsDown,
  Trash2,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAgentScreenContext } from '../../agents/AgentsProvider';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { invoiceLink, titleLink } from '../../lib/links';
import { AttachmentsPanel } from '../attachments/AttachmentsPanel';
import { AuditHistory } from '../audit/AuditHistory';
import { CategoryLabel, LoadError, MirrorBadge, Money, TitleStatusBadge } from '../domain';
import { TitleEntryInfo } from '../entry/TitleEntryInfo';
import { CategorySelect, ModalActions } from '../forms';
import { Badge, Button, Field, Modal, Skel, useConfirm } from '../ui';
import { ReverseModal, SetAccountModal, SettlementModal } from './SettlementModal';
import { TitleFormModal } from './TitleFormModal';

/**
 * Gaveta do título: dados, espelho (aceitar/contestar), baixas (estornar,
 * definir conta) e as ações do título. Toda ação também vira comando da paleta.
 */
export function TitleDrawer({ titleId, onClose, onChanged }: { titleId: string; onClose: () => void; onChanged: () => void }) {
  const { data: title, error, reload, setData } = useApi<TitleDetail>(`/api/titles/${titleId}`);
  const [modal, setModal] = useState<
    | null
    | { kind: 'settle' }
    | { kind: 'edit' }
    | { kind: 'accept' }
    | { kind: 'dispute' }
    | { kind: 'reverse'; id: string; hasTransfer: boolean }
    | { kind: 'account'; id: string }
    | { kind: 'history'; table: 'titles' | 'settlements'; id: string }
  >(null);
  const [attachmentCount, setAttachmentCount] = useState<number | null>(null);
  const pickFile = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { run } = useAction();
  useAgentScreenContext(
    title
      ? {
          caixaId: title.caixaId,
          caixaName: title.caixaName,
          record: { kind: 'title', id: title.id, label: title.description },
        }
      : null,
  );

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modal) onClose();
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [onClose, modal]);

  const saved = (next: TitleDetail) => {
    setData(next);
    setModal(null);
    onChanged();
  };

  const canSettle = Boolean(title?.canWrite && title.status !== 'canceled' && title.openCents > 0 && !title.archivedAt);
  const awaiting = title?.mirrorStatus === 'pending' || title?.mirrorStatus === 'disputed';
  /** Título de fatura de cartão: valor, vencimento, cancelamento e exclusão mudam pela fatura. */
  const isInvoice = Boolean(title?.cardInvoiceId);

  async function cancel() {
    if (!title) return;
    const ok = await confirm({
      title: 'Cancelar o título?',
      description: title.mirrorTitleId ? 'O espelho na outra caixa também é cancelado.' : 'Ele deixa de contar como em aberto.',
      confirmLabel: t.title.cancelTitle,
      danger: true,
    });
    if (!ok) return;
    const next = await run(() => api.post<TitleDetail>(`/api/titles/${title.id}/cancel`), 'Título cancelado.');
    if (next) saved(next);
  }

  async function reopen() {
    if (!title) return;
    const next = await run(() => api.post<TitleDetail>(`/api/titles/${title.id}/reopen`), 'Título reaberto.');
    if (next) saved(next);
  }

  async function remove(scope: 'this' | 'following') {
    if (!title) return;
    const ok = await confirm({
      title: scope === 'following' ? 'Excluir este e os próximos?' : 'Excluir o título?',
      description:
        scope === 'following'
          ? 'A série termina antes desta ocorrência; as seguintes somem.'
          : 'Sem baixas, o título (e o espelho) é excluído; com histórico, é arquivado.',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ deleted: boolean; archived: boolean }>(`/api/titles/${title.id}`, { scope }),
      (r) => t.common.deletedOrArchived(r.archived),
    );
    if (result) {
      onChanged();
      onClose();
    }
  }

  useRegisterCommands(
    title
      ? [
          ...(canSettle
            ? [
                {
                  id: 't-settle',
                  label: `${title.direction === 'payable' ? t.title.pay : t.title.receive}: ${title.description}`,
                  group: 'Recurso' as const,
                  icon: <CircleDollarSign />,
                  run: () => setModal({ kind: 'settle' }),
                },
              ]
            : []),
          ...(title.canWrite
            ? [
                {
                  id: 't-edit',
                  label: `Editar: ${title.description}`,
                  group: 'Recurso' as const,
                  icon: <Pencil />,
                  run: () => setModal({ kind: 'edit' }),
                },
              ]
            : []),
          {
            id: 't-history',
            label: t.audit.titleHistory,
            group: 'Recurso' as const,
            icon: <History />,
            run: () => setModal({ kind: 'history', table: 'titles', id: title.id }),
          },
          ...(title.canWrite
            ? [
                {
                  id: 't-attach',
                  label: `${t.attachments.attach}: ${title.description}`,
                  group: 'Recurso' as const,
                  icon: <Paperclip />,
                  run: () => pickFile.current?.(),
                },
              ]
            : []),
          {
            id: 't-calendar',
            label: t.calendar.openCalendarAt,
            group: 'Ir para' as const,
            icon: <CalendarDays />,
            keywords: [t.calendar.openCalendar],
            run: () => navigate(`/calendar?date=${title.dueDate}&caixas=${title.caixaId}`),
          },
          ...(title.canWrite && awaiting
            ? [
                {
                  id: 't-accept',
                  label: t.title.acceptMirror,
                  group: 'Recurso' as const,
                  icon: <Check />,
                  run: () => setModal({ kind: 'accept' }),
                },
              ]
            : []),
        ]
      : [],
    [title, canSettle, awaiting, navigate],
  );

  return (
    <aside className="drawer page-drawer" aria-label={title?.description ?? 'Título'}>
      <div className="dh">
        <span className="t">{title?.description ?? t.common.loading}</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)" aria-label={t.common.close}>
          <X />
        </button>
      </div>
      <div className="db">
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {!title && !error && (
          <div className="grid gap-3">
            <Skel h={22} w="60%" />
            <Skel h={120} />
            <Skel h={80} />
          </div>
        )}
        {title && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="outline">{t.title.directions[title.direction]}</Badge>
              <TitleStatusBadge title={title} />
              <MirrorBadge status={title.pairMirrorStatus} />
              {title.occurrence && <Badge mono>{t.title.occurrenceOf(title.occurrence, title.installmentsTotal)}</Badge>}
              {title.contractInstallment && (
                <Badge mono>{t.title.occurrenceOf(title.contractInstallment, title.contractInstallmentsCount)}</Badge>
              )}
              {title.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
            </div>
            <div className="mt-3 text-[22px] font-semibold text-ink">
              <Money cents={title.amountCents} />
            </div>
            <p className="text-[13px] text-muted">
              {t.title.open}: <Money cents={title.openCents} /> · {t.title.settled}: <Money cents={title.settledCents} />
            </p>

            {title.canWrite && !title.archivedAt && (
              <div className="mt-4 flex flex-wrap gap-2">
                {canSettle && (
                  <Button size="sm" onClick={() => setModal({ kind: 'settle' })}>
                    <CircleDollarSign /> {title.direction === 'payable' ? t.title.pay : t.title.receive}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'edit' })}>
                  <Pencil /> {t.common.edit}
                </Button>
                {isInvoice ? null : title.status === 'canceled' ? (
                  <Button size="sm" variant="ghost" onClick={() => void reopen()}>
                    <RotateCcw /> Reabrir
                  </Button>
                ) : (
                  title.settledCents === 0 && (
                    <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                      <Ban /> {t.title.cancelTitle}
                    </Button>
                  )
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="quiet" onClick={() => setModal({ kind: 'history', table: 'titles', id: title.id })}>
                <History /> {t.audit.history}
              </Button>
              {title.contractId && (
                <Link className="btn btn-quiet btn-sm" to={contractLink(title.contractId)} title={t.contracts.fromContract}>
                  <Handshake /> {t.contracts.titleBadge(title.contractName ?? t.contracts.contract, null, null)}
                </Link>
              )}
              {title.cardInvoiceId && (
                <Link className="btn btn-quiet btn-sm" to={invoiceLink(title.cardInvoiceId, title.caixaId)}>
                  <CreditCard /> {t.entry.cardInvoice}
                </Link>
              )}
            </div>

            {awaiting && title.canWrite && (
              <div className="sec">
                <div className="alert warn">
                  <span>
                    {title.mirrorStatus === 'pending'
                      ? 'Lançado por outra caixa e aguardando o seu aceite.'
                      : 'Você contestou este lançamento.'}{' '}
                    Aceite (podendo ajustar a categoria) ou conteste.
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => setModal({ kind: 'accept' })}>
                    <Check /> {t.title.acceptMirror}
                  </Button>
                  {title.mirrorStatus === 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'dispute' })}>
                      <ThumbsDown /> {t.title.disputeMirror}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="sec">
              <p className="eyebrow">{t.common.details}</p>
              <dl className="kv">
                <dt>{title.direction === 'payable' ? t.title.payee : t.title.payer}</dt>
                <dd>
                  <Link className="link" to={`/entities/${title.entityId}`}>
                    {title.entityName}
                  </Link>
                </dd>
                <dt>{t.title.category}</dt>
                <dd>
                  <CategoryLabel name={title.categoryName} slot={title.categoryColorSlot} />
                </dd>
                <dt>{t.title.due}</dt>
                <dd className="mono">{formatDate(title.dueDate)}</dd>
                <dt>{t.title.competence}</dt>
                <dd className="mono">{formatDate(title.competenceDate)}</dd>
                <dt>Origem</dt>
                <dd>{t.title.origins[title.origin]}</dd>
                {title.rule && (
                  <>
                    <dt>{t.title.series}</dt>
                    <dd>
                      {t.title.frequencies[title.rule.frequency]}
                      {title.rule.intervalCount > 1 ? ` (a cada ${title.rule.intervalCount})` : ''}
                      {title.rule.installmentsTotal ? ` · ${title.rule.installmentsTotal} parcelas` : ''}
                      {title.rule.endsOn ? ` · até ${formatDate(title.rule.endsOn)}` : ''}
                    </dd>
                  </>
                )}
                {title.notes && (
                  <>
                    <dt>{t.common.notes}</dt>
                    <dd className="whitespace-pre-wrap">{title.notes}</dd>
                  </>
                )}
              </dl>
            </div>

            {title.mirror && (
              <div className="sec">
                <p className="eyebrow">{t.title.mirror}</p>
                <dl className="kv">
                  <dt>Caixa</dt>
                  <dd>
                    {title.mirror.canRead ? (
                      <Link
                        className="link"
                        to={titleLink({
                          id: title.mirror.id,
                          caixaId: title.mirror.caixaId,
                          direction: title.direction === 'payable' ? 'receivable' : 'payable',
                        })}
                      >
                        {title.mirror.caixaName}
                      </Link>
                    ) : (
                      title.mirror.caixaName
                    )}
                  </dd>
                  <dt>{t.title.category}</dt>
                  <dd>{title.mirror.categoryName}</dd>
                  <dt>{t.common.status}</dt>
                  <dd>
                    <MirrorBadge status={title.pairMirrorStatus} />
                  </dd>
                </dl>
              </div>
            )}

            <TitleEntryInfo title={title} />

            <div className="sec">
              <p className="eyebrow">{t.settlement.history}</p>
              {title.settlements.length === 0 && <p className="text-[13px] text-faint">Nenhuma baixa.</p>}
              <div className="item-list">
                {title.settlements.map((s) => (
                  <div key={s.id} className={`item${s.reversedAt ? ' opacity-60' : ''}`}>
                    <Wallet className="size-4 text-muted" />
                    <div className="grow">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                        <span className="mono">{formatDate(s.settledOn)}</span>
                        <Money cents={s.cashCents} />
                        {s.reversedAt && <Badge tone="danger">{t.settlement.reversed}</Badge>}
                        {!s.reversedAt && !s.financialAccountId && s.cashCents !== 0 && <Badge tone="warn">{t.title.pendingAccount}</Badge>}
                      </div>
                      <div className="text-[12px] text-muted">
                        {t.settlement.principal} {formatBRL(s.amountCents)}
                        {s.interestCents > 0 && ` · ${t.settlement.interest} ${formatBRL(s.interestCents)}`}
                        {s.fineCents > 0 && ` · ${t.settlement.fine} ${formatBRL(s.fineCents)}`}
                        {s.discountCents > 0 && ` · ${t.settlement.discount} ${formatBRL(s.discountCents)}`}
                        {s.financialAccountName && ` · ${s.financialAccountName}`}
                        {s.transferId && ` · via ${s.transferOtherAccountName}`}
                      </div>
                      {s.reversedAt && (
                        <div className="text-[12px] text-faint">
                          {formatDateTime(s.reversedAt)} · {s.reversalReason}
                        </div>
                      )}
                      <AttachmentsPanel target="settlement" targetId={s.id} canWrite={title.canWrite} compact />
                    </div>
                    <span className="row-actions">
                      {title.canWrite && !s.reversedAt && !s.financialAccountId && s.cashCents !== 0 && (
                        <button
                          type="button"
                          className="row-action"
                          title={t.settlement.setAccount}
                          onClick={() => setModal({ kind: 'account', id: s.id })}
                        >
                          <Wallet />
                        </button>
                      )}
                      <button
                        type="button"
                        className="row-action"
                        title={t.audit.settlementHistory}
                        aria-label={t.audit.settlementHistory}
                        onClick={() => setModal({ kind: 'history', table: 'settlements', id: s.id })}
                      >
                        <History />
                      </button>
                      {title.canWrite && !s.reversedAt && (
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.settlement.reverse}
                          onClick={() => setModal({ kind: 'reverse', id: s.id, hasTransfer: Boolean(s.transferId) })}
                        >
                          <Undo2 />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="sec">
              <p className="eyebrow">
                {t.attachments.title}
                {attachmentCount ? ` · ${attachmentCount}` : ''}
              </p>
              <AttachmentsPanel
                target="title"
                targetId={title.id}
                canWrite={title.canWrite}
                onCountChange={(count) => {
                  // Mudou com a gaveta aberta: a lista atualiza o clipe.
                  if (attachmentCount !== null && attachmentCount !== count) onChanged();
                  setAttachmentCount(count);
                }}
                pickerRef={pickFile}
              />
            </div>

            {title.canWrite && !title.archivedAt && !isInvoice && (
              <div className="sec flex flex-wrap gap-2">
                <Button size="sm" variant="danger" onClick={() => void remove('this')}>
                  <Trash2 /> {title.recurrenceRuleId ? t.title.scopeThis : t.common.delete}
                </Button>
                {title.recurrenceRuleId && (
                  <Button size="sm" variant="danger" onClick={() => void remove('following')}>
                    <Trash2 /> {t.title.scopeFollowing}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {title && modal?.kind === 'settle' && <SettlementModal title={title} onClose={() => setModal(null)} onSaved={saved} />}
      {title && modal?.kind === 'edit' && (
        <TitleFormModal caixaId={title.caixaId} direction={title.direction} title={title} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {title && modal?.kind === 'reverse' && (
        <ReverseModal settlementId={modal.id} hasTransfer={modal.hasTransfer} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {title && modal?.kind === 'account' && (
        <SetAccountModal settlementId={modal.id} caixaId={title.caixaId} onClose={() => setModal(null)} onSaved={saved} />
      )}
      {modal?.kind === 'history' && (
        <AuditHistory
          table={modal.table}
          recordId={modal.id}
          title={modal.table === 'titles' ? t.audit.titleHistory : t.audit.settlementHistory}
          onClose={() => setModal(null)}
        />
      )}
      {title && (modal?.kind === 'accept' || modal?.kind === 'dispute') && (
        <MirrorDecisionModal title={title} mode={modal.kind} onClose={() => setModal(null)} onSaved={saved} />
      )}
    </aside>
  );
}

function MirrorDecisionModal({
  title,
  mode,
  onClose,
  onSaved,
}: {
  title: TitleDetail;
  mode: 'accept' | 'dispute';
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const [categoryId, setCategoryId] = useState<string | null>(title.categoryId);
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  async function submit() {
    const next =
      mode === 'accept'
        ? await run(
            () => api.post<TitleDetail>(`/api/titles/${title.id}/mirror/accept`, { categoryId: categoryId ?? undefined }),
            'Espelho aceito.',
          )
        : await run(() => api.post<TitleDetail>(`/api/titles/${title.id}/mirror/dispute`, { reason }), 'Espelho contestado.');
    if (next) onSaved(next);
  }
  return (
    <Modal open title={mode === 'accept' ? t.title.acceptMirror : t.title.disputeMirror} onClose={onClose}>
      <div className="form-grid">
        {mode === 'accept' ? (
          <Field label={t.title.category}>
            <CategorySelect
              kind={title.direction === 'payable' ? 'expense' : 'income'}
              caixaId={title.caixaId}
              value={categoryId}
              onChange={setCategoryId}
              ariaLabel={t.title.category}
            />
          </Field>
        ) : (
          <Field label="Motivo">
            <textarea className="field" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button variant={mode === 'accept' ? 'primary' : 'danger'} disabled={busy} onClick={() => void submit()}>
          {mode === 'accept' ? t.title.acceptMirror : t.title.disputeMirror}
        </Button>
      </ModalActions>
    </Modal>
  );
}
