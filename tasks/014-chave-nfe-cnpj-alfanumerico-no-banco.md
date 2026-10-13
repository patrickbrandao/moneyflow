---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-10-13
commit:
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
