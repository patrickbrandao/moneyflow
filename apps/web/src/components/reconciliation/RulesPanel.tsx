import { type CaixaDetail, type ClassificationRuleRow, formatDate, MATCH_KINDS, t } from '@moneyflow/shared';
import { Archive, Globe, Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { CategoryLabel, LoadError, SkelRows } from '../domain';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal, useConfirm } from '../ui';

const s = t.statements;

type MatchKind = (typeof MATCH_KINDS)[number];

/** Regras de classificação da caixa (e as globais): descrição → entidade/categoria (spec 009). */
export function RulesPanel({ caixa }: { caixa: CaixaDetail }) {
  const [archived, setArchived] = useState(false);
  const rules = useApi<ClassificationRuleRow[]>(`/api/classification-rules?caixaId=${caixa.id}${archived ? '&archived=1' : ''}`);
  const [editing, setEditing] = useState<ClassificationRuleRow | 'new' | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();

  useRegisterCommands(
    caixa.canWrite
      ? [{ id: 'rule-new', label: `${s.newRule} em ${caixa.name}`, group: 'Criar', icon: <Plus />, run: () => setEditing('new') }]
      : [],
    [caixa.canWrite, caixa.id],
  );

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
        {caixa.canWrite && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> {s.newRule}
          </Button>
        )}
      </div>
      {rules.error ? (
        <LoadError error={rules.error} onRetry={() => void rules.reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{s.pattern}</th>
                <th>{s.direction}</th>
                <th>{s.entity}</th>
                <th>{s.category}</th>
                <th>{s.scope}</th>
                <th className="num">{s.priority}</th>
                <th>{s.origin}</th>
                <th className="num">{s.usage}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!rules.data && <SkelRows cols={9} />}
              {rules.data?.length === 0 && <EmptyRow colSpan={9}>{s.noRules}</EmptyRow>}
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
                  <td>
                    {rule.caixaId ? (
                      <Badge tone="outline">{s.scopeCaixa}</Badge>
                    ) : (
                      <Badge tone="info">
                        <Globe /> {s.scopeGlobal}
                      </Badge>
                    )}
                  </td>
                  <td className="num mono text-xs">{rule.priority}</td>
                  <td>
                    <Badge tone={rule.origin === 'agent' ? 'accent' : 'neutral'}>{s.origins[rule.origin]}</Badge>
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
          caixa={caixa}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}
    </>
  );
}

function RuleFormModal({
  caixa,
  rule,
  onClose,
  onSaved,
}: {
  caixa: CaixaDetail;
  rule: ClassificationRuleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [global, setGlobal] = useState(rule ? rule.caixaId === null : false);
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
          : api.post('/api/classification-rules', { ...body, caixaId: global ? null : caixa.id }),
      s.ruleSaved,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={rule ? s.editRule : s.newRule} onClose={onClose}>
      <form onSubmit={submit} className="form-grid cols-2">
        <Field label={s.scope} className="span-all" hint={global ? s.scopeGlobalHint : undefined}>
          <select
            className="field"
            value={global ? 'global' : 'caixa'}
            disabled={Boolean(rule)}
            onChange={(e) => setGlobal(e.target.value === 'global')}
          >
            <option value="caixa">
              {s.scopeCaixa} ({caixa.name})
            </option>
            <option value="global" disabled={!isAdmin}>
              {s.scopeGlobal}
            </option>
          </select>
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
              caixaId={global ? null : caixa.id}
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
