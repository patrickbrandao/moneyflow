/*
 * Datas de negócio (competência, vencimento, baixa) circulam como texto
 * ISO 'YYYY-MM-DD', sem fuso. "Hoje" é no fuso America/Sao_Paulo.
 */

export const TIME_ZONE = 'America/Sao_Paulo';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** Hoje (data local de São Paulo) como 'YYYY-MM-DD'. */
export function todayIso(now: Date = new Date(), timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(iso: string): [number, number, number] {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`data inválida: ${iso}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function toIso(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Soma meses mantendo o dia `anchorDay` (padrão: o dia da data) e usando o
 * último dia do mês quando ele não existe (31/01 + 1 mês = 28 ou 29/02).
 */
export function addMonths(iso: string, months: number, anchorDay?: number): string {
  const [y, m, d] = parts(iso);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return toIso(year, month, Math.min(anchorDay ?? d, daysInMonth(year, month)));
}

/** Dia da semana ISO: 1 = segunda … 7 = domingo. */
export function isoWeekday(iso: string): number {
  const [y, m, d] = parts(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function dayOfMonth(iso: string): number {
  return parts(iso)[2];
}

/** Diferença em dias (b − a). */
export function diffDays(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa'. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = ISO.exec(iso.slice(0, 10));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** 'dd/mm/aaaa' → 'YYYY-MM-DD' (ou null se inválida). */
export function parseDateBR(value: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const iso = toIso(Number(m[3]), Number(m[2]), Number(m[1]));
  return isIsoDate(iso) ? iso : null;
}

/** Instante (ISO com hora) → 'dd/mm/aaaa hh:mm' em São Paulo. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Mês por extenso curto: '2026-10-10' → 'out/2026'. */
export function formatMonth(iso: string): string {
  const [y, m] = parts(iso);
  const names = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${names[m - 1]}/${y}`;
}
