import { type CardOverview, formatDate, formatDateTime, type StatementImportSummary, t } from '@moneyflow/shared';
import { Download, FileUp, Trash2 } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { useParamState, useSetParams } from '../../lib/params';
import { attachmentUrl } from '../../lib/upload';
import { LoadError, SkelRows } from '../domain';
import { Badge, Button, cx, EmptyRow, useConfirm } from '../ui';
import { BalanceCompare, ImportDetail, type SuggestionRun } from './ImportDetail';
import { ImportModal, type StatementTarget } from './ImportModal';
import '../../styles/reconciliation.css';

const s = t.statements;

/** Import de extrato/fatura e conciliação de uma conta ou cartão (spec 009). */
export function StatementImportPanel({
  caixaId,
  accountId,
  cardCaixaId,
  canWrite,
  onChanged,
}: {
  caixaId: string;
  accountId?: string | null;
  cardCaixaId?: string | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const target: StatementTarget | null = accountId ? { accountId } : cardCaixaId ? { cardCaixaId } : null;
  const query = accountId ? `accountId=${accountId}` : `cardCaixaId=${cardCaixaId}`;
  const imports = useApi<StatementImportSummary[]>(target ? `/api/statement-imports?${query}` : null);
  const card = useApi<CardOverview>(cardCaixaId ? `/api/cards/${cardCaixaId}` : null);
  const [importId, setImportId] = useParamState('import');
  const setParams = useSetParams();
  const [importing, setImporting] = useState<{ file: File | null } | null>(null);
  // A sugestão do agente enfileirada pelo import que acabou de abrir (só para esse lote).
  const [suggestion, setSuggestion] = useState<(SuggestionRun & { importId: string }) | null>(null);
  const [over, setOver] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();
  const isCard = Boolean(cardCaixaId);
  const label = isCard ? s.importInvoice : s.importStatement;

  useRegisterCommands(
    canWrite && target
      ? [{ id: 'statement-import', label, group: 'Criar', icon: <FileUp />, run: () => setImporting({ file: null }) }]
      : [],
    [canWrite, accountId, cardCaixaId],
  );

  const changed = () => {
    void imports.reload();
    onChanged();
  };

  async function remove(row: StatementImportSummary) {
    const ok = await confirm({
      title: s.deleteImportTitle(row.fileName),
      description: s.deleteImportBody,
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (ok && (await run(() => api.del(`/api/statement-imports/${row.id}`), s.importDeleted))) changed();
  }

  if (!target) return null;

  if (importId) {
    return (
      <ImportDetail
        key={importId}
        importId={importId}
        caixaId={caixaId}
        card={card.data ?? null}
        onBack={() => setParams({ import: null, lines: null })}
        onChanged={changed}
        suggestionRun={suggestion?.importId === importId ? suggestion : null}
      />
    );
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && canWrite) setImporting({ file });
  };

  return (
    <div
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="rec-bar">
        <h2 className="text-h3 !mb-0">{s.imports}</h2>
        <span className="flex-1" />
        {canWrite && (
          <Button onClick={() => setImporting({ file: null })}>
            <FileUp /> {label}
          </Button>
        )}
      </div>

      {imports.error ? (
        <LoadError error={imports.error} onRetry={() => void imports.reload()} />
      ) : (
        <div className={cx('table-wrap', over && 'rec-over')}>
          <table className="data">
            <thead>
              <tr>
                <th>{s.file}</th>
                <th>{s.period}</th>
                <th className="num">{s.lines}</th>
                <th>{t.common.status}</th>
                <th>
                  {s.bankBalance} × {s.appBalance.toLowerCase()}
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!imports.data && <SkelRows cols={6} />}
              {imports.data?.length === 0 && <EmptyRow colSpan={6}>{isCard ? s.noImportsCard : s.noImports}</EmptyRow>}
              {imports.data?.map((row) => (
                <tr key={row.id} className="cursor-pointer" onClick={() => setImportId(row.id)}>
                  <td className="rec-wide">
                    <button
                      type="button"
                      className="row-title text-left hover:text-[var(--accent-soft)]"
                      onClick={() => setImportId(row.id)}
                    >
                      {row.fileName}
                    </button>
                    <span className="row-sub">
                      {row.format.toUpperCase()} · {s.importedAt(formatDateTime(row.createdAt), row.importedBy)}
                    </span>
                  </td>
                  <td className="mono whitespace-nowrap text-xs">
                    {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                  </td>
                  <td className="num">{row.lineCount}</td>
                  <td>
                    <span className="inline-flex flex-wrap gap-1">
                      {row.matchedLines > 0 && <Badge tone="ok">{`${row.matchedLines} ${s.statuses.matched!.toLowerCase()}`}</Badge>}
                      {row.suggestedLines > 0 && (
                        <Badge tone="accent">{`${row.suggestedLines} ${s.statuses.suggested!.toLowerCase()}`}</Badge>
                      )}
                      {row.newLines > 0 && <Badge tone="warn">{`${row.newLines} ${s.statuses.new!.toLowerCase()}`}</Badge>}
                      {row.ignoredLines > 0 && <Badge tone="outline">{`${row.ignoredLines} ${s.statuses.ignored!.toLowerCase()}`}</Badge>}
                    </span>
                  </td>
                  <td>
                    <BalanceCompare bank={row.bankBalanceCents} app={row.appBalanceCents} diff={row.differenceCents} />
                  </td>
                  <td className="text-right">
                    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <a className="row-action" href={attachmentUrl(row.attachmentId)} title={s.download} aria-label={s.download}>
                        <Download />
                      </a>
                      {canWrite && (
                        <button
                          type="button"
                          className="row-action danger"
                          title={s.deleteImport}
                          aria-label={s.deleteImport}
                          onClick={() => void remove(row)}
                        >
                          <Trash2 />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {importing && (
        <ImportModal
          target={target}
          card={card.data ?? null}
          initialFile={importing.file}
          onClose={() => setImporting(null)}
          onImported={(detail) => {
            setImporting(null);
            changed();
            const ai = detail.aiSuggestion;
            setSuggestion(ai?.queued && ai.runId ? { importId: detail.id, runId: ai.runId, lines: ai.lines } : null);
            setImportId(detail.id);
          }}
        />
      )}
    </div>
  );
}
