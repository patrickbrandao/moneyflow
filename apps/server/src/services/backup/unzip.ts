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

/** Extrai as entradas cujo nome passa no filtro, com a soma limitada a `maxBytes`. */
export function unzipLimited(body: Buffer, accept: (name: string) => boolean, maxBytes: number): Record<string, Uint8Array> {
  const read = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof UnzipInvalid) throw error;
      throw new UnzipInvalid(error instanceof Error ? error.message : 'zip inválido');
    }
  };

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

  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    const entry = read(() => {
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
    });
    if (!accept(entry.name)) continue;
    const remaining = maxBytes - total;
    // O declarado já passa do teto: recusa sem ler nada.
    if (entry.original > remaining) throw new UnzipTooLarge();
    const data = read(() => {
      if (body.readUInt32LE(entry.local) !== LOCAL) throw new UnzipInvalid('cabeçalho local inválido');
      const start = entry.local + 30 + body.readUInt16LE(entry.local + 26) + body.readUInt16LE(entry.local + 28);
      if (start + entry.size > body.length) throw new UnzipInvalid('dados fora do arquivo');
      return body.subarray(start, start + entry.size);
    });
    let content: Uint8Array;
    if (entry.method === 0) {
      if (data.length > remaining) throw new UnzipTooLarge();
      content = new Uint8Array(data);
    } else if (entry.method === 8) {
      try {
        // Conta os bytes de verdade: o inflate para ao passar do que resta do teto.
        content = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new UnzipTooLarge();
        throw new UnzipInvalid(error instanceof Error ? error.message : 'deflate inválido');
      }
      if (content.length > remaining) throw new UnzipTooLarge();
    } else {
      throw new UnzipInvalid(`compressão ${entry.method} não suportada`);
    }
    total += content.length;
    out[entry.name] = content;
  }
  return out;
}
