---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: alta
criada: 2026-10-13
commit: F6 (banco), branch feat/f6-tags-favoritas
---

# Chave de acesso da NF-e com CNPJ alfanumérico no banco (NT 2025.001)

## Descrição
`is_valid_nfe_access_key` (`database/migrations/0012_title_entry.sql:98-113`, usada no CHECK de `nfe_documents.access_key`) exige `^[0-9]{44}$` e faz `substr(...)::int`. Pela NT 2025.001, as posições 7 a 20 da chave são o CNPJ do emitente, que pode ser alfanumérico. Por isso, uma NF-e emitida por empresa com CNPJ alfanumérico é recusada (e o cast `::int` estoura com letra).

O esperado está nas specs [010](../docs/010-entrada-de-titulos.md) e [016](../docs/016-banco-de-dados.md):
- O formato é `^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$`, só maiúsculas.
- O DV (posição 44) é o módulo 11 sobre os 43 primeiros caracteres, cada um valendo `ascii(c) - 48`, com pesos de 2 a 9 a partir da direita e resto 0 ou 1 → 0.
- Para chaves numéricas o resultado é idêntico ao de hoje.

Parte do banco da garantia "CNPJ alfanumérico em todo o sistema" ([003](../docs/003-entidades.md)). A parte da aplicação é a tarefa 015, que vem depois desta.

## Como reproduzir
```sql
SELECT is_valid_nfe_access_key('35' || '2610' || '12ABC34501DE35' || '55' || '001' || '000000001' || '1' || '00000001' || '?');
```
Hoje dá false para qualquer DV, porque a regex recusa a letra.

## Análise (triagem)

## Resolução (executor)
Feito em 2026-10-13 (dba), na migration `database/migrations/0036_nfe_access_key_alphanumeric.sql` (parte do banco da F6).

- `is_valid_nfe_access_key` agora exige `^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$` (só maiúsculas; letra só nos 12 primeiros caracteres do CNPJ do emitente, posições 7 a 18) e calcula o DV com `ascii(c) - 48`, pesos 2..9 da direita, resto 0 ou 1 → 0. Sem `::int` sobre a chave. Chaves numéricas dão o mesmo resultado de antes.
- O CHECK `nfe_documents_access_key_check` continua o mesmo (usa a função); `COMMENT ON` da função e de `nfe_documents.access_key` atualizados.
- pgTAP em `database/tests/0012_title_entry.sql`: a chave da reprodução com DV `1` (`35261012ABC34501DE35550010000000011000000011`) é válida e entra em `nfe_documents`; DV errado, minúsculas, letra na UF, no DV do CNPJ ou no DV da chave e 43 caracteres são recusados; as chaves numéricas antigas continuam válidas.

Verificação: `make -C database test` verde. Próximo: tarefa 015 (app).
