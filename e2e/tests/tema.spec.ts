import { expect, type Page, test } from '@playwright/test';

/*
 * Cores do console (tarefa 007): o acento é azul nos dois temas, sem nenhum
 * roxo (matiz 250°–320°) no acento, no anel de foco, nos neutros, nas 12
 * cores de categoria/canvas nem no logo; o texto branco sobre o acento mantém AA e as
 * 12 cores --port-N continuam distintas entre si; as 5 dos tipos de anotação (spec 035)
 * passam AA no cartão. Só precisa da tela de login.
 */

type Rgb = [number, number, number];

const PURPLE: [number, number] = [250, 320];

function parseColor(value: string): Rgb {
  let v = value.trim();
  // o build minifica rgba() em #rrggbbaa e encurta #rgb/#rgba: a transparência não importa aqui
  if (/^#[0-9a-f]{3,4}$/i.test(v)) v = `#${[...v.slice(1, 4)].map((c) => c + c).join('')}`;
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`cor não reconhecida: ${v}`);
}

/** Matiz (graus) e saturação HSL (0–1). */
function hueSat([r, g, b]: Rgb): { hue: number; sat: number } {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = d / (1 - Math.abs(2 * l - 1));
  let hue = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat };
}

const isPurple = (c: Rgb) => {
  const { hue, sat } = hueSat(c);
  return sat > 0.15 && hue >= PURPLE[0] && hue <= PURPLE[1];
};

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Distância no OKLab: abaixo de ~0,05 duas cores se confundem. */
function oklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const distance = (a: Rgb, b: Rgb) => {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

const ACCENT = ['--accent', '--accent-hover', '--accent-soft', '--accent-deep', '--accent-tint'];
const PORTS = Array.from({ length: 12 }, (_, i) => `--port-${i + 1}`);
/** Tipos das anotações (spec 035). */
const NOTES = ['--note-info', '--note-good', '--note-bad', '--note-severe', '--note-reminder'];
const NEUTRALS = [
  '--bg',
  '--bg-sunken',
  '--bg-elev',
  '--bg-chrome',
  '--surface-2',
  '--surface-3',
  '--surface-4',
  '--border',
  '--border-strong',
  '--grid-dot',
  '--text',
  '--text-dim',
  '--text-muted',
  '--text-faint',
  '--overlay',
];

type BrowserRoot = { setAttribute(name: string, value: string): void };
type BrowserWindow = {
  document: { documentElement: BrowserRoot };
  getComputedStyle(el: BrowserRoot): { getPropertyValue(name: string): string };
};

async function tokens(page: Page, theme: 'dark' | 'light') {
  return page.evaluate(
    ({ theme, names }) => {
      // roda no navegador; o tsconfig do e2e não carrega a lib DOM
      const win = globalThis as unknown as BrowserWindow;
      const root = win.document.documentElement;
      root.setAttribute('data-theme', theme);
      const style = win.getComputedStyle(root);
      return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n)]));
    },
    { theme, names: [...ACCENT, ...PORTS, ...NEUTRALS, ...NOTES, '--on-accent', '--ring-accent', '--info'] },
  );
}

for (const theme of ['dark', 'light'] as const) {
  test(`tema ${theme}: acento azul, sem roxo, AA e 12 cores de categoria distintas`, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Usuário ou e-mail')).toBeVisible();
    const t = await tokens(page, theme);

    for (const name of [...ACCENT, ...PORTS, ...NEUTRALS, ...NOTES, '--info']) {
      expect(isPurple(parseColor(t[name]!)), `${name} = ${t[name]} é roxo`).toBe(false);
    }
    expect(
      isPurple(parseColor(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*$/i.exec(t['--ring-accent']!)?.[1] ?? '')),
      `--ring-accent = ${t['--ring-accent']}`,
    ).toBe(false);

    // o acento é azul
    for (const name of ['--accent', '--accent-hover', '--accent-soft', '--accent-deep']) {
      const { hue } = hueSat(parseColor(t[name]!));
      expect(hue, `${name} = ${t[name]} fora do azul`).toBeGreaterThanOrEqual(200);
      expect(hue, `${name} = ${t[name]} fora do azul`).toBeLessThanOrEqual(230);
    }

    // texto branco sobre o botão primário (e no hover) com AA
    const onAccent = parseColor(t['--on-accent']!);
    expect(contrast(parseColor(t['--accent']!), onAccent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(t['--accent-hover']!), onAccent)).toBeGreaterThanOrEqual(4.5);

    // estado "info" não se confunde com o acento
    expect(distance(parseColor(t['--info']!), parseColor(t['--accent-soft']!))).toBeGreaterThan(0.08);

    // cores dos tipos de anotação: AA (4,5:1) sobre o cartão e distintas entre si
    const notes = NOTES.map((n) => parseColor(t[n]!));
    for (const [i, c] of notes.entries()) {
      expect(contrast(c, parseColor(t['--bg-elev']!)), `${NOTES[i]} sobre --bg-elev`).toBeGreaterThanOrEqual(4.5);
      for (let j = i + 1; j < notes.length; j += 1) expect(distance(c, notes[j]!), `${NOTES[i]} × ${NOTES[j]}`).toBeGreaterThan(0.06);
    }

    // 12 cores de categoria distintas duas a duas
    const ports = PORTS.map((n) => parseColor(t[n]!));
    for (let i = 0; i < ports.length; i += 1) {
      for (let j = i + 1; j < ports.length; j += 1) {
        expect(distance(ports[i]!, ports[j]!), `--port-${i + 1} × --port-${j + 1}`).toBeGreaterThan(0.06);
      }
    }
  });
}

test('logo sem roxo', async ({ page }) => {
  const res = await page.request.get('/logo.svg');
  expect(res.ok()).toBeTruthy();
  const colors = [...(await res.text()).matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]);
  expect(colors.length).toBeGreaterThan(0);
  for (const c of colors) expect(isPurple(parseColor(c)), `${c} no logo é roxo`).toBe(false);
});
