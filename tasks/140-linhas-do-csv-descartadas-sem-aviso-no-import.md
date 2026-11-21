---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Linhas do CSV com data ou valor inválidos somem do import sem aviso (API e tools)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** erro engolido no parser do CSV
- **Arquivos afetados:** `apps/server/src/services/statements.ts:224-238`, `apps/server/src/services/statements.ts:279-327`, `apps/server/src/services/statements.ts:481-490`, `packages/shared/src/parsers/csv.ts:221-252`, `apps/server/src/agents/tool-handlers-operation.ts:552-579`
- **Depende de / relacionado a:** tarefa 088 (mesma etapa de leitura)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se uma linha do CSV tem a data num formato diferente ou um valor que o leitor não entende (três casas decimais, "1,234.56" num arquivo de vírgula decimal), ela simplesmente não entra. Na tela, a prévia do mapeamento avisa; pelo agente ou pela API, ninguém fica sabendo, e a falta só aparece como divergência de saldo.

### Evidência e análise técnica
- `applyCsvMapping` devolve `errors` por linha (`csv.ts:229-252`: "data inválida", "valor inválido", "valor zero").
- `parseStatementFile` usa só `applied.lines` e descarta `applied.errors` (`statements.ts:227-238`).
- A resposta do import traz `skippedDuplicates`, `ofxLeftOut` e a troca, mas nada sobre as linhas descartadas (`statements.ts:483-490`); a prévia da tool `import_statement` mostra "Linhas novas", entradas e saídas, sem as descartadas (`previewStatementImport`, `:312-326`; `tool-handlers-operation.ts:552-579`).
- Exemplos que caem: `parseAmount('1,234.56', ',')` e `parseAmount('10,505', ',')` → `null` (script descartável sobre o `csv.ts`).

### Verificação (tentativa de refutação)
- A tela aplica o mesmo mapeamento no navegador e mostra "N linha(s) lidas · M com problema" antes de importar (`ImportModal.tsx:794-799`), então no console o usuário é avisado; o achado vale para a API, o `/mcp` e as tools (spec 027, "anexar … e pedir importe e concilie").
- "valor zero" entra como erro também (as linhas de "SALDO ANTERIOR 0,00" das fixtures), o que faz o aviso da tela contar ruído; separar esse caso ajuda os dois lados.
- Nenhum teste de integração confere o que acontece com a linha inválida no import (`csv.test.ts:91` cobre só o parser).

### Impacto
Lançamento real ausente da conciliação quando o import é feito pelo agente ou pela API, sem pista da causa.

## Como reproduzir
Pela tool `import_statement` (ou `POST /api/statement-imports`), um CSV com uma linha `05/10/2026;TED;1,234.56;…` num mapeamento de vírgula decimal: a resposta e a prévia não citam a linha, e ela não está no lote.

## Solução proposta
1. `ParsedFile` ganha `invalidRows: { row, message }[]` (sem as de "valor zero", que viram `zeroRows: number`).
2. `previewStatementImport` e `importStatement` devolvem `invalidRows` (até 50, com o total), e a prévia da tool ganha o aviso "N linha(s) do arquivo não foram lidas (ex.: linha 12, valor inválido)".
3. Opcional: recusar o import (422) quando mais de X% das linhas são inválidas, que quase sempre é mapeamento errado.

## Critérios de aceite
- [ ] O import e a prévia da tool informam as linhas inválidas com o número da linha e o motivo.
- [ ] As linhas de valor zero não contam como problema.

## Testes recomendados
`apps/server/test/statements.test.ts`, caso "importa CSV com mapeamento salvo por conta": uma variante da fixture com uma linha de valor inválido, conferindo `invalidRows`; `apps/server/test/agent-tools.test.ts`: o aviso na prévia do `import_statement`.

## Limitações e suposições
Só os exemplos do `parseAmount` foram executados (`<RASCUNHO>/scripts/edge.ts`).

## Análise (triagem)

## Resolução (executor)
