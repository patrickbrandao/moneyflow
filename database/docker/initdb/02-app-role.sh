#!/bin/bash
# Papel de login da aplicação (DML apenas). Os GRANTs ficam nas migrations.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_app') THEN
    CREATE ROLE moneyflow_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;
SQL
