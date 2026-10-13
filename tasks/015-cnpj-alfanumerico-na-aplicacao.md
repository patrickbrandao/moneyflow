---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-13
commit: v0.1.7, branch fix/cnpj-alfanumerico-app
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
Triagem em 2026-10-13 sobre `fix/cnpj-alfanumerico-app` (a partir do main `5c48cc6`, v0.1.6). O banco já está pronto: a 0036 (tarefa 014) aplica a NT 2025.001 em `is_valid_nfe_access_key` (`^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$`, ASCII − 48), `is_valid_cnpj` aceita o alfanumérico e `entities_document_prefix_idx` (`text_pattern_ops`, migration 0035) atende `LIKE 'X%'`. **Nada para o dba.** Todos os itens abaixo são da aplicação.

Reproduzido com um vitest descartável sobre o shared: a chave de 44 caracteres `352610` + `12ABC34501DE35` + 23 dígitos + DV (calculado com ASCII − 48) dá `isValidNfeAccessKey = false`; `normalizeDescription('PIX ENVIADO 12ABC34501DE35 FORNECEDOR')` mantém `12abc34501de35`, e a versão numérica descarta o CNPJ; `formatPixKey('cnpj', '12ABC34501DE35')` devolve a chave crua.

**Procede (todos os itens; o item 1 NÃO foi corrigido junto da 014):**
1. NF-e no shared, `packages/shared/src/parsers/nfe.ts`: `:56` usa `/^[0-9]{44}$/`, `:57` e `:65` usam `Number(...)` e `:106` escolhe entre `Id` e `chNFe` com `/^[0-9]{44}$/`. Hoje o shared recusa uma chave que o banco aceita. Correção: normalizar a chave (`toUpperCase`, sem espaços), usar o regex da 0036 e `charCodeAt(i) - 48` no DV. O DV comparado em `:57` continua sendo dígito.
   - Achado extra, cosmético: `apps/web/src/components/entry/TitleEntryInfo.tsx:100` agrupa a chave de 4 em 4 com `\d`, o que quebra o agrupamento quando há letras. Trocar por `/(.{4})(?=.)/g`.
2. `search_records` sem embeddings, `apps/server/src/agents/search.ts:50-53`: só compara `name`/`trade_name`. Vale também para o CNPJ numérico. Correção: como `listEntities` (`services/entities.ts:63-72`), calcular `doc = normalizeDocument(query)` e acrescentar `OR e.document LIKE doc || '%'` quando `doc.length >= 3`. Dar a esse acerto uma pontuação alta (ex.: `CASE WHEN … THEN 1 ELSE similarity END`), para que ele não fique abaixo dos trigramas no `ORDER BY 5`.
3. Consulta de CNPJ, `apps/server/src/integrations/lookup.ts`:
   - `:133-145` não valida: `GET /api/lookup/cnpj/abc` vira `ABC`, vai à BrasilAPI e volta 404. Correção: `if (!isValidCnpj(cnpj)) throw new AppError(400, 'validation', t.errors.invalidCnpj)` antes de qualquer `fetch`.
   - `:80`: `digits(b.cnpj) === cnpj` tira as letras. Hoje não tem efeito, porque o CNPJ Aberto só recebe o numérico (`:136`), mas deve comparar `normalizeDocument(String(b.cnpj ?? ''))`.
   - O roteamento (`:135-136`: numérico ao CNPJ Aberto, alfanumérico à BrasilAPI) já está como a spec 003 pede e não muda.
   - O teste `test/lookup.test.ts:138-141` usa `12ABC34501DE35`, que é válido, e continua passando.
4. Extrato, `packages/shared/src/reconcile.ts:24-34`: `normalizeDescription` descarta `\d{4,}`, mas não o CNPJ alfanumérico. A mesma função alimenta o `dedup_hash` das linhas sem FITID (`apps/server/src/services/statements.ts:178`), a similaridade do casamento (`reconcile.ts:37-47`) e o padrão das regras aprendidas (`apps/server/src/services/reconciliation.ts:215-218`). Plano:
   - Congelar a normalização atual numa função própria do dedup (ex.: `normalizeDescriptionForDedup`) e usá-la em `dedupHashes`. O hash das linhas já importadas não pode mudar, senão o reimport duplica.
   - Em `normalizeDescription`, que fica para o casamento e as regras, descartar também o token de 14 caracteres que, em maiúsculas, passa em `isValidCnpj`. O descarte vale antes de tirar a pontuação, para não deixar pedaços de `12.ABC.345/01DE-35`.
   - Observação fora do escopo: `classification_rule_for` (0014) compara o padrão normalizado com a descrição crua (`strpos(lower(p_description), …)`). Isso já é assim para o CNPJ numérico e não muda aqui.
5. Telas:
   - `apps/web/src/components/entity/EntityFormModal.tsx:120`: o `onChange` não converte para maiúsculas (só o `onBlur` em `:121` formata), e o placeholder em `:122` mostra só `00.000.000/0000-00`. Correção: `setDocument(e.target.value.toUpperCase())` e placeholder `00.000.000/0000-00 ou 12.ABC.345/01DE-35` para empresa.
   - `apps/web/src/components/entity/ChildModals.tsx:102-110` (chave PIX): converter para maiúsculas ao digitar quando o tipo for `cpf`/`cnpj`. Não converter em email/EVP, que são minúsculos.
   - `packages/shared/src/pix.ts:65-72`: `formatPixKey` devolve cpf/cnpj crus. Usar `formatDocument` para `cpf`/`cnpj` válidos. A função aparece em `EntitiesPage.tsx:187` e `EntityPage.tsx:221`, e o `CopyButton` continua copiando o valor normalizado.
6. Testes que faltam (nenhum existe hoje; os únicos alfanuméricos são `packages/shared/test/documents.test.ts:24-34`, `pix-address.test.ts:8` e `lookup.test.ts:139`):
   - Integração: entidade criada com `12.abc.345/01de-35`, editada e com duplicata recusada (409/23505), em `test/auth.test.ts` (onde já ficam os casos de entidade) ou num `test/entities.test.ts` novo.
   - Shared: `guessPixKeyType('12.abc.345/01de-35') === 'cnpj'`, `formatPixKey('cnpj', …)`, BR Code (`brcode.test.ts`) com chave CNPJ alfanumérica e NF-e alfanumérica em `nfe.test.ts`, inclusive a chave em minúsculas recusada ou normalizada.
   - Fixture `apps/server/test/fixtures/nfe-cnpj-alfanumerico.xml` (emitente e destinatário alfanuméricos, chave com DV de `nfeAccessKeyDv`) e a importação pela API, em `test/operation.test.ts`, onde fica a NF-e.
   - Backup: importação casando a entidade pelo documento alfanumérico (`test/backup.test.ts`, junto do caso de `:251`).
   - `search_records` (modo trigram) achando a entidade por `12.ABC.345` e pelo CNPJ numérico (`test/agents.test.ts`).
   - Lookup: `GET /api/lookup/cnpj/abc` e um CNPJ com DV errado dão 400 e `seen` fica vazio (`test/lookup.test.ts`).
   - `reconcile.test.ts`: o CNPJ alfanumérico é descartado da normalização e o `dedupHashes` de uma linha com CNPJ alfanumérico sem FITID não muda (hash fixo).
   - e2e: cadastrar uma empresa com CNPJ alfanumérico digitado em minúsculas e achá-la pela busca da listagem.

**Já resolvido (não refazer):**
- `normalizeDocument`/`isValidCnpj`/`formatCnpj` no shared.
- Cadastro de entidade e chave PIX (normalização e validação).
- Busca da listagem por prefixo do documento (`entities.ts:71`).
- Roteamento da consulta por provedor.
- Banco (0035/0036).
- `ai-flows.ts:86` usa `digits` só como guarda e normaliza com `normalizeDocument`, então aceita o alfanumérico (o DV tem dígitos).

**Causa:** a 014/0036 só tratou o banco, e o shared e o server ficaram com regex e normalização só numéricas. A busca dos agentes nunca procurou pelo documento.

**Specs:** 003 (seção "CNPJ alfanumérico em todo o sistema"), 009 (dedup inalterado: registrar a função congelada), 010 (NF-e, NT 2025.001) e 011 (`search_records` pelo documento no fallback). Atualizar só se algo divergir do que já está escrito.

**Risco:** médio. O item 4 mexe no dedup, por isso o hash fixo no teste. O item 2 mexe na ordem do `search_records`. Os demais são localizados.

**Verificação:** `pnpm lint && pnpm typecheck && pnpm test`, os testes novos acima e `pnpm e2e -g "CNPJ"` contra a pilha.

**Executor:** `app`, prioridade alta: a NF-e alfanumérica real é recusada hoje.

## Resolução (executor)
Executor `app`, 2026-10-13, na branch `fix/cnpj-alfanumerico-app`. Nada no banco (0035/0036 já atendiam).

**O que mudou**
1. **NF-e** (`packages/shared/src/parsers/nfe.ts`): regex da 0036 (`^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$`), DV com `charCodeAt − 48` em `nfeAccessKeyDv`, `normalizeNfeAccessKey` (maiúsculas, sem espaços) aplicada ao `Id` e ao `chNFe` antes da escolha entre os dois. `isValidNfeAccessKey` continua recebendo a chave já normalizada, como o banco. Na tela, `TitleEntryInfo.tsx` agrupa a chave de 4 em 4 com `/(.{4})(?=.)/g`.
2. **Busca dos agentes**: o `search_records` usa `listEntities`, que já procurava pelo prefixo do documento (coberto agora por teste). O fallback sem embeddings citado na análise é o do `semantic_search` (`apps/server/src/agents/search.ts`): passou a procurar `e.document LIKE normalizeDocument(query) || '%'` (prefixo de 3+ caracteres com algum dígito, para uma palavra comum não casar com o início de um CNPJ alfanumérico), com pontuação 1 para esse acerto.
3. **Consulta de CNPJ** (`apps/server/src/integrations/lookup.ts`): `isValidCnpj` antes de qualquer `fetch` → 400 `t.errors.invalidCnpj`; o estabelecimento do CNPJ Aberto é comparado com `normalizeDocument` nos dois lados. Roteamento mantido.
4. **Extrato** (`packages/shared/src/reconcile.ts`): `normalizeDescriptionForDedup` é a normalização antiga, congelada, usada só por `dedupHashes` (`services/statements.ts`). `normalizeDescription` (casamento e `rulePatternOf`) descarta, antes de tirar a pontuação, o token de CNPJ (numérico ou alfanumérico, com ou sem pontuação) cujo valor normalizado passa em `isValidCnpj`.
5. **Telas**: no `EntityFormModal`, o documento vai para maiúsculas ao digitar, e o placeholder e a dica vêm do `t` (`t.entity.cnpjPlaceholder` = `00.000.000/0000-00 ou 12.ABC.345/01DE-35`, `cpfPlaceholder`, `cnpjHint`). Na chave PIX (`ChildModals.tsx`), os tipos cpf/cnpj ficam em maiúsculas ao digitar quando o valor tem só caracteres de documento e algum dígito; email e EVP ficam como digitados. O placeholder acompanha o tipo. `formatPixKey` formata as chaves cpf/cnpj válidas com `formatDocument`.
6. **Specs**: 003 (descarte do CNPJ na normalização, dedup congelado, `semantic_search` pelo documento), 009 (dedup congelado) e 011 (`semantic_search`). Também o `AGENTS.md` (arquivo de teste, fixture e `alphaCnpj()`, e o e2e).

**Testes**
- Shared: `nfe.test.ts` (chave alfanumérica, minúsculas recusadas sem normalizar e aceitas depois, letra fora de 7–20, fixture com emitente, destinatário e chave alfanuméricos, `Id`/`chNFe` em minúsculas); `pix-address.test.ts` (`guessPixKeyType`, `formatPixKey` cpf/cnpj); `brcode.test.ts` (BR Code com chave CNPJ alfanumérica, inclusive pontuada e em minúsculas); `reconcile.test.ts` (descarte do CNPJ alfanumérico e do numérico pontuado, DV errado mantido, saída congelada do dedup).
- Server: `test/cnpj-alfanumerico.test.ts` (novo): criar e editar com o CNPJ em minúsculas e pontuado, duplicata 409 e DV errado 400, busca da listagem pelo prefixo, `search_records` e `semantic_search` (trigram) pelo alfanumérico e pelo numérico, importação da NF-e alfanumérica pela API (emitente criado, destinatário casado) e `dedupHashes` com hash fixo calculado com a função de antes da mudança. `lookup.test.ts`: CNPJ inválido (`abc`, DV errado numérico e alfanumérico, todos iguais) dá 400 sem nenhuma chamada a provedor; o alfanumérico em minúsculas e pontuado é normalizado. `backup.test.ts`: a entidade casa pelo documento alfanumérico. `helpers.ts`: `alphaCnpj()`.
- Fixture: `apps/server/test/fixtures/nfe-cnpj-alfanumerico.xml` (fictício, chave `35261012ABC34501DE35550010000123461876543224`, DV de `nfeAccessKeyDv`).
- E2E: `e2e/tests/cnpj-alfanumerico.spec.ts` cadastra a empresa digitando o CNPJ em minúsculas (confere maiúsculas e placeholder) e a acha pela busca da listagem. Passou contra a pilha local.

**Validação**: `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 119, server 111), `pnpm build` e `pnpm e2e` (18 de 18, inclusive o novo) verdes.
