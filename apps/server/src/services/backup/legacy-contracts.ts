import { randomUUID } from 'node:crypto';
import {
  addDays,
  addMonths,
  type BackupFile,
  type BackupRow,
  cycleEnd,
  dayOfMonth,
  type Frequency,
  occurrenceDueDate,
} from '@moneyflow/shared';

/*
 * Arquivo anterior aos contratos sobre séries (spec 034, migration 0052): o
 * mesmo critério da migração, no próprio arquivo, antes do merge.
 * - Séries sem caixa: a do lado original da ocorrência mais recente; as
 *   ocorrências de outras caixas vão para uma série nova por caixa (mesma
 *   agenda, terminando no último vencimento delas); série sem títulos sai.
 * - Contratos: vigência do início do primeiro ciclo ao fim do último
 *   (rescindido: até a rescisão); renovação pendente vira vigente; as tarefas
 *   abertas, fechadas.
 * - Conta de passagem vira a conta prevista (é da caixa do título).
 * - Parcelas (origin contract) dos ciclos que não são de parcela única: uma
 *   série por contrato e caixa do lado original, ancorada no último
 *   vencimento, com a ocorrência na ordem do vencimento (o espelho com a
 *   mesma) e os ajustes de reconhecimento do contrato; parcela única e multa
 *   viram avulsos (origin manual).
 * - Sem conta prevista: a da última baixa ativa do contrato na mesma caixa.
 */

const key = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : null);
const str = (value: unknown) => (typeof value === 'string' ? value : null);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const lastOfMonth = (date: string) => addDays(addMonths(monthStart(date), 1), -1);

const TERM_COLUMNS = [
  'match_window_days',
  'late_fee_percent',
  'interest_month_percent',
  'early_discount_percent',
  'tolerance_cents',
  'auto_settle',
] as const;

/** O arquivo é de antes da 0052? */
export function isLegacyContractsFile(file: BackupFile): boolean {
  const t = file.tables;
  return (
    (t.contracts ?? []).some((c) => c && typeof c === 'object' && !('starts_on' in c)) ||
    (t.titles ?? []).some((x) => x && typeof x === 'object' && (x.origin === 'contract' || 'planned_transit_account_id' in x)) ||
    (t.recurrence_rules ?? []).some((r) => r && typeof r === 'object' && !('caixa_id' in r))
  );
}

export function legacyContracts(file: BackupFile, now = new Date().toISOString()): BackupFile {
  if (!isLegacyContractsFile(file)) return file;
  const titles: BackupRow[] = (file.tables.titles ?? []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { planned_transit_account_id: transit, ...rest } = row;
    // A conta de passagem é da caixa do título: vira a conta prevista.
    return transit ? { ...rest, planned_account_id: transit } : rest;
  });
  const byId = new Map(titles.filter((x) => key(x?.id)).map((x) => [key(x.id)!, x]));
  const rules: BackupRow[] = [];

  /* Séries que já existiam: a caixa (e a divisão por caixa). */
  for (const rule of file.tables.recurrence_rules ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    if ('caixa_id' in rule && rule.caixa_id) {
      rules.push(rule);
      continue;
    }
    const ruleId = key(rule.id);
    const originals = titles
      .filter((x) => key(x.recurrence_rule_id) === ruleId && !x.mirror_status)
      .sort((a, b) => Number(b.occurrence ?? 0) - Number(a.occurrence ?? 0));
    if (originals.length === 0) continue; // órfã: o worker já a ignorava.
    const mainCaixa = key(originals[0]!.caixa_id);
    rules.push({ ...rule, caixa_id: originals[0]!.caixa_id });
    const others = new Map<string, BackupRow[]>();
    for (const x of originals) {
      const caixa = key(x.caixa_id)!;
      if (caixa !== mainCaixa) others.set(caixa, [...(others.get(caixa) ?? []), x]);
    }
    for (const [, group] of others) {
      const id = randomUUID();
      const lastDue = group
        .map((x) => String(x.due_date))
        .sort()
        .at(-1)!;
      const startsOn = String(rule.starts_on);
      const endsOn = rule.ends_on && String(rule.ends_on) < lastDue ? String(rule.ends_on) : lastDue;
      rules.push({
        ...rule,
        id,
        caixa_id: group[0]!.caixa_id,
        ends_on: endsOn < startsOn ? startsOn : endsOn,
        installments_total: null,
      });
      for (const x of group) {
        x.recurrence_rule_id = id;
        const mirror = byId.get(key(x.mirror_title_id) ?? '');
        if (mirror) mirror.recurrence_rule_id = id;
      }
    }
  }

  /* Contratos: vigência e status. */
  const cycles = (file.tables.contract_cycles ?? []).filter((y) => y && typeof y === 'object');
  const cyclesOf = (contractId: string) =>
    cycles.filter((y) => key(y.contract_id) === contractId).sort((a, b) => Number(a.seq) - Number(b.seq));
  const cycleEndOf = (y: BackupRow) =>
    str(y.ends_on) ?? (y.duration_months ? cycleEnd(String(y.starts_on), Number(y.duration_months)) : null);
  const contractsById = new Map<string, BackupRow>();
  const contracts = (file.tables.contracts ?? []).map((row) => {
    if (!row || typeof row !== 'object' || 'starts_on' in row) {
      if (key(row?.id)) contractsById.set(key(row.id)!, row);
      return row;
    }
    const own = cyclesOf(key(row.id)!);
    const created = str(row.created_at)?.slice(0, 10) ?? now.slice(0, 10);
    const terminatedOn = str(row.terminated_on);
    const firstStart = own[0] ? String(own[0].starts_on) : null;
    const lastEnd = own.length ? cycleEndOf(own.at(-1)!) : null;
    const status = row.status === 'renewal_pending' ? 'active' : String(row.status);
    const startsOn = firstStart ? (terminatedOn && terminatedOn < firstStart ? terminatedOn : firstStart) : (terminatedOn ?? created);
    const endsOn = status === 'terminated' ? terminatedOn : firstStart ? lastEnd : status === 'ended' ? (terminatedOn ?? created) : null;
    const next = { ...row, status, starts_on: startsOn, ends_on: endsOn };
    contractsById.set(key(row.id)!, next);
    return next;
  });

  const tasks = (file.tables.contract_renewal_tasks ?? []).map((task) =>
    task && typeof task === 'object' && task.status === 'open' ? { ...task, status: 'closed', decided_at: now } : task,
  );

  /* Parcelas → séries, por contrato e caixa do lado original. */
  const cycleById = new Map(cycles.filter((y) => key(y.id)).map((y) => [key(y.id)!, y]));
  const groups = new Map<string, BackupRow[]>();
  for (const x of titles) {
    if (x?.origin !== 'contract' || x.mirror_status) continue;
    const cycle = cycleById.get(key(x.contract_cycle_id) ?? '');
    if (!cycle || cycle.periodicity === 'single') continue;
    const groupKey = `${key(x.contract_id)}|${key(x.caixa_id)}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), x]);
  }
  for (const [, group] of groups) {
    const ordered = [...group].sort(
      (a, b) =>
        String(a.due_date).localeCompare(String(b.due_date)) ||
        String(a.competence_date).localeCompare(String(b.competence_date)) ||
        Number(cycleById.get(key(a.contract_cycle_id)!)?.seq ?? 0) - Number(cycleById.get(key(b.contract_cycle_id)!)?.seq ?? 0) ||
        Number(a.contract_installment ?? 0) - Number(b.contract_installment ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const last = ordered.at(-1)!;
    const lastCycle = cycleById.get(key(last.contract_cycle_id)!)!;
    const periodicity = String(lastCycle.periodicity);
    const frequency: Frequency = periodicity === 'annual' ? 'yearly' : 'monthly';
    const intervalCount = periodicity === 'quarterly' ? 3 : periodicity === 'semiannual' ? 6 : 1;
    const step = frequency === 'yearly' ? 12 : intervalCount;
    const lastDue = String(last.due_date);
    let anchor = dayOfMonth(lastDue);
    if (lastDue === lastOfMonth(lastDue) && Number(lastCycle.due_day) > anchor) anchor = Number(lastCycle.due_day);
    const base = addMonths(monthStart(lastDue), -(ordered.length - 1) * step);
    const startsOn = occurrenceDueDate({ frequency, intervalCount, anchorDay: anchor, startsOn: base }, 1);
    const contract = contractsById.get(key(last.contract_id)!);
    const kept = ordered.filter((x) => x.status !== 'canceled').map((x) => String(x.due_date));
    let endsOn = contract?.status === 'terminated' ? (kept.sort().at(-1) ?? startsOn) : lastDue;
    if (endsOn < startsOn) endsOn = startsOn;
    const ruleId = randomUUID();
    const terms = Object.fromEntries(TERM_COLUMNS.filter((c) => contract && c in contract).map((c) => [c, contract![c]]));
    rules.push({
      id: ruleId,
      frequency,
      interval_count: intervalCount,
      anchor_day: anchor,
      starts_on: startsOn,
      ends_on: endsOn,
      installments_total: null,
      caixa_id: last.caixa_id,
      contract_id: last.contract_id,
      ...terms,
      created_at: last.created_at ?? now,
      updated_at: last.updated_at ?? now,
    });
    ordered.forEach((x, index) => {
      Object.assign(x, { origin: 'recurrence', recurrence_rule_id: ruleId, occurrence: index + 1 });
      const mirror = byId.get(key(x.mirror_title_id) ?? '');
      if (mirror) Object.assign(mirror, { origin: 'recurrence', recurrence_rule_id: ruleId, occurrence: index + 1 });
    });
  }
  // Parcela única e títulos extras (multa, valor rescisório): avulsos ligados ao contrato.
  for (const x of titles) if (x && x.origin === 'contract') x.origin = 'manual';

  /* Conta prevista dos títulos de contrato sem conta: a da última baixa ativa do contrato na mesma caixa. */
  const archivedAccounts = new Set((file.tables.financial_accounts ?? []).filter((a) => a?.archived_at).map((a) => key(a.id)!));
  const accountCaixa = new Map((file.tables.financial_accounts ?? []).filter((a) => key(a?.id)).map((a) => [key(a.id)!, key(a.caixa_id)]));
  const lastAccount = new Map<string, { on: string; at: string; account: unknown }>();
  for (const s of file.tables.settlements ?? []) {
    if (!s || s.reversed_at || !s.financial_account_id) continue;
    const title = byId.get(key(s.title_id) ?? '');
    const accountId = key(s.financial_account_id)!;
    if (!title?.contract_id || archivedAccounts.has(accountId) || accountCaixa.get(accountId) !== key(title.caixa_id)) continue;
    const groupKey = `${key(title.contract_id)}|${key(title.caixa_id)}`;
    const current = lastAccount.get(groupKey);
    const on = String(s.settled_on);
    const at = String(s.created_at ?? '');
    if (!current || on > current.on || (on === current.on && at > current.at))
      lastAccount.set(groupKey, { on, at, account: s.financial_account_id });
  }
  for (const x of titles) {
    if (!x?.contract_id || x.planned_account_id) continue;
    const found = lastAccount.get(`${key(x.contract_id)}|${key(x.caixa_id)}`);
    if (found) x.planned_account_id = found.account;
  }

  return {
    ...file,
    tables: {
      ...file.tables,
      titles,
      recurrence_rules: rules,
      ...(file.tables.contracts ? { contracts } : {}),
      ...(file.tables.contract_renewal_tasks ? { contract_renewal_tasks: tasks } : {}),
    },
  };
}
