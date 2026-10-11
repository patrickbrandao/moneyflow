import { type ExportTable, t } from '@moneyflow/shared';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { useState } from 'react';
import { downloadCsv, downloadPdf } from '../lib/export';
import { useToast } from './Toast';
import { Button, Menu, MenuItem } from './ui';

/**
 * Botão "Exportar" (CSV ou PDF) de relatórios e listagens. `build` monta a
 * tabela na hora do clique (pode buscar a listagem inteira antes).
 */
export function ExportMenu({
  build,
  disabled,
  size = 'sm',
}: {
  build: () => ExportTable | Promise<ExportTable>;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run(kind: 'csv' | 'pdf') {
    setBusy(true);
    try {
      const table = await build();
      if (kind === 'csv') downloadCsv(table);
      else await downloadPdf(table);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Menu
      align="right"
      trigger={(props) => (
        <Button variant="ghost" size={size === 'md' ? undefined : size} disabled={disabled || busy} {...props}>
          <Download /> {busy ? t.reports.exporting : t.reports.export}
        </Button>
      )}
    >
      <MenuItem icon={<FileSpreadsheet />} onSelect={() => void run('csv')}>
        {t.reports.exportCsv}
      </MenuItem>
      <MenuItem icon={<FileText />} onSelect={() => void run('pdf')}>
        {t.reports.exportPdf}
      </MenuItem>
    </Menu>
  );
}
