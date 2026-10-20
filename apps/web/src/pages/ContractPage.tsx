import {
  CONTRACT_DOCUMENT_KINDS,
  type ContractCycleDto,
  type ContractDetail,
  type ContractDocumentDto,
  type ContractDocumentKind,
  type ContractInstallmentDto,
  type ContractMarkdownCreateInput,
  cycleSchedule,
  type DeleteResult,
  entityLink,
  formatAccounting,
  formatDate,
  formatDateTime,
  formatMonth,
  t,
  titleLink,
} from '@moneyflow/shared';
import {
  Archive,
  ArchiveRestore,
  Ban,
  FilePlus,
  FileText,
  FileUp,
  GitBranchPlus,
  History,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AuditHistory } from '../components/audit/AuditHistory';
import { AmendmentModal, RenewalModal, TerminationModal } from '../components/contracts/ContractActionModals';
import { ContractFormModal } from '../components/contracts/ContractFormModal';
import { ContractStatusBadge } from '../components/contracts/ContractsTable';
import { DocumentView } from '../components/contracts/DocumentView';
import { PaymentsSection } from '../components/contracts/PaymentsSection';
import { PlannedAccountButton, PlannedAccountLabel } from '../components/contracts/PlannedAccount';
import { CategoryLabel, LoadError, Money, PageHead, TitleStatusBadge } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { useCrumbs } from '../components/shell/Layout';
import { Badge, Button, EmptyRow, Field, Modal, Panel, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';
import { upload } from '../lib/upload';

type Dialog = 'edit' | 'amend' | 'terminate' | 'renew' | 'history' | 'markdown' | null;
const C = t.contracts;

/** Detalhe do contrato (spec 020): ciclos, parcelas, documentos, aditivos, renovação e realizado × contratado. */
export function ContractPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: contract, error, reload, setData } = useApi<ContractDetail>(`/api/contracts/${id}`);
  const [tab, setTab] = useParamState('tab');
  const [docId, setDocId] = useParamState('doc');
  const [dialog, setDialog] = useState<Dialog>(null);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  useCrumbs(contract ? [{ label: contract.name }] : []);
  useAgentScreenContext(contract ? { title: contract.name, record: { kind: 'contract', id: contract.id, label: contract.name } } : null);

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  if (!contract) return <div className="page wide">{t.common.loading}</div>;

  const saved = (next: ContractDetail) => {
    setData(next);
    setDialog(null);
  };
  const live = contract.status === 'active' || contract.status === 'renewal_pending';
  const canWrite = contract.canWrite;
  const current = contract.cycles.find((c) => c.id === contract.currentCycle?.id) ?? contract.cycles[0] ?? null;
  const openTask = contract.renewalTasks.find((k) => k.status === 'open') ?? null;

  async function activate() {
    const count = current?.installmentsCount ?? 0;
    if (!(await confirm({ title: C.activateTitle, description: C.activateBody(count), confirmLabel: C.actions.activate }))) return;
    const next = await run(() => api.post<ContractDetail>(`/api/contracts/${id}/activate`), C.activated(count));
    if (next) setData(next);
  }

  async function decline() {
    const end = contract!.cycles[0]?.endsOn ?? '';
    if (
      !(await confirm({
        title: C.renewal.declineTitle,
        description: C.renewal.declineBody(formatDate(end)),
        confirmLabel: C.actions.decline,
        danger: true,
      }))
    )
      return;
    const next = await run(() => api.post<ContractDetail>(`/api/contracts/${id}/decline-renewal`, {}), C.renewal.declined);
    if (next) setData(next);
  }

  async function remove() {
    if (
      !(await confirm({ title: C.removeConfirm(contract!.name), description: C.removeBody, confirmLabel: t.common.remove, danger: true }))
    )
      return;
    const result = await run(
      () => api.del<DeleteResult>(`/api/contracts/${id}`),
      (r) => (r.deleted ? C.removed : C.archived),
    );
    if (result?.deleted) navigate('/contracts');
    else if (result) void reload();
  }

  async function restore() {
    const next = await run(() => api.post<ContractDetail>(`/api/contracts/${id}/restore`), C.restored);
    if (next) setData(next);
  }

  return (
    <div className="page wide">
      <PageHead
        title={contract.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <ContractStatusBadge row={contract} />
            <span>{C.directions[contract.direction]}</span>·<Link to={entityLink(contract.entityId)}>{contract.entityName}</Link>·
            <span>{contract.caixaName}</span>
            {contract.contractNumber && <span className="mono text-xs">nº {contract.contractNumber}</span>}
            {contract.archivedAt && <Badge>{t.common.archived}</Badge>}
          </span>
        }
        actions={
          canWrite && (
            <>
              {contract.status === 'draft' && (
                <Button onClick={() => void activate()} disabled={busy}>
                  <Play /> {C.actions.activate}
                </Button>
              )}
              {live && (
                <Button variant="ghost" onClick={() => setDialog('amend')}>
                  <GitBranchPlus /> {C.actions.amend}
                </Button>
              )}
              {(live || contract.status === 'ended') && (
                <Button variant={openTask ? 'primary' : 'ghost'} onClick={() => setDialog('renew')}>
                  <RefreshCw /> {C.actions.renew}
                </Button>
              )}
              {live && (
                <Button variant="ghost" onClick={() => setDialog('terminate')}>
                  <XCircle /> {C.actions.terminate}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setDialog('edit')} aria-label={t.common.edit}>
                <Pencil /> {t.common.edit}
              </Button>
              <Button variant="ghost" onClick={() => setDialog('history')} aria-label={t.audit.history}>
                <History />
              </Button>
              {contract.archivedAt ? (
                <Button variant="ghost" onClick={() => void restore()}>
                  <ArchiveRestore /> {t.common.restore}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => void remove()} aria-label={t.common.remove}>
                  {contract.status === 'draft' ? <Trash2 /> : <Archive />}
                </Button>
              )}
            </>
          )
        }
      />
      {contract.viaMirror && <p className="notice info mb-3">{C.readOnlyMirror}</p>}
      {openTask && (
        <div className={`notice ${openTask.overdue ? 'danger' : 'warn'} mb-4 flex flex-wrap items-center gap-3`}>
          <span className="flex-1">
            {openTask.overdue
              ? C.renewal.taskOverdue(formatDate(openTask.dueOn))
              : `${C.renewal.taskOpen(formatDate(openTask.openedOn))} ${C.renewal.taskDue(formatDate(openTask.dueOn))}`}
          </span>
          {canWrite && (
            <>
              <Button size="sm" onClick={() => setDialog('renew')}>
                {C.renewal.approve}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void decline()}>
                <Ban /> {C.actions.decline}
              </Button>
            </>
          )}
        </div>
      )}

      {docId ? (
        <DocumentView
          documentId={docId}
          canWrite={canWrite}
          onBack={() => setDocId(null)}
          onChanged={() => void reload()}
          onOpen={(next) => setDocId(next)}
        />
      ) : (
        <>
          {current && <Totals cycle={current} direction={contract.direction} />}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <Tabs
                value={tab ?? 'installments'}
                onChange={(key) => setTab(key === 'installments' ? null : key)}
                items={[
                  { key: 'installments', label: C.tabs.installments },
                  ...(contract.status === 'draft' ? [] : [{ key: 'payments', label: C.payments.tab }]),
                  { key: 'documents', label: C.tabs.documents, count: contract.documents.length },
                  { key: 'amendments', label: C.tabs.amendments, count: contract.amendments.length },
                  { key: 'renewal', label: C.tabs.renewal, count: contract.renewalTasks.length },
                ]}
              />
              {(tab ?? 'installments') === 'installments' && <Installments contract={contract} onChanged={() => void reload()} />}
              {tab === 'payments' && <PaymentsSection contract={contract} onChanged={() => void reload()} />}
              {tab === 'documents' && (
                <Documents
                  contract={contract}
                  canWrite={canWrite}
                  onOpen={setDocId}
                  onNewMarkdown={() => setDialog('markdown')}
                  onChanged={() => void reload()}
                />
              )}
              {tab === 'amendments' && <Amendments contract={contract} />}
              {tab === 'renewal' && (
                <Renewals contract={contract} canWrite={canWrite} onRenew={() => setDialog('renew')} onDecline={() => void decline()} />
              )}
            </div>
            <Summary contract={contract} />
          </div>
        </>
      )}

      {dialog === 'edit' && <ContractFormModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'amend' && <AmendmentModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'terminate' && <TerminationModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'renew' && <RenewalModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'history' && (
        <AuditHistory table="contracts" recordId={contract.id} title={contract.name} onClose={() => setDialog(null)} />
      )}
      {dialog === 'markdown' && (
        <NewMarkdownModal
          contractId={contract.id}
          onClose={() => setDialog(null)}
          onCreated={(doc) => {
            setDialog(null);
            void reload();
            setDocId(doc.id);
          }}
        />
      )}
    </div>
  );
}

/** Realizado × contratado do ciclo atual. */
function Totals({ cycle, direction }: { cycle: ContractCycleDto; direction: 'receivable' | 'payable' }) {
  const T = C.totals;
  const tiles = [
    { label: T.contracted, cents: cycle.totals.contractedCents },
    { label: direction === 'receivable' ? T.settledReceivable : T.settledPayable, cents: cycle.totals.settledCents },
    { label: T.open, cents: cycle.totals.openCents },
    { label: T.overdue, cents: cycle.totals.overdueCents },
  ];
  return (
    <div className="stat-tiles" aria-label={T.title}>
      {tiles.map((tile) => (
        <div key={tile.label} className="stat-tile">
          <div className="v">
            <Money cents={tile.cents} muted={tile.cents === 0} />
          </div>
          <div className="k">{tile.label}</div>
        </div>
      ))}
    </div>
  );
}

function Summary({ contract }: { contract: ContractDetail }) {
  const F = C.fields;
  const cycle = contract.currentCycle;
  const rows: [string, React.ReactNode][] = [
    [F.category, <CategoryLabel key="c" name={contract.categoryName} slot={contract.categoryColorSlot} />],
    ...(cycle
      ? ([
          [F.currentCycle, C.cycleRange(formatDate(cycle.startsOn), formatDate(cycle.endsOn))],
          [F.periodicity, C.installmentsSummary(cycle.installmentsCount, C.periodicities[cycle.periodicity]!)],
          [F.cycleValue, <Money key="v" cents={cycle.totalCents} />],
          [F.dueDay, C.dueRule(cycle.dueDay, cycle.dueMonthOffset)],
        ] as [string, React.ReactNode][])
      : []),
    [F.autoRenew, contract.autoRenew ? t.common.yes : t.common.no],
    [
      F.noticeDays,
      contract.noticeDeadline ? `${contract.noticeDays} · ${formatDate(contract.noticeDeadline)}` : String(contract.noticeDays),
    ],
    [
      F.readjustmentIndex,
      `${C.indexes[contract.readjustmentIndex]}${contract.nextReadjustment ? ` · ${formatDate(contract.nextReadjustment)}` : ''}`,
    ],
    ...(contract.counterpartyCaixaName ? ([[F.mirrorCaixa, contract.counterpartyCaixaName]] as [string, React.ReactNode][]) : []),
    ...(contract.paymentAccountId
      ? ([
          [
            C.payment.account,
            `${contract.paymentAccountName ?? '—'}${contract.paymentAccountCaixaId !== contract.caixaId && contract.paymentAccountCaixaName ? ` (${contract.paymentAccountCaixaName})` : ''}`,
          ],
          ...(contract.transitAccountId ? [[C.payment.transit, contract.transitAccountName ?? '—']] : []),
        ] as [string, React.ReactNode][])
      : []),
    ...(contract.lateFeePercent || contract.interestMonthPercent || contract.earlyDiscountPercent
      ? ([
          [
            C.payments.charges,
            [
              contract.lateFeePercent ? `${C.payment.lateFee}: ${contract.lateFeePercent}` : null,
              contract.interestMonthPercent ? `${C.payment.interest}: ${contract.interestMonthPercent}` : null,
              contract.earlyDiscountPercent ? `${C.payment.discount}: ${contract.earlyDiscountPercent}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          ],
        ] as [string, React.ReactNode][])
      : []),
    ...(contract.autoSettle ? ([[C.payment.autoSettle, t.common.yes]] as [string, React.ReactNode][]) : []),
    ...(contract.terminationPenaltyText || contract.terminationPenaltyCents
      ? ([
          [
            C.termination.penaltyRecorded,
            <span key="p">
              {contract.terminationPenaltyText}
              {contract.terminationPenaltyCents ? (
                <>
                  {' '}
                  <Money cents={contract.terminationPenaltyCents} />
                </>
              ) : null}
            </span>,
          ],
        ] as [string, React.ReactNode][])
      : []),
    ...(contract.terminatedOn ? ([[C.termination.terminatedOn, formatDate(contract.terminatedOn)]] as [string, React.ReactNode][]) : []),
  ];
  return (
    <Panel title={C.contract} icon={<FileText />}>
      <dl className="kv">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {contract.notes && <p className="hint mt-3 whitespace-pre-wrap">{contract.notes}</p>}
    </Panel>
  );
}

function InstallmentRows({ rows, canWrite, onChanged }: { rows: ContractInstallmentDto[]; canWrite: boolean; onChanged: () => void }) {
  const navigate = useNavigate();
  const H = C.columns;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{H.installment}</th>
            <th>{H.competence}</th>
            <th>{H.due}</th>
            <th className="num">{H.amount}</th>
            <th className="num">{H.settled}</th>
            <th className="num">{H.open}</th>
            <th>{C.payment.plannedAccount}</th>
            <th>{H.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8}>{C.noInstallments}</EmptyRow>}
          {rows.map((row) => (
            <tr
              key={row.titleId}
              className={`cursor-pointer${row.archived || row.status === 'canceled' ? ' is-off' : ''}`}
              onClick={() => navigate(titleLink({ id: row.titleId, caixaId: row.caixaId, direction: row.direction }))}
            >
              <td className="mono">{row.installment ?? '—'}</td>
              <td className="mono">{formatMonth(row.competenceDate)}</td>
              <td className="mono">{formatDate(row.dueDate)}</td>
              <td className="num">
                <Money cents={row.amountCents} />
              </td>
              <td className="num">
                <Money cents={row.settledCents} muted={row.settledCents === 0} />
              </td>
              <td className="num">
                <Money cents={row.openCents} muted={row.openCents === 0} />
              </td>
              <td>
                <span className="inline-flex items-center gap-1">
                  <PlannedAccountLabel planned={row} />
                  {canWrite && !row.archived && (row.status === 'open' || row.status === 'partial') && (
                    <PlannedAccountButton title={row} onSaved={onChanged} />
                  )}
                </span>
              </td>
              <td>
                <TitleStatusBadge title={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Installments({ contract, onChanged }: { contract: ContractDetail; onChanged: () => void }) {
  if (contract.status === 'draft') {
    const cycle = contract.cycles[0];
    const preview = cycle ? cycleSchedule(cycle) : [];
    return (
      <>
        <p className="hint mb-2">{C.noInstallments}</p>
        <h3 className="mb-2 text-sm font-semibold">{C.draftPreview}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{C.columns.installment}</th>
                <th>{C.columns.competence}</th>
                <th>{C.columns.due}</th>
                <th className="num">{C.columns.amount}</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.installment}>
                  <td className="mono">
                    {row.installment}/{preview.length}
                  </td>
                  <td className="mono">{formatMonth(row.competenceDate)}</td>
                  <td className="mono">{formatDate(row.dueDate)}</td>
                  <td className="num">
                    <Money cents={row.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  const [latest, ...previous] = contract.cycles;
  return (
    <div className="grid gap-4">
      {latest && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">
            {C.cycleLabel(latest.seq)} · {C.cycleRange(formatDate(latest.startsOn), formatDate(latest.endsOn))}
          </h3>
          <InstallmentRows rows={latest.installments} canWrite={contract.canWrite} onChanged={onChanged} />
        </section>
      )}
      {contract.extraTitles.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{C.extraTitles}</h3>
          <InstallmentRows rows={contract.extraTitles} canWrite={contract.canWrite} onChanged={onChanged} />
        </section>
      )}
      {previous.length > 0 && <h3 className="text-sm font-semibold">{C.previousCycles}</h3>}
      {previous.map((cycle) => (
        <details key={cycle.id} className="well">
          <summary className="cursor-pointer text-sm">
            {C.cycleLabel(cycle.seq)} · {C.cycleRange(formatDate(cycle.startsOn), formatDate(cycle.endsOn))} ·{' '}
            <Money cents={cycle.totals.contractedCents} />
          </summary>
          <div className="mt-2">
            <InstallmentRows rows={cycle.installments} canWrite={contract.canWrite} onChanged={onChanged} />
          </div>
        </details>
      ))}
    </div>
  );
}

function Documents({
  contract,
  canWrite,
  onOpen,
  onNewMarkdown,
  onChanged,
}: {
  contract: ContractDetail;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onNewMarkdown: () => void;
  onChanged: () => void;
}) {
  const D = C.documents;
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ContractDocumentKind>('contract');
  const { run, busy } = useAction();

  async function send(file: File) {
    const doc = await run(() => upload<ContractDocumentDto>(`/api/contracts/${contract.id}/documents`, file, { kind }), D.uploaded);
    if (doc) {
      onChanged();
      onOpen(doc.id);
    }
  }

  return (
    <div>
      {canWrite && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            className="field field-auto"
            value={kind}
            onChange={(e) => setKind(e.target.value as ContractDocumentKind)}
            aria-label={D.kind}
          >
            {CONTRACT_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {D.kinds[k]}
              </option>
            ))}
          </select>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf,.md,.markdown,text/markdown"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void send(file);
            }}
          />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()} title={D.uploadHint}>
            <FileUp /> {D.upload}
          </Button>
          <Button size="sm" variant="ghost" onClick={onNewMarkdown}>
            <FilePlus /> {D.newMarkdown}
          </Button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{D.docTitle}</th>
              <th>{D.kind}</th>
              <th>{D.documentDate}</th>
              <th>{D.versions}</th>
            </tr>
          </thead>
          <tbody>
            {contract.documents.length === 0 && <EmptyRow colSpan={4}>{D.empty}</EmptyRow>}
            {contract.documents.map((doc) => (
              <tr key={doc.id} className="cursor-pointer" onClick={() => onOpen(doc.id)}>
                <td>
                  <span className="row-title">{doc.title}</span>
                  <span className="row-sub">{doc.format === 'pdf' ? (doc.fileName ?? 'PDF') : D.formats.markdown}</span>
                </td>
                <td>
                  <Badge tone="outline">{D.kinds[doc.kind]}</Badge>
                </td>
                <td className="mono text-xs">{doc.documentDate ? formatDate(doc.documentDate) : '—'}</td>
                <td className="text-xs">
                  {doc.format === 'pdf' ? (
                    <Badge tone="info">PDF</Badge>
                  ) : doc.currentVersion ? (
                    D.editedAt(doc.currentVersion, doc.lastEditedAt ? formatDate(doc.lastEditedAt.slice(0, 10)) : '')
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Amendments({ contract }: { contract: ContractDetail }) {
  const A = C.amendment;
  if (contract.amendments.length === 0) return <p className="hint">{A.noHistory}</p>;
  const show = (key: string, value: unknown) =>
    value === null || value === undefined
      ? '—'
      : key.endsWith('Cents')
        ? formatAccounting(Number(value))
        : key === 'dueMonthOffset'
          ? C.offsets[Number(value)]
          : String(value);
  return (
    <ul className="item-list">
      {contract.amendments.map((a) => (
        <li key={a.id} className="item">
          <span className="grow min-w-0">
            <span className="row-title">
              {formatDate(a.effectiveOn)} · {C.cycleLabel(a.cycleSeq)} {a.documentTitle && <Badge tone="outline">{a.documentTitle}</Badge>}
            </span>
            <span className="row-sub">
              {Object.keys(a.changes.after)
                .filter((key) => key !== 'categoryId')
                .map((key) => `${A.changeLabels[key] ?? key}: ${show(key, a.changes.before[key])} → ${show(key, a.changes.after[key])}`)
                .join(' · ')}
            </span>
            <span className="row-sub">
              {A.affected(a.affectedCount)}
              {a.skippedCount > 0 && ` · ${A.skipped(a.skippedCount)}`} · {a.createdByName ?? '—'} · {formatDateTime(a.createdAt)}
              {a.notes ? ` · ${a.notes}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Renewals({
  contract,
  canWrite,
  onRenew,
  onDecline,
}: {
  contract: ContractDetail;
  canWrite: boolean;
  onRenew: () => void;
  onDecline: () => void;
}) {
  const R = C.renewal;
  const live = contract.status === 'active' || contract.status === 'renewal_pending';
  return (
    <div>
      {!contract.autoRenew && live && <p className="hint mb-3">{R.manualHint}</p>}
      {canWrite && (live || contract.status === 'ended') && (
        <div className="mb-3 flex gap-2">
          <Button size="sm" onClick={onRenew}>
            <RefreshCw /> {C.actions.renew}
          </Button>
          {live && (
            <Button size="sm" variant="ghost" onClick={onDecline}>
              <Ban /> {C.actions.decline}
            </Button>
          )}
        </div>
      )}
      {contract.renewalTasks.length === 0 ? (
        <p className="hint">{R.noTask}</p>
      ) : (
        <ul className="item-list">
          {contract.renewalTasks.map((task) => (
            <li key={task.id} className="item">
              <span className="grow min-w-0">
                <span className="row-title">
                  {C.cycleLabel(task.cycleSeq)} · {R.taskOpen(formatDate(task.openedOn))}
                </span>
                <span className="row-sub">
                  {R.taskDue(formatDate(task.dueOn))}
                  {task.decidedAt && ` · ${R.decidedBy(task.decidedByName ?? '—', formatDateTime(task.decidedAt))}`}
                  {task.decisionNotes ? ` · ${task.decisionNotes}` : ''}
                </span>
              </span>
              <Badge tone={task.status === 'open' ? (task.overdue ? 'danger' : 'warn') : task.status === 'approved' ? 'ok' : 'neutral'}>
                {R.taskStatuses[task.status]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewMarkdownModal({
  contractId,
  onClose,
  onCreated,
}: {
  contractId: string;
  onClose: () => void;
  onCreated: (doc: ContractDocumentDto) => void;
}) {
  const D = C.documents;
  const [kind, setKind] = useState<ContractDocumentKind>('contract');
  const [title, setTitle] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError(D.docTitle);
    const body: ContractMarkdownCreateInput = { kind, title, documentDate: documentDate || null, content: '' };
    const doc = await run(() => api.post<ContractDocumentDto>(`/api/contracts/${contractId}/documents/markdown`, body), D.saved);
    if (doc) onCreated(doc);
  }

  return (
    <Modal open title={D.newMarkdown} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            <Field label={D.docTitle} className="span-all">
              <input
                className="field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                aria-label={D.docTitle}
                autoFocus
              />
            </Field>
            <Field label={D.kind}>
              <select className="field" value={kind} onChange={(e) => setKind(e.target.value as ContractDocumentKind)} aria-label={D.kind}>
                {CONTRACT_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {D.kinds[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={D.documentDate}>
              <input
                className="field"
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
                aria-label={D.documentDate}
              />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {t.common.create}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
