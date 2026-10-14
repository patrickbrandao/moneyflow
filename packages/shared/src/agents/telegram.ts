/*
 * Resposta do agente no Telegram (spec 029): o markdown da resposta vira o HTML
 * aceito pela Bot API (parse_mode HTML: b, i, s, code, pre, a, blockquote), em
 * partes de até 4096 caracteres que não cortam uma tag no meio. Puro: a API e
 * os testes importam daqui.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export const escapeTelegramHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttr = (text: string) => escapeTelegramHtml(text).replace(/"/g, '&quot;');

/** Formatação de uma linha (sem quebras): código, negrito, itálico, riscado e links. */
export function telegramInline(markdown: string): string {
  const codes: string[] = [];
  // Código em linha primeiro: nada dentro dele é formatado.
  let text = markdown.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  const links: string[] = [];
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeTelegramHtml(label)}</a>`);
    return `\uE001${links.length - 1}\uE001`;
  });
  text = escapeTelegramHtml(text);
  text = text
    .replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)([^_]+?)(?<=\S)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)([^~]+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1<i>$2</i>');
  return text
    .replace(/\uE001(\d+)\uE001/g, (_m, i: string) => links[Number(i)] ?? '')
    .replace(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

type Block = { kind: 'pre'; lines: string[] } | { kind: 'text'; lines: string[] };

/** Blocos do markdown: cercas de código inteiras e parágrafos separados por linha em branco. */
function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  let current: Block | null = null;
  let fence = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        fence = false;
        current = null;
      } else {
        fence = true;
        current = { kind: 'pre', lines: [] };
        out.push(current);
      }
      continue;
    }
    if (fence) {
      current!.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (current?.kind !== 'text') {
      current = { kind: 'text', lines: [] };
      out.push(current);
    }
    current.lines.push(line);
  }
  return out;
}

/** Uma linha de texto em HTML (títulos em negrito, listas com marcador, tabelas sem a linha separadora). */
function lineHtml(line: string): string | null {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
  if (heading) return `<b>${telegramInline(heading[1]!.replace(/\s*#+\s*$/, ''))}</b>`;
  if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return null;
  const table = /^\s*\|(.*)\|\s*$/.exec(line);
  if (table)
    return telegramInline(
      table[1]!
        .split('|')
        .map((cell) => cell.trim())
        .join(' | '),
    );
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${'  '.repeat(Math.floor(bullet[1]!.length / 2))}• ${telegramInline(bullet[2]!)}`;
  if (/^\s*([-*_]\s*){3,}$/.test(line)) return '———';
  return telegramInline(line);
}

function textBlockHtml(lines: string[]): string {
  const quote = lines.every((line) => /^\s*>/.test(line));
  if (quote) {
    const inner = lines.map((line) => lineHtml(line.replace(/^\s*>\s?/, ''))).filter((x): x is string => x !== null);
    return `<blockquote>${inner.join('\n')}</blockquote>`;
  }
  return lines
    .map(lineHtml)
    .filter((x): x is string => x !== null)
    .join('\n');
}

/** Corta um texto já escapado em pedaços de até `limit` (sem cortar uma entidade &amp;). */
function hardSplit(escaped: string, limit: number): string[] {
  const out: string[] = [];
  let rest = escaped;
  while (rest.length > limit) {
    let cut = limit;
    const amp = rest.lastIndexOf('&', cut);
    if (amp > cut - 8 && rest.indexOf(';', amp) >= cut) cut = amp;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** Pedaços de HTML de um bloco, cada um válido sozinho e com até `limit` caracteres. */
function blockPieces(block: Block, limit: number): string[] {
  if (block.kind === 'pre') {
    const body = escapeTelegramHtml(block.lines.join('\n'));
    const room = limit - '<pre></pre>'.length;
    if (body.length <= room) return [`<pre>${body}</pre>`];
    return hardSplit(body, room).map((piece) => `<pre>${piece}</pre>`);
  }
  const html = textBlockHtml(block.lines);
  if (html.length <= limit) return [html];
  // Grande demais: linha a linha; uma linha sozinha acima do limite vai sem formatação.
  const pieces: string[] = [];
  for (const line of block.lines) {
    const one = lineHtml(line.replace(/^\s*>\s?/, ''));
    if (one === null) continue;
    if (one.length <= limit) pieces.push(one);
    else pieces.push(...hardSplit(escapeTelegramHtml(line), limit));
  }
  return pieces;
}

/** Markdown → mensagens em HTML do Telegram (até `limit` caracteres cada; nenhuma vazia). */
export function markdownToTelegramHtml(markdown: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = '';
  for (const block of blocks(markdown)) {
    for (const piece of blockPieces(block, limit)) {
      if (!piece.trim()) continue;
      const next = current ? `${current}\n\n${piece}` : piece;
      if (next.length <= limit) current = next;
      else {
        if (current) messages.push(current);
        current = piece;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}
