---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# JSON completo com os anexos em hex: a exportação lê 500 anexos por consulta e a importação não lê arquivo acima de 512 MiB

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** memória e limite de string do V8 no backup
- **Arquivos afetados:** `apps/server/src/services/backup/export.ts:36,89-94,196-204`, `apps/server/src/services/backup/import.ts:91-113`, `apps/server/src/services/backup/unzip.ts:15,122`, `database/schema.sql:12397,12409`, `docs/019-backup-e-restauracao.md:28,33,38`
- **Depende de / relacionado a:** 055 (teto da descompactação, que não cobre este caso); tarefa 113
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O "JSON completo" leva os anexos (PDFs, fotos, áudios) dentro do próprio JSON, como texto hexadecimal. Com muitos anexos, gerar o backup pode esgotar a memória do servidor e derrubar a API de todos. E quando o conteúdo passa de cerca de 256 MB de anexos, o arquivo gerado já não pode ser importado: a importação falha com "erro interno". O problema só aparece na hora de restaurar.

### Evidência e análise técnica
**Exportação.** `exportFullZip` pagina todas as tabelas em lotes de `BATCH = 500` (`export.ts:36,197`). Cada lote é uma consulta só:

```ts
SELECT row_to_json(backup_row)::text AS j FROM (SELECT <todas as colunas> FROM attachments ... LIMIT 500)
```

`attachments.content` é `bytea` de até 20 MiB (`schema.sql:12397,12409`) e sai em hex, com o dobro do tamanho. O node-postgres junta o resultado inteiro antes de devolver. Depois vêm `JSON.parse` de cada linha (`export.ts:94`) e `JSON.stringify` + `strToU8` por linha (`export.ts:199`). Com 500 anexos de 1 MB em média, são cerca de 1 GB de texto num lote, mais as cópias: 2 a 3 GB de pico no processo da API. No pior caso (500 × 20 MiB), 20 GB.

**Importação.** `parseBackupUpload` (`import.ts:91-113`) descompacta tudo para a memória (até 4× `BACKUP_MAX_UPLOAD_MB`, ou seja, 2 GiB, `unzip.ts:15`), com `inflateRawSync` síncrono (`unzip.ts:122`). Depois faz `strFromU8` (`import.ts:104`, fora do `try`) e `JSON.parse` do texto inteiro. O V8 não cria string com mais de 536.870.888 caracteres. Conferido aqui:

```
buffer.constants.MAX_STRING_LENGTH = 536870888
Buffer(536870889).toString() → ERR_STRING_TOO_LONG
```

Um `moneyflow.json` com mais de ~512 MiB (anexos somando mais de ~256 MB, por causa do hex) é recusado antes do merge, com uma exceção que vira `500 internal`. Abaixo disso, o pico de memória é o zip, mais o descompactado, mais a string (2 bytes por caractere se houver um único caractere fora do Latin-1), mais os objetos. E o laço de eventos fica parado durante o inflate e o parse.

### Verificação (tentativa de refutação)
- O teto da tarefa 055 limita o descompactado a 2 GiB, o que está acima do limite de string. Ele não protege a memória da exportação.
- A spec 019 (`:28`) diz que o JSON completo leva "inclusive segredos e anexos (conteúdo em hex) ... escritas aos pedaços". Os pedaços são por linha no zip, mas a leitura é de 500 linhas por consulta.
- Os testes (`apps/server/test/backup.test.ts:1276`) usam poucos anexos pequenos. Nenhum passa por lote cheio nem por arquivo grande.
- O dump do PostgreSQL não tem o problema (o `pg_dump` grava direto no disco). Mas o JSON completo é a restauração por merge da spec, e o admin não é avisado do limite.

### Impacto
Instalações com alguns anos de anexos (contas em PDF, fotos de comprovante, áudios do chat). A exportação completa pode derrubar a API por falta de memória. A importação de um backup grande nunca funciona, e o admin só descobre na hora em que precisa dele.

## Como reproduzir
1. Grave 300 anexos de 2 MB (por exemplo, `POST /api/attachments` com PDFs aleatórios).
2. `GET /api/backup/full`: observe o RSS da API passar de 1,5 GB no primeiro lote de `attachments`.
3. `POST /api/backup/import/full?dryRun=1` com o zip gerado (cerca de 1,2 GB de JSON): `500 internal`, com `ERR_STRING_TOO_LONG` no log.

## Solução proposta
1. Exportar o conteúdo dos anexos como entradas próprias do zip (`attachments/<id>`, binário cru, `ZipPassThrough`), lidas uma a uma, sem `content` no JSON. As linhas de `attachments` ficam com `content_entry`.
2. Na exportação, ler `attachments` (e outras tabelas com colunas grandes, como `contract_document_versions`) em lotes por bytes (`sum(size_bytes)` até, por exemplo, 64 MB) e não por 500 linhas.
3. Na importação, ler o JSON (agora pequeno) e buscar o conteúdo de cada anexo na entrada do zip só na hora do `INSERT`. Os arquivos antigos, com hex no JSON, continuam aceitos.
4. Enquanto isso, recusar com uma mensagem clara (`413`: "o JSON passa do limite; use o dump") quando o texto descompactado passar de `buffer.constants.MAX_STRING_LENGTH`, e pôr o `strFromU8` dentro do `try`.
5. Documentar na spec 019 o formato com anexos separados e o limite.

## Critérios de aceite
- [ ] Exportar com 300 anexos de 2 MB não passa de algumas centenas de MB de pico.
- [ ] Um backup com 1 GB de anexos exporta e importa (simulação e de verdade).
- [ ] Um arquivo antigo (anexos em hex) continua importando.
- [ ] Um JSON acima do limite recebe `413` com a mensagem, não `500`.

## Testes recomendados
`apps/server/test/backup.test.ts`, `describe('backup: JSON completo num sistema novo')`: (a) ida e volta com anexos como entradas do zip, conferindo o `sha256` de cada um; (b) arquivo no formato antigo com `content` em hex; (c) `parseBackupUpload` com uma entrada declarada acima de `MAX_STRING_LENGTH` (zip forjado, como nos testes da 055) devolve `413`.

## Limitações e suposições
Os números de memória da exportação são estimados pelo código: o node-postgres junta o resultado e há duas ou três cópias por linha. Não foram medidos com o banco. O limite de string foi conferido no Node 26 desta máquina e é o mesmo no Node 22 (2^29 − 24).

## Análise (triagem)

## Resolução (executor)
