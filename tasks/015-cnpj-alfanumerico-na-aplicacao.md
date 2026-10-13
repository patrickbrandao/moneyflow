---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-10-13
commit:
---

# CNPJ alfanumérico em toda a aplicação (depois da 014)

## Descrição
Uma auditoria em 2026-10-13 (HEAD `a14311f`) mostrou que o cadastro de entidades, as chaves PIX, o `normalizeDocument`/`isValidCnpj` (shared) e o `is_valid_cnpj` (banco) já aceitam o CNPJ alfanumérico e concordam no algoritmo. Ficaram estas lacunas em relação à seção "CNPJ alfanumérico em todo o sistema" da spec [003](../docs/003-entidades.md) e às specs [010](../docs/010-entrada-de-titulos.md) e [011](../docs/011-agentes-de-ia.md):

1. **Chave de acesso da NF-e** (quebrado):
   - `packages/shared/src/parsers/nfe.ts:55-58`: `isValidNfeAccessKey` exige `/^[0-9]{44}$/`.
   - `nfe.ts:61-67`: `nfeAccessKeyDv` usa `Number(char)`.
   - `nfe.ts:106`: a escolha entre `Id` e `chNFe` também usa `/^[0-9]{44}$/`.
   - Correção: formato `[0-9]{6}[0-9A-Z]{12}[0-9]{26}` com a chave em maiúsculas, e cada caractere valendo `charCodeAt - 48`. A regra precisa casar com a da tarefa 014.
2. **`search_records` sem documento** (quebrado): `apps/server/src/agents/search.ts:50-53`, o fallback sem embeddings, só compara `name`/`trade_name`. Precisa procurar pelo prefixo de `normalizeDocument(query)` em `e.document`, como `listEntities` (`services/entities.ts:53-60`). Vale também para o CNPJ numérico.
3. **Consulta de CNPJ sem validação** (risco):
   - `apps/server/src/integrations/lookup.ts:134`: o CNPJ vai aos provedores sem passar por `isValidCnpj`. Validar antes e devolver 400 "CNPJ inválido".
   - `:80`, `digits(b.cnpj) === cnpj`: tira as letras. Normalizar com `normalizeDocument` nos dois lados.
   - A BrasilAPI aceita o alfanumérico desde agosto de 2026 (BrasilAPI/BrasilAPI#792). O CNPJ Aberto continua só numérico, e o roteamento atual se mantém.
4. **Normalização da descrição do extrato** (risco baixo): `packages/shared/src/reconcile.ts:31` remove números de 4 ou mais dígitos, mas não o CNPJ alfanumérico (token de 14 caracteres em minúsculas). Também deve descartar o token que, normalizado em maiúsculas, é um CNPJ válido. Atenção: mudar a normalização muda o `dedup_hash` das linhas sem FITID (spec 009). Aplique a nova regra só ao casamento e às regras de classificação, ou garanta que o hash das linhas já importadas não muda.
5. **Telas** (cosmético):
   - `apps/web/src/components/entity/EntityFormModal.tsx:117`: o placeholder passa a `00.000.000/0000-00 ou 12.ABC.345/01DE-35`, e o campo converte para maiúsculas enquanto se digita (hoje só no blur). O mesmo vale para o campo da chave PIX (`ChildModals.tsx`).
   - `packages/shared/src/pix.ts:65` `formatPixKey`: a chave do tipo CNPJ aparece formatada como o documento.
6. **Testes que faltam** (lista da spec 003):
   - Integração: criar, editar e detectar duplicata de entidade com CNPJ alfanumérico, inclusive em minúsculas e com pontuação.
   - BR Code com chave CNPJ alfanumérica, e `guessPixKeyType` com valor alfanumérico.
   - NF-e com emitente, destinatário e chave alfanuméricos: um fixture novo em `apps/server/test/fixtures`, gerado com `nfeAccessKeyDv`.
   - Importação do backup casando a entidade pelo documento alfanumérico.
   - `search_records` pelo documento.
   - Consulta de CNPJ inválido → 400 sem chamar o provedor.
   - Um e2e que cadastra uma empresa com CNPJ alfanumérico e a acha pela busca.

## Como reproduzir
- Importar uma NF-e cujo `Id` tem letras nas posições 7 a 20 → "Chave de acesso da NF-e inválida."
- Pedir a um agente sem embeddings "ache a entidade 12.ABC.345/01DE-35" → nada encontrado.
- `GET /api/lookup/cnpj/abc` → a chamada vai ao provedor e volta 404 em vez de 400.

## Análise (triagem)

## Resolução (executor)
