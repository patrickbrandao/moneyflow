import { t } from '@moneyflow/shared';
import { ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

export type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => {
      promise: Promise<void>;
      cancel: () => void;
    };
  }>;
  destroy: () => Promise<void>;
};

/** pdf.js sob demanda (não pesa no bundle inicial), com o worker servido pelo Vite. */
export async function loadPdf(url: string): Promise<PdfDocument> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // Só o canvas da página (somente leitura): sem a camada de formulários nem o scripting do PDF.
  const task = pdfjs.getDocument({ url, withCredentials: true });
  return (await task.promise) as unknown as PdfDocument;
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
    let loaded: PdfDocument | null = null;
    setDoc(null);
    setError(false);
    setPage(1);
    loadPdf(url)
      .then((pdf) => {
        loaded = pdf;
        if (cancelled) void pdf.destroy();
        else setDoc(pdf);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
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
