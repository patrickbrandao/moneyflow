/*
 * Chat multimídia (spec 025): tipos de arquivo do chat, a duração "m:ss", o
 * markdown convertido em texto falado e a divisão do texto no limite do
 * provedor de texto→áudio. Usado pela API (upload, execução, TTS) e pelo front
 * (prévias, player, gravação).
 */

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const PDF_MIME = 'application/pdf';
export const MARKDOWN_MIME = 'text/markdown';

/** Extensões reconhecidas quando o navegador manda o arquivo sem tipo (ou como octet-stream). */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: PDF_MIME,
  md: MARKDOWN_MIME,
  markdown: MARKDOWN_MIME,
  // Arquivos de importação (spec 027): extrato e NF-e vão ao modelo como texto.
  ofx: 'application/x-ofx',
  csv: 'text/csv',
  xml: 'application/xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/** Sinônimos que os navegadores e sistemas usam para os mesmos formatos de áudio. */
const MIME_ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/opus': 'audio/ogg',
  'text/x-markdown': MARKDOWN_MIME,
};

const extensionOf = (fileName: string) => /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';

/**
 * Tipo do arquivo do chat, sem parâmetros e em minúsculas: os sinônimos viram
 * o tipo canônico; sem tipo (ou octet-stream/text/plain de um .md), vale a
 * extensão. A gravação do Safari (video/mp4 só com áudio) vira audio/mp4.
 */
export function chatMime(fileName: string, mime: string | null | undefined): string {
  let clean = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  clean = MIME_ALIASES[clean] ?? clean;
  const ext = extensionOf(fileName);
  const byExt = MIME_BY_EXTENSION[ext];
  if (!clean || clean === 'application/octet-stream' || clean === 'binary/octet-stream') return byExt ?? 'application/octet-stream';
  if (clean === 'text/plain' && byExt === MARKDOWN_MIME) return MARKDOWN_MIME;
  if (clean === 'video/webm' || clean === 'video/mp4') return clean.replace('video/', 'audio/');
  return clean;
}

export const isImageMime = (mime: string) => (IMAGE_MIMES as readonly string[]).includes(mime);
export const isPdfMime = (mime: string) => mime === PDF_MIME;
export const isAudioMime = (mime: string) => mime.startsWith('audio/');
export const isMarkdownMime = (mime: string) => mime === MARKDOWN_MIME;

/** Duração "m:ss" (ou "h:mm:ss"). */
export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? Number(ms) : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* ---------------- gravação e player ---------------- */

/** Gravação pelo microfone: até 10 minutos, com aviso aos 9. */
export const RECORDING_MAX_MS = 10 * 60 * 1000;
export const RECORDING_WARN_MS = 9 * 60 * 1000;

/** Velocidades do player (1x é o padrão), lembradas no navegador. */
export const AUDIO_RATES = [0.5, 1, 1.5, 2, 2.5, 3] as const;
export const AUDIO_RATE_STORAGE_KEY = 'moneyflow:audio-rate';

/** A transcrição recolhe acima de 6 linhas. */
export const TRANSCRIPTION_COLLAPSE_LINES = 6;

/* ---------------- texto→áudio ---------------- */

/** Limite de caracteres por chamada de texto→áudio (OpenAI: 4096). */
export const SPEECH_CHAR_LIMIT = 4096;

export const SPEECH_OMITTED = { table: 'tabela omitida', code: 'código omitido' } as const;

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

/**
 * Markdown → texto corrido para a fala: tabelas e blocos de código viram
 * "tabela omitida" e "código omitido", links e imagens ficam só com o texto,
 * e somem as marcas (títulos, ênfase, listas, citações, HTML).
 */
export function markdownToSpeech(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) i += 1;
      i += 1;
      out.push(`${SPEECH_OMITTED.code}.`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) i += 1;
      out.push(`${SPEECH_OMITTED.table}.`);
      continue;
    }
    // Bloco indentado (4 espaços) depois de linha em branco: código.
    if (/^( {4}|\t)\S/.test(line) && (out.length === 0 || out[out.length - 1] === '')) {
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || lines[i]!.trim() === '')) i += 1;
      out.push(`${SPEECH_OMITTED.code}.`);
      continue;
    }
    out.push(inlineToSpeech(line));
    i += 1;
  }
  return out
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineToSpeech(line: string): string {
  return (
    line
      // Linha horizontal.
      .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')
      // Títulos, citações e marcadores de lista.
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(>\s*)+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      // Imagens e links: só o texto.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // HTML.
      .replace(/<\/?[a-z][^>]*>/gi, '')
      // Código em linha: fica o texto.
      .replace(/`+([^`]*)`+/g, '$1')
      // Ênfase e tachado.
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
  );
}

/**
 * Divide o texto em trechos de até `limit` caracteres, nas quebras de
 * parágrafo, de frase ou de palavra (nessa ordem de preferência).
 */
export function splitSpeech(text: string, limit = SPEECH_CHAR_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5)
      cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n')) + 1;
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** Tamanho de arquivo legível (B, KB, MB), em pt-BR. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}
