import { inflateRawSync } from 'node:zlib';
import { t } from '@moneyflow/shared';
import type { Config } from '../../config';
import { AppError } from '../../errors';

/*
 * Extração limitada dos .zip de backup e de dump (tarefa 055). O teto vale para a soma dos bytes
 * descompactados das entradas escolhidas, contados de verdade: o tamanho declarado no zip só serve
 * para recusar antes de começar, e o inflate do zlib para no teto (`maxOutputLength`), então um
 * tamanho falso não faz a memória crescer. O índice é o diretório central (com zip64), como no
 * unzipSync do fflate: nada de procurar assinaturas no meio dos dados.
 */

/** Teto da descompactação: 4× o limite de upload do backup. */
export const backupUnzipLimit = (config: Pick<Config, 'backupMaxUploadBytes'>) => 4 * config.backupMaxUploadBytes;

/** O conteúdo descompactado passa do teto. */
export class UnzipTooLarge extends AppError {
  constructor() {
    super(413, 'unzipped_too_large', t.backup.errors.unzippedTooLarge);
  }
}

/** Zip malformado (o chamador traduz para o erro de arquivo inválido dele). */
export class UnzipInvalid extends Error {}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

const u64 = (buf: Buffer, at: number) => {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnzipInvalid('zip64 fora do alcance');
  return Number(value);
};

type ZipEntry = { name: string; method: number; size: number; original: number; local: number };

const guarded = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UnzipInvalid) throw error;
    throw new UnzipInvalid(error instanceof Error ? error.message : 'zip inválido');
  }
};

/** As entradas do diretório central (sem ler os dados). */
function centralDirectory(body: Buffer): ZipEntry[] {
  const read = guarded;

  // Fim do diretório central: nos últimos 22 + 65535 bytes (o comentário do zip vai até 64 KB).
  let eocd = body.length - 22;
  const floor = Math.max(0, body.length - 22 - 0xffff);
  while (eocd >= floor && (eocd < 0 || body.readUInt32LE(eocd) !== EOCD)) eocd -= 1;
  if (eocd < floor) throw new UnzipInvalid('sem diretório central');

  let { count, offset } = read(() => ({ count: body.readUInt16LE(eocd + 10), offset: body.readUInt32LE(eocd + 16) }));
  if ((count === 0xffff || offset === MAX32) && eocd >= 20 && body.readUInt32LE(eocd - 20) === EOCD64_LOCATOR) {
    const at64 = read(() => u64(body, eocd - 20 + 8));
    read(() => {
      if (body.readUInt32LE(at64) !== EOCD64) throw new UnzipInvalid('zip64 sem o fim do diretório');
      count = u64(body, at64 + 32);
      offset = u64(body, at64 + 48);
    });
  }

  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    entries.push(
      read(() => {
        if (body.readUInt32LE(at) !== CENTRAL) throw new UnzipInvalid('entrada do diretório inválida');
        const flags = body.readUInt16LE(at + 8);
        const method = body.readUInt16LE(at + 10);
        let size = body.readUInt32LE(at + 20);
        let original = body.readUInt32LE(at + 24);
        const nameLength = body.readUInt16LE(at + 28);
        const extraLength = body.readUInt16LE(at + 30);
        const commentLength = body.readUInt16LE(at + 32);
        let local = body.readUInt32LE(at + 42);
        const nameEnd = at + 46 + nameLength;
        if (nameEnd > body.length) throw new UnzipInvalid('nome fora do arquivo');
        const name = body.subarray(at + 46, nameEnd).toString(flags & 0x800 ? 'utf8' : 'latin1');
        // Extra zip64 (id 1): os campos que estão em 0xFFFFFFFF, nesta ordem.
        for (let x = nameEnd; x + 4 <= nameEnd + extraLength; ) {
          const id = body.readUInt16LE(x);
          const length = body.readUInt16LE(x + 2);
          if (id === 1) {
            let y = x + 4;
            if (original === MAX32) {
              original = u64(body, y);
              y += 8;
            }
            if (size === MAX32) {
              size = u64(body, y);
              y += 8;
            }
            if (local === MAX32) local = u64(body, y);
          }
          x += 4 + length;
        }
        at = nameEnd + extraLength + commentLength;
        return { name, method, size, original, local };
      }),
    );
  }
  return entries;
}

/** Os bytes de uma entrada, no máximo `maxBytes` (contados no inflate). */
function extractEntry(body: Buffer, entry: ZipEntry, maxBytes: number): Uint8Array {
  // O declarado já passa do teto: recusa sem ler nada.
  if (entry.original > maxBytes) throw new UnzipTooLarge();
  const data = guarded(() => {
    if (body.readUInt32LE(entry.local) !== LOCAL) throw new UnzipInvalid('cabeçalho local inválido');
    const start = entry.local + 30 + body.readUInt16LE(entry.local + 26) + body.readUInt16LE(entry.local + 28);
    if (start + entry.size > body.length) throw new UnzipInvalid('dados fora do arquivo');
    return body.subarray(start, start + entry.size);
  });
  if (entry.method === 0) {
    if (data.length > maxBytes) throw new UnzipTooLarge();
    // Sem compressão: a fatia do próprio upload, sem cópia.
    return data;
  }
  if (entry.method === 8) {
    let content: Uint8Array;
    try {
      // Conta os bytes de verdade: o inflate para ao passar do teto.
      content = inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new UnzipTooLarge();
      throw new UnzipInvalid(error instanceof Error ? error.message : 'deflate inválido');
    }
    if (content.length > maxBytes) throw new UnzipTooLarge();
    return content;
  }
  throw new UnzipInvalid(`compressão ${entry.method} não suportada`);
}

/** Extrai as entradas cujo nome passa no filtro, com a soma limitada a `maxBytes`. */
export function unzipLimited(body: Buffer, accept: (name: string) => boolean, maxBytes: number): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  for (const entry of centralDirectory(body)) {
    if (!accept(entry.name)) continue;
    const content = extractEntry(body, entry, maxBytes - total);
    // Sem compressão, a fatia é copiada: o resultado não segura o upload inteiro.
    const owned = entry.method === 0 ? new Uint8Array(content) : content;
    total += owned.length;
    out[entry.name] = owned;
  }
  return out;
}

/**
 * Leitor sob demanda das entradas aceitas (os anexos do JSON completo, tarefa 077): o índice vem do
 * diretório central, e cada entrada é extraída só quando pedida, no máximo `maxBytes` por entrada.
 * Uma entrada sem compressão sai como fatia do upload, sem cópia. Nome ausente: null.
 */
export function zipEntryReader(body: Buffer, accept: (name: string) => boolean, maxBytes: number) {
  const index = new Map<string, ZipEntry>();
  for (const entry of centralDirectory(body)) if (accept(entry.name) && !index.has(entry.name)) index.set(entry.name, entry);
  return {
    size: index.size,
    read(name: string): Uint8Array | null {
      const entry = index.get(name);
      return entry ? extractEntry(body, entry, maxBytes) : null;
    },
  };
}

export type ZipEntryReader = ReturnType<typeof zipEntryReader>;
