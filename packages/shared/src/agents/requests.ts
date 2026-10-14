/*
 * Requisições ao provedor (spec 023): o cURL do detalhe (sem a chave) e a
 * detecção do base64 nos corpos (imagens, PDFs, áudios), que o visualizador
 * JSON mostra recolhido com o tamanho, com "ver/ouvir" e "baixar".
 */

/** Valor que a aplicação e o banco põem no lugar das credenciais nos cabeçalhos. */
export const OMITTED_HEADER = '[omitido]';

/** Cabeçalhos que o cURL não repete (o próprio curl calcula ou negocia). */
const SKIP_CURL_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'transfer-encoding']);

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Placeholder da credencial no cURL: a chave nunca sai do servidor. */
function credentialPlaceholder(name: string, kind: 'anthropic' | 'openai' | null): string {
  const env = kind === 'anthropic' ? '$ANTHROPIC_API_KEY' : kind === 'openai' ? '$OPENAI_API_KEY' : '$API_KEY';
  if (name === 'authorization') return `Bearer ${env}`;
  if (name === 'x-api-key' || name === 'api-key') return env;
  return '$SEGREDO';
}

/**
 * "Copiar como cURL": método, URL, cabeçalhos gravados (as credenciais viram
 * variáveis de ambiente) e o corpo. Sem cabeçalhos gravados (log_bodies
 * desligado), põe só o da chave e o content-type.
 */
export function buildCurl(input: {
  method: string;
  url: string;
  headers: Record<string, string> | null;
  body: string | null;
  providerKind: 'anthropic' | 'openai' | null;
}): string {
  const lines = [`curl -X ${input.method.toUpperCase()} ${shellQuote(input.url)}`];
  const headers: Record<string, string> = {};
  if (input.headers && Object.keys(input.headers).length > 0) {
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (SKIP_CURL_HEADERS.has(lower)) continue;
      headers[lower] = value === OMITTED_HEADER ? credentialPlaceholder(lower, input.providerKind) : value;
    }
  } else {
    if (input.providerKind === 'anthropic') {
      headers['x-api-key'] = credentialPlaceholder('x-api-key', 'anthropic');
      headers['anthropic-version'] = '2023-06-01';
    } else headers.authorization = credentialPlaceholder('authorization', input.providerKind);
    if (input.body !== null) headers['content-type'] = 'application/json';
  }
  for (const [name, value] of Object.entries(headers)) {
    // Variáveis de ambiente entre aspas duplas para o shell expandir.
    lines.push(value.includes('$') ? `  -H "${name}: ${value.replace(/"/g, '\\"')}"` : `  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (input.body !== null && input.body !== '') lines.push(`  --data-raw ${shellQuote(input.body)}`);
  return lines.join(' \\\n');
}

export type Base64Kind = 'image' | 'audio' | 'pdf' | 'other';
export type Base64Info = { mime: string | null; kind: Base64Kind; bytes: number; data: string };

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]+={0,2})$/;
const RAW_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Tamanho mínimo de um texto "base64 puro" para recolher (evita confundir ids e palavras). */
const MIN_RAW = 256;

const AUDIO_FORMATS: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

const kindOf = (mime: string | null): Base64Kind =>
  !mime
    ? 'other'
    : mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime === 'application/pdf'
          ? 'pdf'
          : 'other';

const decodedBytes = (data: string) =>
  Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));

/**
 * Base64 de um valor do corpo: data URL (`data:image/png;base64,…`) ou texto
 * base64 longo; o tipo vem do data URL ou dos irmãos (`media_type`,
 * `mime_type`, `format` do áudio). null = não é base64.
 */
export function detectBase64(value: string, siblings?: Record<string, unknown> | null): Base64Info | null {
  const dataUrl = DATA_URL.exec(value);
  if (dataUrl) {
    const mime = dataUrl[1]!.toLowerCase();
    return { mime, kind: kindOf(mime), bytes: decodedBytes(dataUrl[2]!), data: dataUrl[2]! };
  }
  // Documento de texto (source.type = text) nunca é base64, mesmo com media_type.
  if (siblings?.type === 'text') return null;
  let mime: string | null = null;
  const media = siblings?.media_type ?? siblings?.mime_type ?? siblings?.mimeType;
  if (typeof media === 'string' && /^[a-z]+\/[\w.+-]+$/i.test(media)) mime = media.toLowerCase();
  const format = siblings?.format;
  if (!mime && typeof format === 'string' && AUDIO_FORMATS[format.toLowerCase()]) mime = AUDIO_FORMATS[format.toLowerCase()]!;
  // Com o tipo declarado ao lado (source.type = base64, media_type), até um arquivo pequeno é base64.
  const declared = mime !== null || siblings?.type === 'base64';
  if (value.length < (declared ? 8 : MIN_RAW) || value.length % 4 !== 0 || !RAW_BASE64.test(value)) return null;
  return { mime, kind: kindOf(mime), bytes: decodedBytes(value), data: value };
}

/** Extensão sugerida para baixar o arquivo de um base64. */
export function base64Extension(mime: string | null): string {
  if (!mime) return 'bin';
  const sub = mime.split('/')[1] ?? 'bin';
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'mpeg') return 'mp3';
  if (sub === 'plain') return 'txt';
  return sub.replace(/[^a-z0-9]/gi, '') || 'bin';
}
