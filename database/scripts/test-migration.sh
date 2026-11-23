#!/bin/bash
# Testa uma migration com dados (make test-migration M=NNNN): recria o banco <db>_mig, aplica as migrations
# anteriores a NNNN, carrega migration-tests/NNNN_*/fixture.sql e roda subida → after_up.sql → descida →
# after_down.sql → subida → after_up.sql (com :pass = 2). As conferências são pgTAP; qualquer "not ok" ou erro de
# SQL falha o script. O banco <db>_mig fica no fim para inspeção.
#
# Como em produção e no make test (tarefas 054 e 165): o banco nasce com dono moneyflow_owner, o 03-owner-role.sh
# prepara as extensões, e TODAS as migrations (as anteriores e a testada, nos dois sentidos) rodam como o dono, sem
# superusuário. Uma migration que só passa como superusuário (DISABLE TRIGGER ALL, session_replication_role, objeto de
# outro dono) falha aqui. O fixture e as conferências rodam como o superusuário (o fixture pode precisar dele).
set -euo pipefail
cd "$(dirname "$0")/.."
n="${1:?uso: test-migration.sh NNNN}"
dir=$(ls -d migration-tests/"${n}"_*/ 2>/dev/null | head -1)
file=$(ls migrations/"${n}"_*.sql 2>/dev/null | head -1)
[[ -n "$dir" && -n "$file" ]] || { echo "faltam migrations/${n}_*.sql ou migration-tests/${n}_*/" >&2; exit 1; }
[[ -f .env ]] && set -a && . ./.env && set +a
user="${POSTGRES_USER:-moneyflow}"
owner_password="${OWNER_DB_PASSWORD:-moneyflow_owner}"
db="${POSTGRES_DB:-moneyflow}_mig"

# Superusuário: criar o banco, o fixture e as conferências.
sql() { docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$user" "$@"; }
# Dono do banco: as migrations.
owner_sql() {
  docker compose exec -T -e PGPASSWORD="$owner_password" postgres \
    psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U moneyflow_owner "$@"
}
section() { awk -v want="$1" '/^-- migrate:up/{f=(want=="up");next} /^-- migrate:down/{f=(want=="down");next} f' "$2"; }
check() {
  local out
  out=$(sql -d "$db" -At -v pass="$2" < "$1" 2>&1) || { echo "$out"; echo "FALHOU: $1 (erro de SQL)" >&2; exit 1; }
  if grep -Eq '^not ok|Looks like you failed' <<<"$out"; then
    grep -E '^not ok|^#' <<<"$out"; echo "FALHOU: $1" >&2; exit 1
  fi
  echo "ok: $1 ($(grep -c '^ok' <<<"$out") asserções)"
}

sql -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db OWNER moneyflow_owner"
docker compose exec -T -e OWNER_DBS="$db" postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh
for m in migrations/*.sql; do
  [[ "$(basename "$m")" < "$n" ]] || break
  section up "$m" | owner_sql -1 -d "$db" >/dev/null
done
sql -1 -d "$db" < "$dir/fixture.sql"
echo "fixture carregado ($(basename "$dir"))"

section up "$file" | owner_sql -1 -d "$db";   check "$dir/after_up.sql" 1
section down "$file" | owner_sql -1 -d "$db"; check "$dir/after_down.sql" 1
section up "$file" | owner_sql -1 -d "$db";   check "$dir/after_up.sql" 2
echo "migração $n: subida, descida e subida com dados conferidas (migrations como moneyflow_owner)"
