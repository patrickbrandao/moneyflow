#!/bin/bash
# Cria o banco de testes ao lado do banco principal (só no primeiro boot do volume).
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DB}_test OWNER ${POSTGRES_USER};
SQL
