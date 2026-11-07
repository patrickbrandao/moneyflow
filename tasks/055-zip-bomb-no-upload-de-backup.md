---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# Zip bomb nos uploads de backup e de dump (descompactação sem limite)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** esgotamento de memória
- **Arquivos afetados:** `apps/server/src/services/backup/import.ts:88-101`, `apps/server/src/services/backup/dump.ts:195-209`, `apps/server/src/config.ts:109`, `apps/server/src/routes/backup.ts:40-45`
- **Depende de / relacionado a:** 048 (em cadeia, com uma sessão de admin sequestrada)
- **Esforço estimado:** P/M
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Um .zip pequeno pode se expandir para gigabytes. Ao abrir o arquivo de backup inteiro na memória, a API fica sem memória e cai, para todos os usuários.

### Evidência e análise técnica
- `import.ts:88-101`: `unzipSync(..., { filter: (file) => file.name.toLowerCase().endsWith('.json') })`, depois `strFromU8(entries[name]!)`. O JSON é descompactado inteiro em memória.
- `dump.ts:195-209`: o mesmo para o `.dump`. O filtro também aceita várias entradas com o mesmo sufixo.
- O limite vale só para o corpo compactado: `BACKUP_MAX_UPLOAD_MB`, padrão 512 (`config.ts:109`, `routes/backup.ts:40-41`).

### Verificação (tentativa de refutação)
Só o admin chega lá (`assertAdmin` no hook do plugin, `routes/backup.ts:43-45`), pela tela ou pelas tools `import_backup`/`simulate_import` (anexos de até 20 MB). Não há teto de tamanho descompactado documentado.

### Impacto
A API cai por falta de memória e reinicia.

## Como reproduzir
Como admin, enviar ao import um zip com um `.json` de vários GB de zeros (poucos MB compactado).

## Solução proposta
- Recusar entradas acima de um teto (por exemplo 4× `backupMaxUploadBytes`) antes de extrair: pelo `originalSize` no `filter` e, como o tamanho declarado pode mentir, contando os bytes na extração em streaming (`fflate` `Unzip`).
- O dump pode ir do zip direto ao arquivo temporário, em streaming.
- Registrar o teto em `docs/019-backup-e-restauracao.md`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/backup/import.ts
+++ b/apps/server/src/services/backup/import.ts
@@
     try {
       entries = unzipSync(new Uint8Array(body.buffer, body.byteOffset, body.length), {
-        filter: (file) => file.name.toLowerCase().endsWith('.json'),
+        filter: (file) => {
+          if (file.originalSize > MAX_UNZIPPED_BYTES) throw new Error('too_large');
+          return file.name.toLowerCase().endsWith('.json');
+        },
       });
```

## Critérios de aceite
- [ ] Um zip com a entrada (declarada ou real) acima do teto responde 413/422 sem a memória do processo crescer.
- [ ] `docs/019` atualizada.

## Testes recomendados
Integração em `apps/server/test/backup.test.ts` com um zip de zeros acima do teto, para o import e para o dump. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Um `originalSize` falsificado só é pego contando os bytes no streaming.

## Análise (triagem)

Confirmado: `parseBackupUpload` (`services/backup/import.ts`) e `extractDump` (`services/backup/dump.ts`) usavam `unzipSync` sem teto. Observação: com o buffer de saída do tamanho declarado, o fflate não cresce além dele (escreve fora e descarta), mas o inflate percorre o fluxo inteiro (CPU) e um tamanho declarado grande aloca o que pedir. O `Unzip` em streaming do fflate procura assinaturas no meio dos dados quando há descritor de dados, o que é frágil para o `.dump` guardado sem compressão; por isso a extração foi feita pelo diretório central. Executor: app.

## Resolução (executor)

- `apps/server/src/services/backup/unzip.ts` (novo): `unzipLimited(corpo, aceitar, teto)` lê o diretório central (com zip64), recusa a entrada cujo tamanho declarado passa do que resta do teto antes de ler, e infla com `zlib.inflateRawSync(..., { maxOutputLength })`, que para ao passar do teto (os bytes de verdade); entradas aceitas somam no teto. `backupUnzipLimit(config)` = 4× `backupMaxUploadBytes`; acima, `UnzipTooLarge` (413 `unzipped_too_large`, texto `t.backup.errors.unzippedTooLarge`); zip malformado continua 422 `invalid_backup`/`invalid_dump`.
- `parseBackupUpload(corpo, teto)` e `extractDump(corpo, teto)` (agora exportada) usam o leitor; chamadas em `routes/backup.ts`, `agents/tool-handlers-admin.ts` (`import_backup`/`simulate_import`) e `restoreDump`.
- Testes em `apps/server/test/backup.test.ts` (`describe` "teto da descompactação"): import e dump com a entrada acima do teto, com o tamanho declarado falso (10 bytes) e com várias entradas somando; zip abaixo do teto segue lido; a rota com `BACKUP_MAX_UPLOAD_MB=1` responde 413. O arquivo inteiro (imports .zip de ida e volta) passa.
- Spec: `docs/019-backup-e-restauracao.md`. O dump continua inteiro em memória até o teto (não foi para streaming direto ao arquivo temporário).
