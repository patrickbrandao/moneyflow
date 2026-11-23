import { t } from '@moneyflow/shared';
import { ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

/**
 * O documento aberto. O pdf.js 6 tirou o `destroy()` do documento: quem o
 * solta é a tarefa de carregamento (`PdfLoad.destroy`, abaixo).
 */
export type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => {
      promise: Promise<void>;
      cancel: () => void;
    };
  }>;
};

type PdfRuntime = {
  getDocument: (src: { url: string; withCredentials: boolean }) => {
    promise: Promise<unknown>;
    destroy: () => Promise<void>;
  };
};

let runtime: Promise<PdfRuntime> | null = null;

/**
 * pdf.js sob demanda (não pesa no bundle inicial), com o worker servido pelo
 * Vite. Um só worker por aba (tarefa 121): sem ele, cada documento abria um
 * `new Worker` próprio, vivo até o `destroy`. Os documentos abertos nele não o
 * encerram ao serem soltos (o `loadingTask.destroy` só encerra o worker que
 * ele mesmo criou).
 */
function pdfRuntime(): Promise<PdfRuntime> {
  if (!runtime) {
    runtime = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, src]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = src.default;
      const worker = new pdfjs.PDFWorker();
      return { getDocument: (params) => pdfjs.getDocument({ ...params, worker }) };
    });
    // Falhou ao baixar o pdf.js (rede): a próxima abertura tenta de novo.
    runtime.catch(() => {
      runtime = null;
    });
  }
  return runtime;
}

/** Um PDF aberto no worker da aba. `destroy` solta o documento antes ou depois de carregar (o worker fica). */
export type PdfLoad = { promise: Promise<PdfDocument>; destroy: () => Promise<void> };

export function openPdf(url: string): PdfLoad {
  let task: { destroy: () => Promise<void> } | null = null;
  let destroyed = false;
  const promise = pdfRuntime().then(({ getDocument }) => {
    if (destroyed) throw new Error('pdf: carregamento cancelado');
    // Só o canvas da página (somente leitura): sem a camada de formulários nem o scripting do PDF.
    const loading = getDocument({ url, withCredentials: true });
    task = loading;
    return loading.promise as Promise<PdfDocument>;
  });
  return {
    promise,
    destroy: async () => {
      destroyed = true;
      const current = task;
      task = null;
      await current?.destroy().catch(() => undefined);
    },
  };
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Visualizador somente leitura (paginação e zoom) do PDF de um contrato (spec 020) e dos anexos do chat (spec 025). */
export function PdfViewer({ url, downloadUrl }: { url: string; downloadUrl: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(2);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(false);
    setPage(1);
    const load = openPdf(url);
    load.promise.then((pdf) => !cancelled && setDoc(pdf)).catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      void load.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!doc || !canvas.current) return;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;
    let cancelled = false;
    void doc.getPage(page).then((p) => {
      if (cancelled || !canvas.current) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: ZOOMS[zoom]! * ratio });
      const el = canvas.current;
      el.width = viewport.width;
      el.height = viewport.height;
      el.style.width = `${viewport.width / ratio}px`;
      el.style.height = `${viewport.height / ratio}px`;
      const context = el.getContext('2d');
      if (!context) return;
      task = p.render({ canvasContext: context, viewport, canvas: el });
      task.promise.catch(() => null);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom]);

  const D = t.contracts.documents;
  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <Button size="sm" variant="ghost" disabled={!doc || page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={D.prevPage}>
          <ChevronLeft />
        </Button>
        <span className="mono text-xs" aria-live="polite">
          {doc ? D.page(page, doc.numPages) : D.pdfLoading}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!doc || page >= doc.numPages}
          onClick={() => setPage((p) => p + 1)}
          aria-label={D.nextPage}
        >
          <ChevronRight />
        </Button>
        <span className="pdf-sep" />
        <Button size="sm" variant="ghost" disabled={zoom <= 0} onClick={() => setZoom((z) => z - 1)} aria-label={D.zoomOut}>
          <ZoomOut />
        </Button>
        <span className="mono w-12 text-center text-xs">{Math.round(ZOOMS[zoom]! * 100)}%</span>
        <Button size="sm" variant="ghost" disabled={zoom >= ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)} aria-label={D.zoomIn}>
          <ZoomIn />
        </Button>
        <a className="btn btn-ghost btn-sm ml-auto" href={downloadUrl}>
          <Download /> {D.download}
        </a>
      </div>
      <div className="pdf-stage">
        {error ? <p className="notice warn">{D.pdfError}</p> : <canvas ref={canvas} aria-label={D.pdfViewer} />}
      </div>
    </div>
  );
}
