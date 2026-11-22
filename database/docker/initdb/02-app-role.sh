#!/bin/bash
# Papel de login da aplicação (DML apenas). Os GRANTs ficam nas migrations.
#
# Roda no primeiro boot do volume (docker-entrypoint-initdb.d) e é idempotente: `make owner` o executa de novo num
# volume antigo. A senha só é definida ao criar o papel.
#
# Rede de segurança fora da aplicação (tarefa 102): o servidor encerra a transação ociosa do papel da aplicação depois
# de 5 minutos. Os outros prazos (statement_timeout, lock_timeout, espera por conexão) ficam no pool da aplicação.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_app') THEN
    CREATE ROLE moneyflow_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;
ALTER ROLE moneyflow_app SET idle_in_transaction_session_timeout = '5min';
SQL
