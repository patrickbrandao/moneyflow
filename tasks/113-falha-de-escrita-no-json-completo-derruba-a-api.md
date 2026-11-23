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

# Falha de escrita do zip do JSON completo vira rejeição sem tratamento e derruba a API

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** promise rejeitada sem handler (unhandledRejection)
- **Arquivos afetados:** `apps/server/src/services/backup/export.ts:163-218`, `apps/server/src/routes/backup.ts:16-32`, `apps/server/src/main.ts:26-42`
- **Depende de / relacionado a:** tarefa 077 (o arquivo grande é o que mais enche o disco)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se o disco do servidor enche enquanto o admin gera o "JSON completo", a API inteira cai para todos os usuários, em vez de mostrar um erro na tela do backup. O arquivo temporário pela metade fica no disco.

### Evidência e análise técnica
`exportFullZip` cria a promise que espera o fim da escrita logo no começo e só a aguarda no final, depois de toda a transação de leitura:

```ts
const out = createWriteStream(path, { mode: 0o600 });
const finished = new Promise<void>((resolve, reject) => {
  out.on('finish', resolve);
  out.on('error', reject);          // export.ts:168-171
});
...
await readOnly(ctx, async (tx) => { ... out.write(data) ... });   // pode levar minutos
...
await finished;                      // export.ts:216
```

Se o `out` emite `error` durante a leitura (ENOSPC, EIO ou o `out.destroy(error)` do callback do zip em `:176`), `reject` roda numa promise que ainda não tem handler. No modo padrão do Node (`--unhandled-rejections=throw`), isso vira exceção não capturada e o processo sai. A API não registra `unhandledRejection` nem `uncaughtException`: `main.ts` só trata `SIGTERM` e `SIGINT`.

Conferido com um script de 10 linhas no mesmo padrão (stream para um diretório inexistente, `await` de 200 ms e depois `await finished` dentro de `try/catch`). O processo sai com código 1 em `triggerUncaughtException` antes de chegar ao `catch`.

Com o processo morto, o `rm` do diretório temporário em `sendTempFile` (`routes/backup.ts:21-23`) não roda e o zip parcial fica em `os.tmpdir()`.

### Verificação (tentativa de refutação)
- `writeZip` do dump (`dump.ts:252-279`) usa o mesmo par de eventos, mas dentro de uma promise aguardada na hora: ali não acontece.
- O `catch` de `exportFullZip` (`:211-215`) só pega erros da leitura. A rejeição do `finished` não passa por ele.
- Nenhum teste força falha de escrita.

### Impacto
Um disco cheio (provável justamente com backups grandes) derruba a API de todos durante a exportação, e não só a requisição. Ao reiniciar, o zip parcial continua ocupando o disco.

## Como reproduzir
1. Num ambiente com `TMPDIR` apontando para um tmpfs pequeno (por exemplo, 50 MB), gere `GET /api/backup/full` num banco com anexos acima disso.
2. O processo da API sai com `ENOSPC` em `triggerUncaughtException`, em vez de devolver `500`.

## Solução proposta
Marcar a promise como tratada desde o início e interromper a leitura quando a escrita falhar:

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/backup/export.ts
+++ b/apps/server/src/services/backup/export.ts
@@
-  const finished = new Promise<void>((resolve, reject) => {
+  let writeError: Error | null = null;
+  const finished = new Promise<void>((resolve, reject) => {
     out.on('finish', resolve);
-    out.on('error', reject);
+    out.on('error', (error) => {
+      writeError = error;
+      reject(error);
+    });
   });
+  finished.catch(() => {}); // tratada aqui; o `await finished` abaixo continua rejeitando
@@
-  const push = (text: string) => entry.push(strToU8(text), false);
+  const push = (text: string) => {
+    if (writeError) throw writeError; // para a leitura assim que o disco falhar
+    entry.push(strToU8(text), false);
+  };
```

## Critérios de aceite
- [ ] Com falha de escrita no meio da exportação, a rota responde `500` e o processo continua de pé.
- [ ] O diretório temporário é apagado também nesse caso.

## Testes recomendados
`apps/server/test/backup.test.ts`: chamar `exportFullZip(ctx, '<dir inexistente>/x.zip')` e esperar `rejects.toThrow()`. Sem a correção, o vitest acusa a rejeição sem tratamento e o teste falha.

## Limitações e suposições
O ENOSPC real não foi reproduzido. O comportamento foi confirmado com o mesmo padrão de código num script descartável (Node 26). No Node 22 o padrão `throw` de rejeições sem tratamento é o mesmo.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: a promise `finished` de `exportFullZip` recebia o `reject` do `error` do arquivo sem handler até o `await` final, depois de toda a leitura; um erro de escrita no meio virava rejeição sem tratamento.

## Resolução (executor)

- `apps/server/src/services/backup/export.ts`: o `error` do arquivo fica em `writeError`, a promise `finished` é marcada como tratada logo ao nascer (`finished.catch(() => {})`, o `await finished` do fim continua rejeitando) e o `drain()` chamado a cada lote e a cada pedaço de anexo interrompe a leitura assim que a escrita falha; o callback do zip para de escrever depois da falha. A exportação rejeita com o erro, a rota responde `500` e o `sendTempFile` apaga o diretório temporário (ele já apagava quando a produção falhava).
- Teste em `apps/server/test/backup.test.ts`, "falha de escrita do zip volta como erro da chamada e solta a trava": `exportFullZip` para um diretório inexistente rejeita com `ENOENT` (sem a correção, o vitest acusava a rejeição sem tratamento) e a trava do backup fica livre depois.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
