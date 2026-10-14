/*
 * Camada de texto de um PDF (spec 024), extraída no servidor com pdf.js: é o
 * que vai ao modelo de texto quando o agente não tem visão. Um PDF escaneado
 * (só imagem) volta vazio. Sem worker: o "worker" do pdf.js roda na própria
 * thread (globalThis.pdfjsWorker), o que também funciona dentro do bundle
 * único da API/worker (dist/main.mjs).
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfJs> | null = null;

/** Classe vazia: só para o pdf.js carregar sem o @napi-rs/canvas (nativo, fora do bundle). A extração de texto não desenha. */
class Unused {}

async function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const g = globalThis as Record<string, unknown>;
    // O pdf.js cria um DOMMatrix ao carregar; sem o canvas nativo, ele só avisa e quebraria aqui.
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) g[name] ??= Unused;
    // O aviso "Cannot load @napi-rs/canvas" sai uma vez ao carregar: não interessa à extração de texto.
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('Warning: Cannot load "@napi-rs/canvas"')) return;
      warn(...args);
    };
    try {
      g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.warn = warn;
    }
  })();
  return loading;
}

/** Limite de páginas lidas (um PDF enorme não trava a execução). */
const MAX_PAGES = 300;
/** Limite do texto devolvido (ai_attachment_derivatives.content aceita até 5 milhões). */
export const MAX_PDF_TEXT = 1_000_000;

export async function extractPdfText(data: Buffer): Promise<string> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let size = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES) && size < MAX_PDF_TEXT; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        text += item.hasEOL ? '\n' : ' ';
      }
      // O text do banco não aceita o caractere nulo.
      const clean = text
        .replaceAll(String.fromCharCode(0), '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (clean) {
        pages.push(clean);
        size += clean.length;
      }
      page.cleanup();
    }
    return pages.join('\n\n').slice(0, MAX_PDF_TEXT);
  } finally {
    await task.destroy();
  }
}
