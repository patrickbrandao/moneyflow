#!/bin/bash
# Testa uma migration com dados (make test-migration M=NNNN): recria o banco <db>_mig, aplica as migrations
# anteriores a NNNN, carrega migration-tests/NNNN_*/fixture.sql e roda subida → after_up.sql → descida →
# after_down.sql → subida → after_up.sql (com :pass = 2). As conferências são pgTAP; qualquer "not ok" ou erro de
# SQL falha o script. O banco <db>_mig fica no fim para inspeção.
set -euo pipefail
cd "$(dirname "$0")/.."
n="${1:?uso: test-migration.sh NNNN}"
dir=$(ls -d migration-tests/"${n}"_*/ 2>/dev/null | head -1)
file=$(ls migrations/"${n}"_*.sql 2>/dev/null | head -1)
[[ -n "$dir" && -n "$file" ]] || { echo "faltam migrations/${n}_*.sql ou migration-tests/${n}_*/" >&2; exit 1; }
[[ -f .env ]] && set -a && . ./.env && set +a
user="${POSTGRES_USER:-moneyflow}"
db="${POSTGRES_DB:-moneyflow}_mig"

sql() { docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$user" "$@"; }
section() { awk -v want="$1" '/^-- migrate:up/{f=(want=="up");next} /^-- migrate:down/{f=(want=="down");next} f' "$2"; }
check() {
  local out
  out=$(sql -d "$db" -At -v pass="$2" < "$1" 2>&1) || { echo "$out"; echo "FALHOU: $1 (erro de SQL)" >&2; exit 1; }
  if grep -Eq '^not ok|Looks like you failed' <<<"$out"; then
    grep -E '^not ok|^#' <<<"$out"; echo "FALHOU: $1" >&2; exit 1
  fi
  echo "ok: $1 ($(grep -c '^ok' <<<"$out") asserções)"
}

sql -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
for m in migrations/*.sql; do
  [[ "$(basename "$m")" < "$n" ]] || break
  section up "$m" | sql -1 -d "$db" >/dev/null
done
sql -1 -d "$db" < "$dir/fixture.sql"
echo "fixture carregado ($(basename "$dir"))"

section up "$file" | sql -1 -d "$db";   check "$dir/after_up.sql" 1
section down "$file" | sql -1 -d "$db"; check "$dir/after_down.sql" 1
section up "$file" | sql -1 -d "$db";   check "$dir/after_up.sql" 2
echo "migração $n: subida, descida e subida com dados conferidas"
