import { customType } from 'drizzle-orm/pg-core';

/**
 * `tsvector` (busca textual das mensagens dos agentes), usado pelo schema gerado.
 * A coluna é gerada no banco: nunca selecione nem grave (liste as colunas).
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
