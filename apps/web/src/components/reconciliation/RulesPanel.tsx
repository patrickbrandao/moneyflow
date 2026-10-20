import {
  type AccountRow,
  type ApplyRulesResult,
  type CaixaSummary,
  type ClassificationRuleRow,
  type CopyRulesResult,
  formatDate,
  MATCH_KINDS,
  t,
} from '@moneyflow/shared';
import { Archive, Copy, Pencil, Plus, Wand2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { CategoryLabel, LoadError, SkelRows } from '../domain';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal, useConfirm } from '../ui';

const s = t.statements;

type MatchKind = (typeof MATCH_KINDS)[number];

/** Alvo das regras (spec 032): a conta corrente/poupança ou o cartão. */
export type RulesTarget = { accountId: string; cardCaixaId?: undefined } | { cardCaixaId: string; accountId?: undefined };

const targetQuery = (target: RulesTarget) => (target.accountId ? `accountId=${target.accountId}` : `cardCaixaId=${target.cardCaixaId}`);
const targetBody = (target: RulesTarget) => (target.accountId ? { accountId: target.accountId } : { cardCaixaId: target.cardCaixaId });
const ruleKey = (r: { matchKind: string; pattern: string; direction: string | null }) =>
  `${r.matchKind}|${r.pattern.toLowerCase()}|${r.direction ?? ''}`;

/** Regras de classificação de uma conta (ou cartão): descrição → entidade/categoria, só nos extratos dela (specs 009/032). */
export function RulesPanel({
  caixaId,
  target,
  targetName,
  canWrite,
}: {
  caixaId: string;
  target: RulesTarget;
  targetName: string;
  canWrite: boolean;
}) {
  const [archived, setArchived] = useState(false);
  const rules = useApi<ClassificationRuleRow[]>(`/api/classification-rules?${targetQuery(target)}${archived ? '&archived=1' : ''}`);
  const [editing, setEditing] = useState<ClassificationRuleRow | 'new' | null>(null);
  const [copying, setCopying] = useState(false);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const targetId = target.accountId ?? target.cardCaixaId;

  useRegisterCommands(
    canWrite
      ? [
          { id: 'rule-new', label: `${s.newRule} em ${targetName}`, group: 'Criar', icon: <Plus />, run: () => setEditing('new') },
          { id: 'rule-copy', label: `${s.copyRules} (${targetName})`, group: 'Criar', icon: <Copy />, run: () => setCopying(true) },
        ]
      : [],
    [canWrite, targetId, targetName],
  );

  // Reaplica as regras da conta às linhas novas de todos os lotes dela (spec 032).
  async function applyRules() {
    const result = await run(
      () => api.post<ApplyRulesResult>('/api/classification-rules/apply', targetBody(target)),
      (r) => s.rulesApplied(r.updated),
    );
    if (result) void rules.reload();
  }

  async function archive(rule: ClassificationRuleRow) {
    const ok = await confirm({
      title: s.archiveRuleTitle(rule.pattern),
      description: s.archiveRuleBody,
      confirmLabel: t.common.archive,
      danger: true,
    });
    if (ok && (await run(() => api.del(`/api/classification-rules/${rule.id}`), s.ruleArchived))) void rules.reload();
  }

  return (
    <>
      <div className="rec-bar">
        <p className="text-[13px] text-muted">{s.rulesHint}</p>
        <span className="flex-1" />
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {s.showArchivedRules}
        </label>
        {canWrite && (
          <Button variant="ghost" onClick={() => setCopying(true)}>
            <Copy /> {s.copyRules}
          </Button>
        )}
        {canWrite && (
          <Button variant="ghost" onClick={() => void applyRules()} disabled={busy} title={s.applyRulesAccountHint}>
            <Wand2 /> {s.applyRules}
          </Button>
        )}
        {canWrite && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> {s.newRule}
          </Button>
        )}
      </div>
      {rules.error ? (
        <LoadError error={rules.error} onRetry={() => void rules.reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data" data-testid="rules-table">
            <thead>
              <tr>
                <th>{s.pattern}</th>
                <th>{s.direction}</th>
                <th>{s.entity}</th>
                <th>{s.category}</th>
                <th className="num">{s.priority}</th>
                <th>{s.origin}</th>
                <th className="num">{s.usage}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!rules.data && <SkelRows cols={8} />}
              {rules.data?.length === 0 && <EmptyRow colSpan={8}>{s.noRules}</EmptyRow>}
              {rules.data?.map((rule) => (
                <tr key={rule.id} className={rule.archivedAt ? 'is-off' : ''}>
                  <td className="rec-mid">
                    <span className="row-title mono text-[12.5px]">{rule.pattern}</span>
                    <span className="row-sub">{s.matchKinds[rule.matchKind]}</span>
                  </td>
                  <td className="text-dim">{rule.direction ? s.directions[rule.direction] : s.directions.any}</td>
                  <td>{rule.entityName ?? <span className="text-faint">—</span>}</td>
                  <td>
                    {rule.categoryName ? (
                      <CategoryLabel name={rule.categoryName} slot={rule.categoryColorSlot} />
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="num mono text-xs">{rule.priority}</td>
                  <td>
                    <Badge tone={rule.origin === 'agent' ? 'accent' : rule.origin === 'copy' ? 'outline' : 'neutral'}>
                      {s.origins[rule.origin]}
                    </Badge>
                  </td>
                  <td className="num">
                    {rule.usageCount}
                    {rule.lastUsedAt && <span className="row-sub">{s.lastUsed(formatDate(rule.lastUsedAt))}</span>}
                  </td>
                  <td className="text-right">
                    {rule.canWrite && !rule.archivedAt && (
                      <span className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title={t.common.edit}
                          aria-label={t.common.edit}
                          onClick={() => setEditing(rule)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.common.archive}
                          aria-label={t.common.archive}
                          onClick={() => void archive(rule)}
                        >
                          <Archive />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RuleFormModal
          caixaId={caixaId}
          target={target}
          targetName={targetName}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}
      {copying && (
        <CopyRulesModal
          target={target}
          targetName={targetName}
          onClose={() => setCopying(false)}
          onCopied={() => {
            setCopying(false);
            void rules.reload();
          }}
        />
      )}
    </>
  );
}

/** Copiar regras de outra conta ou cartão (spec 032): origem entre as legíveis, as iguais do destino desabilitadas. */
function CopyRulesModal({
  target,
  targetName,
  onClose,
  onCopied,
}: {
  target: RulesTarget;
  targetName: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const accounts = useApi<AccountRow[]>('/api/accounts');
  const destination = useApi<ClassificationRuleRow[]>(`/api/classification-rules?${targetQuery(target)}`);
  const [source, setSource] = useState('');
  const sourceRules = useApi<ClassificationRuleRow[]>(source ? `/api/classification-rules?${source}` : null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { run, busy } = useAction();
  const targetId = target.accountId ?? target.cardCaixaId;

  // Origens: as contas corrente/poupança agrupadas por caixa e os cartões, menos o próprio destino.
  const groups = useMemo(() => {
    const out: { label: string; options: { value: string; label: string }[] }[] = [];
    for (const caixa of (caixas.data ?? []).filter((c) => c.kind === 'general' && !c.archivedAt)) {
      const options = (accounts.data ?? [])
        .filter((a) => a.caixaId === caixa.id && (a.kind === 'checking' || a.kind === 'savings') && !a.archivedAt && a.id !== targetId)
        .map((a) => ({ value: `accountId=${a.id}`, label: `${a.name} · ${t.caixa.accountKinds[a.kind]}` }));
      if (options.length > 0) out.push({ label: caixa.name, options });
    }
    const cards = (caixas.data ?? [])
      .filter((c) => c.kind === 'credit_card' && !c.archivedAt && c.id !== targetId)
      .map((c) => ({ value: `cardCaixaId=${c.id}`, label: c.name }));
    if (cards.length > 0) out.push({ label: s.cardGroup, options: cards });
    return out;
  }, [caixas.data, accounts.data, targetId]);

  const taken = useMemo(() => new Set((destination.data ?? []).map(ruleKey)), [destination.data]);
  const available = (sourceRules.data ?? []).filter((r) => !taken.has(ruleKey(r)));
  const allPicked = available.length > 0 && available.every((r) => picked.has(r.id));

  function toggle(id: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(
      () => api.post<CopyRulesResult>('/api/classification-rules/copy', { ...targetBody(target), ruleIds: [...picked] }),
      (r) => s.copyDone(r.copied.length, r.skipped.length),
    );
    if (result) onCopied();
  }

  return (
    <Modal open wide title={s.copyRulesTo(targetName)} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={s.copyFrom} hint={s.copyHint}>
          <select
            className="field"
            value={source}
            aria-label={s.copyFrom}
            onChange={(e) => {
              setSource(e.target.value);
              setPicked(new Set());
            }}
          >
            <option value="">{s.copyFromPlaceholder}</option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        {source && (
          <div className="table-wrap">
            <table className="data" data-testid="copy-rules-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={s.copySelectAll}
                      title={s.copySelectAll}
                      checked={allPicked}
                      disabled={available.length === 0}
                      onChange={(e) => setPicked(e.target.checked ? new Set(available.map((r) => r.id)) : new Set())}
                    />
                  </th>
                  <th>{s.pattern}</th>
                  <th>{s.direction}</th>
                  <th>{s.entity}</th>
                  <th>{s.category}</th>
                </tr>
              </thead>
              <tbody>
                {!sourceRules.data && <SkelRows cols={5} />}
                {sourceRules.data?.length === 0 && <EmptyRow colSpan={5}>{s.copyNoRules}</EmptyRow>}
                {sourceRules.data?.map((rule) => {
                  const exists = taken.has(ruleKey(rule));
                  return (
                    <tr key={rule.id} className={exists ? 'is-off' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={rule.pattern}
                          checked={picked.has(rule.id)}
                          disabled={exists}
                          onChange={(e) => toggle(rule.id, e.target.checked)}
                        />
                      </td>
                      <td className="rec-mid">
                        <span className="row-title mono text-[12.5px]">{rule.pattern}</span>
                        <span className="row-sub">
                          {s.matchKinds[rule.matchKind]}
                          {exists ? ` · ${s.copyExists}` : ''}
                        </span>
                      </td>
                      <td className="text-dim">{rule.direction ? s.directions[rule.direction] : s.directions.any}</td>
                      <td>{rule.entityName ?? <span className="text-faint">—</span>}</td>
                      <td>
                        {rule.categoryName ? (
                          <CategoryLabel name={rule.categoryName} slot={rule.categoryColorSlot} />
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || picked.size === 0}>
            <Copy /> {s.copySubmit(picked.size)}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function RuleFormModal({
  caixaId,
  target,
  targetName,
  rule,
  onClose,
  onSaved,
}: {
  caixaId: string;
  target: RulesTarget;
  targetName: string;
  rule: ClassificationRuleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [matchKind, setMatchKind] = useState<MatchKind>(rule?.matchKind ?? 'contains');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [direction, setDirection] = useState<'in' | 'out' | ''>(rule?.direction ?? 'out');
  const [entity, setEntity] = useState<EntityOption | null>(rule?.entityId ? { id: rule.entityId, name: rule.entityName ?? '' } : null);
  const [categoryId, setCategoryId] = useState<string | null>(rule?.categoryId ?? null);
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!entity && !categoryId) return setError(s.ruleNeedsTarget);
    if (categoryId && !direction) return setError(s.ruleNeedsDirection);
    const body = {
      matchKind,
      pattern: pattern.trim(),
      direction: direction || null,
      entityId: entity?.id ?? null,
      categoryId,
      priority,
    };
    const saved = await run(
      () =>
        rule
          ? api.patch(`/api/classification-rules/${rule.id}`, body)
          : api.post('/api/classification-rules', { ...body, ...targetBody(target) }),
      s.ruleSaved,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={rule ? s.editRule : s.newRule} onClose={onClose}>
      <form onSubmit={submit} className="form-grid cols-2">
        <Field label={s.targetAccount} className="span-all">
          <input className="field" value={rule ? `${rule.caixaName} · ${rule.targetName}` : targetName} disabled />
        </Field>
        <Field label={s.matchKind}>
          <select className="field" value={matchKind} onChange={(e) => setMatchKind(e.target.value as MatchKind)}>
            {MATCH_KINDS.map((k) => (
              <option key={k} value={k}>
                {s.matchKinds[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.pattern}>
          <input
            className="field field-mono"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            required
            maxLength={200}
            autoFocus
            placeholder="PIX ENVIADO MERCADO"
          />
        </Field>
        <Field label={s.direction} hint={s.directionHint}>
          <select
            className="field"
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as 'in' | 'out' | '');
              setCategoryId(null);
            }}
          >
            <option value="">{s.directions.any}</option>
            <option value="in">{s.directions.in}</option>
            <option value="out">{s.directions.out}</option>
          </select>
        </Field>
        <Field label={s.priority} hint={s.priorityHint}>
          <input
            type="number"
            className="field"
            min={0}
            max={1000}
            value={priority}
            onChange={(e) => setPriority(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
          />
        </Field>
        <Field label={s.entity} className="span-all">
          <EntityPicker value={entity} onChange={setEntity} ariaLabel={s.entity} />
        </Field>
        <Field label={s.category} className="span-all">
          {direction ? (
            <CategorySelect
              kind={direction === 'in' ? 'income' : 'expense'}
              caixaId={caixaId}
              value={categoryId}
              onChange={setCategoryId}
              allowEmpty={t.common.none}
              ariaLabel={s.category}
            />
          ) : (
            <select className="field" disabled aria-label={s.category}>
              <option>{s.ruleNeedsDirection}</option>
            </select>
          )}
        </Field>
        <div className="span-all">
          <FormError>{error}</FormError>
        </div>
        <div className="span-all">
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={busy || !pattern.trim()}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </ModalActions>
        </div>
      </form>
    </Modal>
  );
}
