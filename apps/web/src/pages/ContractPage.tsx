import {
  CONTRACT_DOCUMENT_KINDS,
  type ContractDetail,
  type ContractDocumentDto,
  type ContractDocumentKind,
  type ContractMarkdownCreateInput,
  type DeleteResult,
  entityLink,
  formatAccounting,
  formatDate,
  formatDateTime,
  formatMonth,
  type SeriesDto,
  t,
  titleLink,
} from '@moneyflow/shared';
import {
  Archive,
  ArchiveRestore,
  CalendarX,
  ExternalLink,
  FilePlus,
  FileText,
  FileUp,
  GitBranchPlus,
  History,
  Link2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AuditHistory } from '../components/audit/AuditHistory';
import { AmendmentModal, RenewalModal, TerminationModal } from '../components/contracts/ContractActionModals';
import { ContractFormModal } from '../components/contracts/ContractFormModal';
import { ContractStatusBadge, termText } from '../components/contracts/ContractsTable';
import { DocumentView } from '../components/contracts/DocumentView';
import {
  calendarText,
  LinkSeriesModal,
  ObligationFormModal,
  SeriesEditModal,
  SeriesRuleEndModal,
  termsText,
} from '../components/contracts/ObligationFormModal';
import { PaymentsSection } from '../components/contracts/PaymentsSection';
import { CategoryLabel, LoadError, Money, PageHead, TitleStatusBadge } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { useCrumbs } from '../components/shell/Layout';
import { Badge, Button, EmptyRow, Field, Modal, Panel, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';
import { upload } from '../lib/upload';

type Dialog =
  | { kind: 'edit' | 'amend' | 'terminate' | 'renew' | 'history' | 'markdown' | 'addObligation' | 'linkSeries' }
  | { kind: 'editSeries' | 'endSeries'; series: SeriesDto }
  | null;
const C = t.contracts;
const O = C.obligation;

/**
 * Detalhe do contrato (spec 034): cabeçalho com a vigência e as ações
 * (editar, ativar, aditivo, renovar, rescindir, arquivar), as obrigações
 * (séries numa conta ou cobranças no cartão), os pagamentos somando as
 * obrigações, os documentos e o histórico (vigências, aditivos, rescisão).
 */
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
  const seriesSaved = () => {
    setDialog(null);
    void reload();
  };
  const live = contract.status === 'active';
  const canWrite = contract.canWrite && !contract.viaMirror;
  const current = tab ?? 'obligations';

  async function activate() {
    if (!(await confirm({ title: C.activateTitle, description: C.activateBody, confirmLabel: C.actions.activate }))) return;
    const next = await run(() => api.post<ContractDetail>(`/api/contracts/${id}/activate`), C.activated);
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

  async function unlink(series: SeriesDto) {
    if (!(await confirm({ title: O.unlinkConfirm(series.description), description: O.unlinkBody, confirmLabel: O.unlink, danger: true })))
      return;
    const done = await run(() => api.patch<SeriesDto>(`/api/series/${series.id}`, { contractId: null }), O.unlinked);
    if (done) void reload();
  }

  return (
    <div className="page wide">
      <PageHead
        title={contract.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <ContractStatusBadge row={contract} />
            <span>{C.directions[contract.direction]}</span>·<Link to={entityLink(contract.entityId)}>{contract.entityName}</Link>·
            <span>{contract.caixaName}</span>·
            <span className="mono text-xs" data-testid="contract-term">
              {termText(contract)}
            </span>
            {contract.autoRenew && <Badge tone="info">{C.fields.autoRenew}</Badge>}
            {contract.contractNumber && <span className="mono text-xs">nº {contract.contractNumber}</span>}
            {contract.archivedAt && <Badge>{t.common.archived}</Badge>}
          </span>
        }
        actions={
          canWrite && (
            <>
              {contract.status === 'draft' && (
                <Button onClick={() => void activate()} disabled={busy} data-testid="contract-activate">
                  <Play /> {C.actions.activate}
                </Button>
              )}
              {live && contract.obligations.length > 0 && (
                <Button variant="ghost" onClick={() => setDialog({ kind: 'amend' })} data-testid="contract-amend">
                  <GitBranchPlus /> {C.actions.amend}
                </Button>
              )}
              {(live || contract.status === 'ended') && contract.endsOn && (
                <Button variant="ghost" onClick={() => setDialog({ kind: 'renew' })} data-testid="contract-renew">
                  <RefreshCw /> {C.actions.renew}
                </Button>
              )}
              {live && (
                <Button variant="ghost" onClick={() => setDialog({ kind: 'terminate' })} data-testid="contract-terminate">
                  <XCircle /> {C.actions.terminate}
                </Button>
              )}
              {contract.status !== 'terminated' && (
                <Button variant="ghost" onClick={() => setDialog({ kind: 'edit' })} aria-label={t.common.edit} data-testid="contract-edit">
                  <Pencil /> {t.common.edit}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setDialog({ kind: 'history' })} aria-label={t.audit.history}>
                <History />
              </Button>
              {contract.archivedAt ? (
                <Button variant="ghost" onClick={() => void restore()} data-testid="contract-restore">
                  <ArchiveRestore /> {t.common.restore}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => void remove()}
                  aria-label={contract.status === 'draft' ? C.actions.remove : C.actions.archive}
                  title={contract.status === 'draft' ? C.actions.remove : C.actions.archive}
                  data-testid="contract-remove"
                >
                  {contract.status === 'draft' ? <Trash2 /> : <Archive />}
                </Button>
              )}
            </>
          )
        }
      />
      {contract.viaMirror && <p className="notice info mb-3">{C.readOnlyMirror}</p>}

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
          <Totals contract={contract} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <Tabs
                value={current}
                onChange={(key) => setTab(key === 'obligations' ? null : key)}
                items={[
                  { key: 'obligations', label: C.tabs.obligations, count: contract.obligations.length },
                  ...(contract.status === 'draft' ? [] : [{ key: 'payments', label: C.tabs.payments }]),
                  { key: 'documents', label: C.tabs.documents, count: contract.documents.length },
                  { key: 'history', label: C.tabs.history },
                ]}
              />
              {current === 'obligations' && (
                <Obligations
                  contract={contract}
                  canWrite={canWrite}
                  onAdd={() => setDialog({ kind: 'addObligation' })}
                  onLink={() => setDialog({ kind: 'linkSeries' })}
                  onEdit={(series) => setDialog({ kind: 'editSeries', series })}
                  onEnd={(series) => setDialog({ kind: 'endSeries', series })}
                  onUnlink={(series) => void unlink(series)}
                />
              )}
              {current === 'payments' && <PaymentsSection contract={contract} />}
              {current === 'documents' && (
                <Documents
                  contract={contract}
                  canWrite={canWrite}
                  onOpen={setDocId}
                  onNewMarkdown={() => setDialog({ kind: 'markdown' })}
                  onChanged={() => void reload()}
                />
              )}
              {current === 'history' && <ContractHistory contract={contract} />}
            </div>
            <Summary contract={contract} />
          </div>
        </>
      )}

      {dialog?.kind === 'edit' && <ContractFormModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'amend' && <AmendmentModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'terminate' && <TerminationModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'renew' && <RenewalModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'addObligation' && <ObligationFormModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'linkSeries' && <LinkSeriesModal contract={contract} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'editSeries' && <SeriesEditModal series={dialog.series} onClose={() => setDialog(null)} onSaved={seriesSaved} />}
      {dialog?.kind === 'endSeries' && <SeriesRuleEndModal series={dialog.series} onClose={() => setDialog(null)} onSaved={seriesSaved} />}
      {dialog?.kind === 'history' && (
        <AuditHistory table="contracts" recordId={contract.id} title={contract.name} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'markdown' && (
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

/** Números das obrigações: quantas, a próxima ocorrência, em aberto e vencidas. */
function Totals({ contract }: { contract: ContractDetail }) {
  const open = contract.obligations.reduce((acc, o) => acc + o.openCount, 0);
  const overdue = contract.obligations.reduce((acc, o) => acc + o.overdueCount, 0);
  const next = contract.nextOccurrence;
  const P = C.payments;
  return (
    <div className="stat-tiles" data-testid="contract-totals">
      <div className="stat-tile">
        <div className="v">{contract.obligationCount}</div>
        <div className="k">{C.fields.obligations}</div>
      </div>
      <div className="stat-tile">
        <div className="v">
          {next ? (
            <span className="text-sm">
              <span className="mono">{formatDate(next.dueDate)}</span> · <Money cents={next.amountCents} />
            </span>
          ) : (
            '—'
          )}
        </div>
        <div className="k">{next ? `${C.fields.nextOccurrence} · ${next.description}` : C.fields.nextOccurrence}</div>
      </div>
      <div className="stat-tile">
        <div className="v">{open}</div>
        <div className="k">{P.openCount}</div>
      </div>
      <div className="stat-tile">
        <div className={`v${overdue > 0 ? ' text-danger' : ''}`}>{overdue}</div>
        <div className="k">{P.overdueCount}</div>
      </div>
    </div>
  );
}

function Summary({ contract }: { contract: ContractDetail }) {
  const F = C.fields;
  const rows: [string, React.ReactNode][] = [
    [F.category, <CategoryLabel key="c" name={contract.categoryName} slot={contract.categoryColorSlot} />],
    [F.term, termText(contract)],
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
      <dl className="kv" data-testid="contract-summary">
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

/** Onde a obrigação vive: a conta (e a caixa dela) ou o cartão com a pagadora. */
function placeOf(series: SeriesDto): string {
  if (series.kind === 'card') return `${series.caixaName}${series.payerCaixaName ? ` · ${O.payerOf(series.payerCaixaName)}` : ''}`;
  return series.accountName ? `${series.accountName} (${series.caixaName})` : series.caixaName;
}

function Obligations({
  contract,
  canWrite,
  onAdd,
  onLink,
  onEdit,
  onEnd,
  onUnlink,
}: {
  contract: ContractDetail;
  canWrite: boolean;
  onAdd: () => void;
  onLink: () => void;
  onEdit: (series: SeriesDto) => void;
  onEnd: (series: SeriesDto) => void;
  onUnlink: (series: SeriesDto) => void;
}) {
  const navigate = useNavigate();
  const live = contract.status === 'active';
  return (
    <div className="grid gap-4" data-testid="contract-obligations">
      {canWrite && live && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onAdd} data-testid="contract-add-obligation">
            <Plus /> {C.actions.addObligation}
          </Button>
          <Button size="sm" variant="ghost" onClick={onLink} data-testid="contract-link-series">
            <Link2 /> {C.actions.linkSeries}
          </Button>
        </div>
      )}
      {contract.withoutAccount > 0 && (
        <p className="notice warn" data-testid="contract-without-account">
          {O.noAccount} ({O.withoutAccount(contract.withoutAccount)})
        </p>
      )}
      {contract.status === 'draft' && <p className="hint">{C.draftNoObligations}</p>}
      {contract.status !== 'draft' && contract.obligations.length === 0 && <p className="hint">{C.noObligations}</p>}
      {contract.obligations.length > 0 && (
        <ul className="item-list">
          {contract.obligations.map((s) => {
            const ended = Boolean(s.endsOn && !s.next && s.openCount === 0);
            return (
              <li key={s.id} className={`item${ended ? ' is-off' : ''}`} data-testid="obligation-row" data-kind={s.kind}>
                <span className="grow min-w-0">
                  <span className="row-title flex flex-wrap items-center gap-2">
                    {s.description}
                    <Badge tone="outline">{O.kinds[s.kind]}</Badge>
                    {ended && <Badge>{O.ended}</Badge>}
                    {s.withoutAccount > 0 && (
                      <Badge tone="warn" title={O.noAccount}>
                        {O.withoutAccount(s.withoutAccount)}
                      </Badge>
                    )}
                  </span>
                  <span className="row-sub">
                    {placeOf(s)} · {s.categoryName}
                  </span>
                  <span className="row-sub">
                    {calendarText(s)} · {O.period(formatDate(s.startsOn), s.endsOn ? formatDate(s.endsOn) : null)}
                  </span>
                  <span className="row-sub" data-testid="obligation-terms-summary">
                    {termsText(s.terms)}
                  </span>
                  {s.next && (
                    <span className="row-sub" data-testid="obligation-next">
                      {O.next(formatDate(s.next.dueDate), formatAccounting(s.next.amountCents))}
                      {(s.openCount > 0 || s.overdueCount > 0) && ` · ${O.counts(s.openCount, s.overdueCount)}`}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Money cents={s.amountCents} />
                  {s.next?.titleId && (
                    <button
                      type="button"
                      className="row-action"
                      title={O.openNext}
                      aria-label={`${O.openNext}: ${s.description}`}
                      onClick={() => navigate(titleLink({ id: s.next!.titleId!, caixaId: s.caixaId, direction: s.direction }))}
                    >
                      <ExternalLink />
                    </button>
                  )}
                  {canWrite && s.canWrite && (
                    <>
                      <button
                        type="button"
                        className="row-action"
                        title={O.edit}
                        aria-label={`${O.edit}: ${s.description}`}
                        onClick={() => onEdit(s)}
                        data-testid="obligation-edit"
                      >
                        <Pencil />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={O.endAction}
                        aria-label={`${O.endAction}: ${s.description}`}
                        onClick={() => onEnd(s)}
                        data-testid="obligation-end"
                      >
                        <CalendarX />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={O.unlink}
                        aria-label={`${O.unlink}: ${s.description}`}
                        onClick={() => onUnlink(s)}
                        data-testid="obligation-unlink"
                      >
                        <Unlink />
                      </button>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {contract.extraTitles.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{C.extraTitles}</h3>
          <div className="table-wrap">
            <table className="data" data-testid="contract-extra-titles">
              <thead>
                <tr>
                  <th>{O.description}</th>
                  <th>{C.columns.competence}</th>
                  <th>{C.columns.due}</th>
                  <th className="num">{C.columns.amount}</th>
                  <th className="num">{C.columns.settled}</th>
                  <th className="num">{C.columns.open}</th>
                  <th>{C.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {contract.extraTitles.map((row) => (
                  <tr
                    key={row.titleId}
                    className={`cursor-pointer${row.archived || row.status === 'canceled' ? ' is-off' : ''}`}
                    onClick={() => navigate(titleLink({ id: row.titleId, caixaId: row.caixaId, direction: row.direction }))}
                  >
                    <td>{row.description}</td>
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
                      <TitleStatusBadge title={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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

/** Valor de uma mudança do aditivo, legível. */
function changeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key.endsWith('Cents') && typeof value === 'number') return formatAccounting(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Histórico: vigências (as antigas com o resumo do ciclo), aditivos, rescisão e as tarefas de renovação antigas. */
function ContractHistory({ contract }: { contract: ContractDetail }) {
  const A = C.amendment;
  const R = C.renewal;
  const H = C.history;
  const nameOf = (ruleId: string) => contract.obligations.find((o) => o.id === ruleId)?.description ?? ruleId.slice(0, 8);
  return (
    <div className="grid gap-5" data-testid="contract-history">
      <section>
        <h3 className="mb-2 text-sm font-semibold">{H.cycles}</h3>
        <ul className="item-list" data-testid="contract-cycles">
          {contract.cycles.map((cycle) => (
            <li key={cycle.id} className="item">
              <span className="grow min-w-0">
                <span className="row-title">
                  {C.cycleLabel(cycle.seq)} · {C.termRange(formatDate(cycle.startsOn), cycle.endsOn ? formatDate(cycle.endsOn) : null)}
                </span>
                {cycle.legacy && (
                  <span className="row-sub">
                    {C.legacyCycle(
                      cycle.legacy.installmentsCount,
                      C.periodicities[cycle.legacy.periodicity] ?? cycle.legacy.periodicity,
                      formatAccounting(cycle.legacy.totalCents),
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{A.history}</h3>
        {contract.amendments.length === 0 ? (
          <p className="hint">{A.noHistory}</p>
        ) : (
          <ul className="item-list" data-testid="contract-amendments">
            {contract.amendments.map((a) => {
              const keys = Object.keys(a.changes.after).filter(
                (key) => !(key.endsWith('Id') && `${key.slice(0, -2)}Name` in a.changes.after),
              );
              return (
                <li key={a.id} className="item">
                  <span className="grow min-w-0">
                    <span className="row-title flex flex-wrap items-center gap-2">
                      {formatDate(a.effectiveOn)}
                      {a.cycleSeq !== null && <span className="text-faint text-xs">{C.cycleLabel(a.cycleSeq)}</span>}
                      {a.documentTitle && <Badge tone="outline">{a.documentTitle}</Badge>}
                    </span>
                    {a.ruleIds.length > 0 && (
                      <span className="row-sub">
                        {A.obligations}: {a.ruleIds.map(nameOf).join(', ')}
                      </span>
                    )}
                    <span className="row-sub">
                      {keys
                        .map(
                          (key) =>
                            `${A.changeLabels[key] ?? key}: ${changeValue(key, a.changes.before[key])} → ${changeValue(key, a.changes.after[key])}`,
                        )
                        .join(' · ')}
                    </span>
                    <span className="row-sub">
                      {A.affected(a.affectedCount)}
                      {a.skippedCount > 0 && ` · ${A.skipped(a.skippedCount)}`} · {a.createdByName ?? '—'} · {formatDateTime(a.createdAt)}
                      {a.notes ? ` · ${a.notes}` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {contract.terminatedOn && (
        <section data-testid="contract-termination">
          <h3 className="mb-2 text-sm font-semibold">{H.termination}</h3>
          <p className="text-sm">{H.terminatedOn(formatDate(contract.terminatedOn))}</p>
          {contract.terminationNotes && <p className="hint whitespace-pre-wrap">{contract.terminationNotes}</p>}
        </section>
      )}

      {contract.renewalTasks.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{R.tasks}</h3>
          <ul className="item-list">
            {contract.renewalTasks.map((task) => (
              <li key={task.id} className="item">
                <span className="grow min-w-0">
                  <span className="row-title">
                    {C.cycleLabel(task.cycleSeq)} · {formatDate(task.openedOn)} – {formatDate(task.dueOn)}
                  </span>
                  <span className="row-sub">
                    {task.decidedAt ? R.decidedBy(task.decidedByName ?? '—', formatDateTime(task.decidedAt)) : '—'}
                    {task.decisionNotes ? ` · ${task.decisionNotes}` : ''}
                  </span>
                </span>
                <Badge tone={task.status === 'approved' ? 'ok' : 'neutral'}>{R.taskStatuses[task.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
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
