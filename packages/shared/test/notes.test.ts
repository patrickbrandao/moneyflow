import { describe, expect, it } from 'vitest';
import {
  describeReminder,
  NOTE_REMINDER_DEFAULTS,
  normalizeReminder,
  noteBadge,
  noteCreateInput,
  noteListQuery,
  noteReminderMessage,
  noteUpdateInput,
  REMINDER_SOUNDS,
  reminderSettingsInput,
} from '../src';

/* Anotações e lembretes (spec 035): repetição em texto, normalização, selo e entradas. */

describe('describeReminder', () => {
  const base = { ...NOTE_REMINDER_DEFAULTS, startsOn: '2026-11-10' };
  it('descreve cada repetição', () => {
    expect(describeReminder(base)).toBe('em 10/11/2026 às 09:00');
    expect(describeReminder({ ...base, repeat: 'daily', timeOfDay: '07:05' })).toBe('todo dia às 07:05');
    expect(describeReminder({ ...base, repeat: 'every_n_days', everyNDays: 3 })).toBe('a cada 3 dias às 09:00');
    expect(describeReminder({ ...base, repeat: 'monthly_day', monthDay: 10 })).toBe('todo dia 10 às 09:00');
    expect(describeReminder({ ...base, repeat: 'daily', endsOn: '2026-12-31', isActive: false })).toBe(
      'todo dia às 09:00 até 31/12/2026 (pausado)',
    );
  });
});

describe('normalizeReminder', () => {
  const base = { ...NOTE_REMINDER_DEFAULTS, startsOn: '2026-11-10' };
  it('limpa o que não é da repetição e aponta o que falta', () => {
    expect(normalizeReminder({ ...base, repeat: 'daily', everyNDays: 3, monthDay: 4 }).value).toMatchObject({
      everyNDays: null,
      monthDay: null,
    });
    expect(normalizeReminder({ ...base, endsOn: '2026-12-01' }).value.endsOn).toBeNull();
    expect(normalizeReminder({ ...base, repeat: 'every_n_days' }).problems).toHaveLength(1);
    expect(normalizeReminder({ ...base, repeat: 'monthly_day' }).problems).toHaveLength(1);
    expect(normalizeReminder({ ...base, repeat: 'daily', endsOn: '2026-11-01' }).problems).toHaveLength(1);
    expect(normalizeReminder({ ...base, repeat: 'monthly_day', monthDay: 31 }).problems).toEqual([]);
  });
});

describe('noteBadge', () => {
  it('a mais grave: grave > ruim > informação > boa > lembrete', () => {
    expect(noteBadge({})).toBeNull();
    expect(noteBadge({ reminder: 2, good: 1 })).toEqual({ kind: 'good', counts: { reminder: 2, good: 1 }, total: 3 });
    expect(noteBadge({ info: 1, bad: 1 })?.kind).toBe('bad');
    expect(noteBadge({ info: 1, bad: 1, severe: 1 })?.kind).toBe('severe');
  });
});

describe('entradas', () => {
  const objectId = '01a15d01-6be0-7f87-bee2-2b78c75a3400';
  it('criar: padrões, lembrete só no tipo lembrete, título até 120', () => {
    expect(noteCreateInput.parse({ kind: 'info', title: ' Oi ', objectId })).toMatchObject({
      title: 'Oi',
      body: null,
      objectType: 'entity',
      scope: 'private',
    });
    expect(noteCreateInput.parse({ kind: 'reminder', title: 'x', objectId, reminder: {} }).reminder).toMatchObject({
      timeOfDay: '09:00',
      repeat: 'once',
      sendTelegram: false,
      isActive: true,
    });
    expect(noteCreateInput.safeParse({ kind: 'info', title: 'x', objectId, reminder: {} }).success).toBe(false);
    expect(noteCreateInput.safeParse({ kind: 'info', title: 'x'.repeat(121), objectId }).success).toBe(false);
    expect(noteCreateInput.safeParse({ kind: 'reminder', title: 'x', objectId, reminder: { timeOfDay: '24:00' } }).success).toBe(false);
    expect(noteUpdateInput.safeParse({ kind: 'good', reminder: { isActive: false } }).success).toBe(false);
  });
  it('listagem: tipos por vírgula, período com início e fim', () => {
    expect(noteListQuery.parse({ kinds: 'info,severe', archived: '1' })).toMatchObject({
      kinds: ['info', 'severe'],
      archived: true,
      limit: 100,
    });
    expect(noteListQuery.safeParse({ kinds: 'nada' }).success).toBe(false);
    expect(noteListQuery.safeParse({ from: '2026-01-01' }).success).toBe(false);
    expect(noteListQuery.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false);
  });
  it('preferências: os sons da primeira entrega e a chave no formato do banco', () => {
    expect(REMINDER_SOUNDS).toEqual(['bell', 'beep', 'chime', 'digital']);
    expect(reminderSettingsInput.parse({ sound: 'bell' })).toEqual({ sound: 'bell', ringSeconds: 30 });
    expect(reminderSettingsInput.safeParse({ sound: 'Sino!', ringSeconds: 30 }).success).toBe(false);
    expect(reminderSettingsInput.safeParse({ sound: null, ringSeconds: 4 }).success).toBe(false);
  });
});

describe('noteReminderMessage', () => {
  it('escapa o título e o corpo e leva o link', () => {
    const message = noteReminderMessage({
      title: 'A <b>',
      entity: 'Fornecedor & Cia',
      when: '10/11/2026 09:00',
      body: 'x < y',
      url: 'https://moneyflow.test/notes?note=1',
    });
    expect(message.text).toContain('<b>Lembrete: A &lt;b&gt;</b>');
    expect(message.text).toContain('Fornecedor &amp; Cia · 10/11/2026 09:00');
    expect(message.text).toContain('x &lt; y');
    expect(message.text).toContain('href="https://moneyflow.test/notes?note=1"');
  });
});
