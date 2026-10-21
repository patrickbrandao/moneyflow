#!/usr/bin/env node
/*
 * Gera os sons dos lembretes (spec 035) em apps/web/public/sounds: WAV PCM
 * 16 bits mono, curtos (1 a 2 s), sintetizados aqui — sem fonte externa, de
 * domínio público. Fica fora do bundle (scripts/ não é importado pelo app);
 * rode de novo só para mudar um som:
 *
 *   node apps/web/scripts/generate-sounds.mjs
 *
 * O manifest.json é escrito à mão (chave, nome, arquivo, licença); este
 * script só (re)gera os arquivos das chaves abaixo.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22_050;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32_767), i * 2);
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const buffer = (seconds) => new Float64Array(Math.round(seconds * RATE));

/** Soma um tom com envelope (ataque curto e decaimento exponencial) a partir de `at` segundos. */
function tone(out, { at = 0, freq, dur, gain = 0.5, decay = 4, attack = 0.005, shape = 'sine' }) {
  const start = Math.round(at * RATE);
  const n = Math.round(dur * RATE);
  for (let i = 0; i < n && start + i < out.length; i += 1) {
    const t = i / RATE;
    const env = Math.min(1, t / attack) * Math.exp(-decay * t) * Math.min(1, (dur - t) / 0.01);
    const phase = 2 * Math.PI * freq * t;
    const wave = shape === 'square' ? Math.tanh(4 * Math.sin(phase)) * 0.6 : Math.sin(phase);
    out[start + i] += wave * env * gain;
  }
}

const sounds = {
  // Sino: parciais inarmônicos de um sino pequeno, decaindo devagar.
  bell() {
    const out = buffer(1.8);
    for (const [ratio, gain, decay] of [
      [1, 0.45, 2.2],
      [2.0, 0.22, 3],
      [2.76, 0.16, 4],
      [5.4, 0.08, 6],
    ]) {
      tone(out, { freq: 784 * ratio, dur: 1.8, gain, decay });
    }
    return out;
  },
  // Bipe: dois bipes médios.
  beep() {
    const out = buffer(1.0);
    tone(out, { at: 0, freq: 1000, dur: 0.16, gain: 0.45, decay: 0, shape: 'square' });
    tone(out, { at: 0.26, freq: 1000, dur: 0.16, gain: 0.45, decay: 0, shape: 'square' });
    return out;
  },
  // Carrilhão: três notas subindo (dó, mi, sol).
  chime() {
    const out = buffer(1.6);
    [1046.5, 1318.5, 1568].forEach((freq, i) => {
      tone(out, { at: i * 0.22, freq, dur: 1.6 - i * 0.22, gain: 0.32, decay: 2.8 });
      tone(out, { at: i * 0.22, freq: freq * 2, dur: 0.6, gain: 0.06, decay: 6 });
    });
    return out;
  },
  // Digital: o despertador de relógio, quatro bipes agudos rápidos.
  digital() {
    const out = buffer(1.0);
    for (let i = 0; i < 4; i += 1) tone(out, { at: i * 0.12, freq: 2048, dur: 0.07, gain: 0.35, decay: 0, shape: 'square' });
    return out;
  },
};

for (const [key, make] of Object.entries(sounds)) {
  const file = join(OUT, `${key}.wav`);
  writeFileSync(file, wav(Array.from(make())));
  console.log(file);
}
