import { customType } from 'drizzle-orm/pg-core';

/** `citext` (texto sem distinção de maiúsculas), usado pelo schema gerado. */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});
