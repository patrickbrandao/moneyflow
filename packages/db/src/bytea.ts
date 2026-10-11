import { customType } from 'drizzle-orm/pg-core';

/** `bytea` (conteúdo binário dos anexos), usado pelo schema gerado. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
