import { defineConfig } from 'drizzle-kit';

/*
 * Só para `pnpm db:pull`: o schema Drizzle é GERADO do banco migrado
 * (database/ é a fonte da verdade, ver docs/016). Nunca edite src/generated à mão
 * e nunca use drizzle-kit para gerar migrations.
 *
 * A introspecção usa o dono do banco (o papel da aplicação não enxerga tudo).
 */
export default defineConfig({
  dialect: 'postgresql',
  out: './src/generated',
  schemaFilter: ['public'],
  // A tabela de controle do dbmate não faz parte do domínio.
  tablesFilter: ['!schema_migrations'],
  dbCredentials: {
    url: process.env.DATABASE_OWNER_URL ?? 'postgres://moneyflow:moneyflow@localhost:5432/moneyflow?sslmode=disable',
  },
});
