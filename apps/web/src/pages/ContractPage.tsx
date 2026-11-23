import { type ContractDetail, type DeleteResult, entityLink, type SeriesDto, t } from '@moneyflow/shared';
import { Archive, ArchiveRestore, GitBranchPlus, History, Pencil, Play, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AuditHistory } from '../components/audit/AuditHistory';
import { AmendmentModal } from '../components/contracts/AmendmentModal';
import { RenewalModal, TerminationModal } from '../components/contracts/ContractActionModals';
import { ContractDocuments, NewMarkdownModal } from '../components/contracts/ContractDocuments';
import { ContractFormModal } from '../components/contracts/ContractFormModal';
import { ContractHistory } from '../components/contracts/ContractHistory';
import { ContractObligations } from '../components/contracts/ContractObligations';
import { ContractSummary, ContractTotals } from '../components/contracts/ContractSummary';
import { ContractStatusBadge, termText } from '../components/contracts/ContractsTable';
import { DocumentView } from '../components/contracts/DocumentView';
import { LinkSeriesModal } from '../components/contracts/LinkSeriesModal';
import { ObligationFormModal } from '../components/contracts/ObligationFormModal';
import { PaymentsSection } from '../components/contracts/PaymentsSection';
import { LoadError, PageHead } from '../components/domain';
import { SeriesEditModal } from '../components/series/SeriesEditModal';
import { SeriesRuleEndModal } from '../components/series/SeriesRuleEndModal';
import { useCrumbs } from '../components/shell/Layout';
import { Badge, Button, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

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
            {contract.contractNumber && <span className="mono text-xs">{C.numberShort(contract.contractNumber)}</span>}
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
          <ContractTotals contract={contract} />
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
                <ContractObligations
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
                <ContractDocuments
                  contract={contract}
                  canWrite={canWrite}
                  onOpen={setDocId}
                  onNewMarkdown={() => setDialog({ kind: 'markdown' })}
                  onChanged={() => void reload()}
                />
              )}
              {current === 'history' && <ContractHistory contract={contract} />}
            </div>
            <ContractSummary contract={contract} />
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
