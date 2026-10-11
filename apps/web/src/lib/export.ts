import { CSV_BOM, type ExportTable, formatCell, formatDateTime, t, toCsv } from '@moneyflow/shared';

/*
 * Exportação no navegador (spec 014). Decisão: CSV e PDF são gerados no
 * cliente a partir da mesma ExportTable (packages/shared/src/export.ts), com os
 * dados que a API já devolve para a tela — sem rota de exportação nem fonte
 * de PDF no servidor. O PDF usa jsPDF + jspdf-autotable, carregados sob demanda
 * (import dinâmico: não pesam no bundle inicial). As listagens exportam o que
 * os filtros atuais trazem, até o limite da API (1000 linhas).
 */

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(table: ExportTable) {
  save(new Blob([CSV_BOM, toCsv(table)], { type: 'text/csv;charset=utf-8' }), `${table.fileName}.csv`);
}

/** O PDF usa as fontes padrão (WinAnsi): troca o que não existe nelas. */
const pdfText = (text: string) => text.replace(/−/g, '-').replace(/[  ]/g, ' ');

/** Tons neutros do PDF (impresso em papel branco; não é interface, não usa tokens). */
const PDF_INK: [number, number, number] = [32, 32, 40];
const PDF_MUTED: [number, number, number] = [110, 110, 122];
const PDF_HEAD: [number, number, number] = [236, 234, 242];
const PDF_LINE: [number, number, number] = [214, 212, 222];

export async function downloadPdf(table: ExportTable) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const landscape = table.columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const margin = 36;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...PDF_INK);
  doc.text(pdfText(table.title), margin, margin + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...PDF_MUTED);
  const sub = [...(table.subtitle ?? []), t.reports.generatedAt(formatDateTime(new Date()))];
  sub.forEach((line, i) => {
    doc.text(pdfText(line), margin, margin + 22 + i * 12);
  });
  const bold = new Set(table.boldRows ?? []);
  const numeric = (type?: string) => type === 'money' || type === 'int' || type === 'percent';

  autoTable(doc, {
    startY: margin + 30 + sub.length * 12,
    margin: { left: margin, right: margin, bottom: margin + 10 },
    head: [table.columns.map((c) => pdfText(c.label))],
    body: table.rows.map((row) => table.columns.map((c) => pdfText(formatCell(row[c.key], c.type, 'display')))),
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 3, textColor: PDF_INK, lineColor: PDF_LINE, lineWidth: 0.5 },
    headStyles: { fillColor: PDF_HEAD, textColor: PDF_INK, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(table.columns.map((c, i) => [i, numeric(c.type) ? { halign: 'right' } : {}])),
    didParseCell: (data) => {
      if (data.section === 'body' && bold.has(data.row.index)) data.cell.styles.fontStyle = 'bold';
      if (data.section === 'head' && numeric(table.columns[data.column.index]?.type)) data.cell.styles.halign = 'right';
    },
  });
  const pages = doc.getNumberOfPages();
  const size = doc.internal.pageSize;
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(...PDF_MUTED);
    doc.text(pdfText(`${t.app.name} · ${table.title} · ${t.reports.page(page, pages)}`), margin, size.getHeight() - margin / 2);
  }
  save(doc.output('blob'), `${table.fileName}.pdf`);
}
