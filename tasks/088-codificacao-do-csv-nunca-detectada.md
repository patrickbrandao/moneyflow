---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Codificação do CSV nunca é detectada: arquivo em Latin-1 entra com "�" nas descrições

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** encoding latin1/cp1252 × UTF-8 no CSV
- **Arquivos afetados:** `apps/server/src/services/statements.ts:356-378` (`encoding: 'auto'` em `:365` e `:378`), `apps/server/src/services/statements.ts:159-162`, `apps/server/src/services/statements.ts:222-224`, `apps/web/src/components/reconciliation/ImportModal.tsx:480-490`, `apps/web/src/components/reconciliation/ImportModal.tsx:101-106`, `packages/shared/src/schemas/operation.ts:176`, `packages/shared/src/parsers/ofx.ts:52-68`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Muitos bancos exportam o CSV em Latin-1 (Windows-1252). O sistema sabe detectar isso (usa no OFX), mas na leitura prévia do CSV responde "auto", a tela não entende e assume UTF-8. Se o usuário não perceber os "�" na prévia e trocar a codificação à mão, as descrições ficam gravadas como "PADARIA S�O JO�O" para sempre: as regras com acento não casam e reimportar o arquivo certo depois duplica as linhas.

### Evidência e análise técnica
- `inspectStatement` lê o texto com `decodeStatementFile` (detecção UTF-8 → charset do cabeçalho → windows-1252, `ofx.ts:52-68`), mas devolve `encoding: 'auto'` fixo (`statements.ts:365` e `:378`).
- A tela só aceita um valor de `CSV_ENCODINGS` (`utf-8`, `latin1`, `windows-1252`): `detectedEncoding = CSV_ENCODINGS.includes(inspect.encoding) ? … : 'utf-8'` (`ImportModal.tsx:480-482`), ou seja, sempre `utf-8`. A prévia, o palpite das colunas (`guessCols` sobre o cabeçalho, `:485-486`) e o mapeamento salvo (`:490`, `:580`) saem com `utf-8`.
- Na importação, o servidor decodifica pelo mapeamento (`decodeWith`, `statements.ts:159-162`, chamado em `:224`), com `TextDecoder('utf-8')` não fatal: bytes Latin-1 viram `U+FFFD`. O padrão do schema também é `utf-8` (`operation.ts:176`), inclusive no `csvMapping` inline da tool `import_statement`, em que o agente não vê os bytes.
- Script descartável com o código do shared:
  ```
  utf-8 (padrão do mapeamento): "10/10/2026;PADARIA S�O JO�O;-12,30"
  auto (decodeStatementFile):   "10/10/2026;PADARIA SÃO JOÃO;-12,30"
  hash base utf-8: padaria s o jo o | correto: padaria sao joao
  ```
  A base do `dedup_hash` muda (`normalizeDescriptionForDedup` tira o `�`), então importar de novo com a codificação certa não deduplica e duplica o período (CSV raramente tem FITID).

### Verificação (tentativa de refutação)
- O valor `'auto'` não é usado em nenhum lugar como "detecte" (`grep encoding` em `packages/shared/src` e na tela): é só o rótulo da resposta.
- A prévia mostra o texto com `�`, então o usuário atento troca o seletor; mas o cabeçalho com acento ("Lançamento", "Descrição") faz o palpite das colunas falhar e a correção não é óbvia, e nas tools (spec 027) não há prévia visual.
- Testes: os CSV de teste são UTF-8 (`extrato-itau.csv`, `extrato-debito-credito.csv`); `ofx.test.ts:16` cobre windows-1252 só no OFX.
- A descrição da linha não tem edição na tela; a imutabilidade do banco não a cobre, mas não há rota que a altere.

### Impacto
Contas de bancos que exportam CSV em Latin-1, no primeiro mapeamento: descrições corrompidas nas linhas importadas, regras com acento que não casam e, se o usuário corrigir a codificação e reimportar, linhas em dobro.

## Como reproduzir
1. Salvar um CSV em ISO-8859-1 com "Lançamento" no cabeçalho e "SÃO JOÃO" numa descrição.
2. `POST /api/statements/inspect`: `encoding: "auto"`.
3. Abrir a importação na tela: o seletor de codificação vem em UTF-8 e a prévia mostra `�`; importar sem trocar: a linha fica com `S�O JO�O`.

## Solução proposta
1. No shared, `detectStatementEncoding(bytes): 'utf-8' | 'windows-1252'` (BOM ou UTF-8 válido → `utf-8`; senão o charset do cabeçalho, caindo em `windows-1252`), reaproveitado por `decodeStatementFile`.
2. `inspectStatement` devolve o detectado em `encoding` (o tipo continua `string`; a tela já trata os valores de `CSV_ENCODINGS`).
3. No `decodeWith`, mapeamento em `utf-8` com bytes que não são UTF-8 válido: decodificar como `windows-1252` (ou recusar com 422 "o arquivo não está em UTF-8; troque a codificação do mapeamento"), em vez de gravar `�`.

## Critérios de aceite
- [ ] A leitura prévia de um CSV em Latin-1 devolve `windows-1252` (ou `latin1`) e a tela pré-seleciona a codificação certa.
- [ ] Importar um CSV em Latin-1 com mapeamento `utf-8` não grava `U+FFFD` nas descrições.

## Testes recomendados
`packages/shared/test/ofx.test.ts` (ou um `encoding.test.ts`): detecção para UTF-8 com e sem BOM e para Latin-1. `apps/server/test/statements.test.ts`: inspect e import de uma variante Latin-1 de `extrato-itau.csv`.

## Limitações e suposições
Executado só o script de decodificação (`<RASCUNHO>/scripts/enc.ts`). Não conferi quais bancos exportam em Latin-1.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código: `inspectStatement` devolvia `encoding: 'auto'` fixo, a tela caía sempre em `utf-8` e o `decodeWith` do import decodificava os bytes Latin-1 com o `TextDecoder('utf-8')` não fatal, gravando `U+FFFD` (e mudando a base do `dedup_hash`).

## Resolução (executor)

- `packages/shared/src/parsers/ofx.ts`: `detectStatementEncoding(bytes)` (BOM ou UTF-8 válido → `utf-8`; senão o charset do cabeçalho OFX/XML, caindo em `windows-1252`), reaproveitado por `decodeStatementFile`; `detectCsvEncoding` (`utf-8` ou `windows-1252`, os valores do mapeamento) e `decodeCsvFile(bytes, encoding)`: com BOM, UTF-8; `latin1`/`windows-1252`, windows-1252; `utf-8` com bytes que não são UTF-8 válido, windows-1252 (nunca "�").
- `apps/server/src/services/statements.ts`: a leitura prévia devolve a codificação detectada (no CSV, `utf-8` ou `windows-1252`; no OFX, o rótulo usado) e o import lê o CSV por `decodeCsvFile` (saiu o `decodeWith`).
- `apps/web/src/components/reconciliation/ImportModal.tsx`: a prévia do mapeamento usa o mesmo `decodeCsvFile`, então a tela pré-seleciona `windows-1252` e mostra o que o servidor vai gravar.
- Decisão: ler como windows-1252 (em vez de recusar com 422) o mapeamento em UTF-8 com bytes inválidos, porque o agente não vê os bytes e o resultado é sempre melhor que o "�". O mapeamento explícito em `latin1`/`windows-1252` continua valendo como está.
- Spec 009 (codificação detectada) e a linha dela no `docs/INDEX.md`.
- Testes: `packages/shared/test/ofx.test.ts` ("codificação do CSV": UTF-8 com e sem BOM, Latin-1, o OFX 1252 e o mapeamento UTF-8 com arquivo Latin-1); `apps/server/test/statements.test.ts`, "CSV em Latin-1 decrescente…": inspect com `windows-1252`, prévia da tool e import com mapeamento `utf-8` sem `U+FFFD`.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
