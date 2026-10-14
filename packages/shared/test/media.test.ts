import { describe, expect, it } from 'vitest';
import { chatMime, formatDuration, markdownToSpeech, SPEECH_CHAR_LIMIT, splitSpeech } from '../src/agents/media';

/* Chat multimídia (spec 025): tipo do arquivo, duração, markdown falado e divisão no limite do provedor. */

describe('chatMime', () => {
  it('normaliza sinônimos, usa a extensão sem tipo e trata a gravação do Safari', () => {
    expect(chatMime('nota.m4a', 'application/octet-stream')).toBe('audio/mp4');
    expect(chatMime('nota.m4a', 'audio/x-m4a')).toBe('audio/mp4');
    expect(chatMime('voz.wav', 'audio/x-wav')).toBe('audio/wav');
    expect(chatMime('notas.md', '')).toBe('text/markdown');
    expect(chatMime('notas.md', 'text/plain')).toBe('text/markdown');
    expect(chatMime('gravacao.webm', 'audio/webm;codecs=opus')).toBe('audio/webm');
    expect(chatMime('gravacao.mp4', 'video/mp4')).toBe('audio/mp4');
    expect(chatMime('foto.PNG', 'IMAGE/PNG')).toBe('image/png');
    expect(chatMime('sem-extensao', '')).toBe('application/octet-stream');
  });
});

describe('formatDuration', () => {
  it('m:ss e h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_400)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('0:00');
  });
});

describe('markdownToSpeech', () => {
  it('omite tabelas e código, deixa o texto dos links e tira as marcas', () => {
    const md =
      '## Título\n\nTexto com **negrito**, _itálico_ e [link](https://a.b).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sql\nselect 1;\n```\n\n1. primeiro\n- [x] feito';
    expect(markdownToSpeech(md)).toBe(
      'Título\n\nTexto com negrito, itálico e link.\n\ntabela omitida.\n\ncódigo omitido.\n\nprimeiro\nfeito',
    );
  });
});

describe('splitSpeech', () => {
  it('divide em trechos de até o limite, nas frases', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Frase ${i} do texto.`).join(' ');
    const parts = splitSpeech(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(500);
      expect(part.endsWith('.')).toBe(true);
    }
    expect(parts.join(' ')).toBe(text);
    expect(splitSpeech('curto')).toEqual(['curto']);
    expect(SPEECH_CHAR_LIMIT).toBe(4096);
  });
});
