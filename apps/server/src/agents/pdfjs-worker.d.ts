/** O "worker" do pdf.js roda na própria thread (pdf-text.ts); o pacote não tem tipos para este módulo. */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
