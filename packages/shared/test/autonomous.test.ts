import { describe, expect, it } from 'vitest';
import { agentTaskSchedule, escapeTelegramHtml, markdownToTelegramHtml, scheduleText, taskSkipReasonText } from '../src';

/* Fluxos autônomos (spec 029): a agenda das tarefas e a resposta do agente no HTML do Telegram. */

describe('agenda das tarefas', () => {
  it('normaliza para o formato do banco (só as chaves do tipo) e recusa o que falta', () => {
    expect(agentTaskSchedule.parse({ kind: 'weekly', time: '08:00', weekdays: [5, 1, 3], day: 4 })).toEqual({
      kind: 'weekly',
      time: '08:00',
      weekdays: [1, 3, 5],
    });
    expect(agentTaskSchedule.parse({ kind: 'monthly', time: '07:30', day: 'last', weekdays: [1] })).toEqual({
      kind: 'monthly',
      time: '07:30',
      day: 'last',
    });
    expect(agentTaskSchedule.parse({ kind: 'daily', time: '23:59', day: 3 })).toEqual({ kind: 'daily', time: '23:59' });
    expect(agentTaskSchedule.safeParse({ kind: 'weekly', time: '08:00' }).success).toBe(false);
    expect(agentTaskSchedule.safeParse({ kind: 'weekly', time: '08:00', weekdays: [1, 1] }).success).toBe(false);
    expect(agentTaskSchedule.safeParse({ kind: 'monthly', time: '08:00' }).success).toBe(false);
    expect(agentTaskSchedule.safeParse({ kind: 'daily', time: '24:00' }).success).toBe(false);
    expect(agentTaskSchedule.safeParse({ kind: 'monthly', time: '08:00', day: 32 }).success).toBe(false);
  });

  it('em texto', () => {
    expect(scheduleText({ kind: 'daily', time: '08:00' })).toBe('todo dia às 08:00');
    expect(scheduleText({ kind: 'weekly', time: '08:00', weekdays: [1] })).toBe('toda segunda às 08:00');
    expect(scheduleText({ kind: 'weekly', time: '08:00', weekdays: [3, 1] })).toBe('toda segunda e quarta às 08:00');
    expect(scheduleText({ kind: 'weekly', time: '09:00', weekdays: [6, 7] })).toBe('todo sábado e domingo às 09:00');
    expect(scheduleText({ kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe('de segunda a sexta às 09:00');
    expect(scheduleText({ kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] })).toBe('todo dia às 09:00');
    expect(scheduleText({ kind: 'monthly', time: '07:00', day: 10 })).toBe('todo dia 10 às 07:00');
    expect(scheduleText({ kind: 'monthly', time: '07:00', day: 'last' })).toBe('todo último dia do mês às 07:00');
    expect(taskSkipReasonText('missed_window')).toContain('6 h');
    expect(taskSkipReasonText('erro qualquer')).toBe('erro qualquer');
  });
});

describe('resposta no HTML do Telegram', () => {
  it('converte o markdown (títulos, ênfases, código, links, listas) e escapa o resto', () => {
    const [html] = markdownToTelegramHtml(
      '# Título\n\n**negrito** e _itálico_ com `código <x>` e [link](https://x.test/a?b=1&c=2) <script>\n\n- um\n- dois\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(html).toBe(
      '<b>Título</b>\n\n<b>negrito</b> e <i>itálico</i> com <code>código &lt;x&gt;</code> e <a href="https://x.test/a?b=1&amp;c=2">link</a> &lt;script&gt;\n\n• um\n• dois\n\na | b\n1 | 2',
    );
    expect(markdownToTelegramHtml('snake_case_name e 2*3*4')).toEqual(['snake_case_name e 2*3*4']);
    expect(markdownToTelegramHtml('> citação\n> segunda')).toEqual(['<blockquote>citação\nsegunda</blockquote>']);
    expect(escapeTelegramHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
    expect(markdownToTelegramHtml('')).toEqual([]);
  });

  it('divide em partes de até 4096 sem cortar tags nem entidades', () => {
    const long = Array.from({ length: 300 }, (_, i) => `Parágrafo **${i}** ${'x'.repeat(40)}`).join('\n\n');
    const parts = markdownToTelegramHtml(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect((part.match(/<b>/g) ?? []).length).toBe((part.match(/<\/b>/g) ?? []).length);
    }
    const code = markdownToTelegramHtml(`\`\`\`\n${'a < b & c\n'.repeat(2000)}\`\`\``);
    expect(code.length).toBeGreaterThan(1);
    for (const part of code) {
      expect(part.startsWith('<pre>') && part.endsWith('</pre>')).toBe(true);
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part).not.toMatch(/&[a-z]*<\/pre>$/);
    }
    const giant = markdownToTelegramHtml('y'.repeat(9000));
    expect(giant.map((p) => p.length)).toEqual([4096, 4096, 808]);
  });
});
