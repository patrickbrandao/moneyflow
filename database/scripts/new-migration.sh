#!/bin/bash
# Cria database/migrations/NNNN_<nome>.sql com o próximo número sequencial.
set -euo pipefail
name="${1:?uso: new-migration.sh <nome_em_snake_case>}"
dir="$(cd "$(dirname "$0")/.." && pwd)/migrations"
last=$(ls "$dir" 2>/dev/null | grep -Eo '^[0-9]{4}' | sort -n | tail -1 || true)
next=$(printf '%04d' $((10#${last:-0} + 1)))
file="$dir/${next}_${name}.sql"
cat > "$file" <<SQL
-- migrate:up


-- migrate:down

SQL
echo "$file"
