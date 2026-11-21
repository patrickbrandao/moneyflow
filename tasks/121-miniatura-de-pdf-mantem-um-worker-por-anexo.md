---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Miniatura de PDF no chat mantém um worker do pdf.js por anexo e vaza o documento ao desmontar cedo

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** vazamento de memória e de threads (Web Worker)
- **Arquivos afetados:** `apps/web/src/agents/AttachmentPreview.tsx:245-304`, `apps/web/src/components/contracts/PdfViewer.tsx:19-25,37-54`
- **Depende de / relacionado a:** a vulnerabilidade do `pdfjs-dist` 5.7.284 já registrada pelo coordenador (o endurecimento `isEvalSupported: false` cabe na mesma mudança)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Cada PDF anexado numa conversa abre um "motor" de PDF separado só para desenhar a miniatura, e ele fica ligado enquanto a janela estiver aberta. Uma conversa com vários PDFs deixa o navegador pesado; minimizar e restaurar a janela baixa e abre todos de novo.

### Evidência e análise técnica
- `loadPdf` (`PdfViewer.tsx:19-25`) chama `pdfjs.getDocument({ url, withCredentials: true })` sem `worker`. No `pdfjs-dist` instalado (`build/pdf.mjs`, `getDocument` → `PDFWorker.create({ port: GlobalWorkerOptions.workerPort })`), com `workerPort` nulo cada documento cria um `new Worker(...)` próprio, terminado só no `destroy()`.
- `PdfThumb` (`AttachmentPreview.tsx:246-274`) desenha a 1ª página e **guarda o documento vivo** até desmontar (o `destroy` só roda no cleanup). Com N PDFs na conversa ficam N workers e N documentos inteiros (até 20 MB cada) na memória.
- Corrida no cleanup: `destroy` é atribuído dentro do `.then` (`:254`). Se o componente desmonta antes do carregamento terminar, o cleanup (`:268-271`) roda com `destroy === null`; quando o carregamento termina, o `.then` atribui `destroy` e retorna por `cancelled` (`:255`) **sem destruir**. O documento e o worker ficam vivos até recarregar a página.
- Isso acontece em uso normal: minimizar a janela desmonta o `ConversationPane` (`AgentWindows.tsx:289,296-298`), ancorar/desancorar remonta (painel × janela flutuante), rolar mensagens não desmonta, mas trocar de sessão sim.
- `PdfCard` (`:276-304`) abre o `PdfViewer` com o mesmo URL: mais um download e mais um worker enquanto o diálogo está aberto.
- O `PdfViewer` (`PdfViewer.tsx:37-54`) trata a corrida certo (`loaded` + `cancelled`), mas também usa um worker por documento.

### Verificação (tentativa de refutação)
- Conferido no código do `pdfjs-dist` instalado que o worker não é compartilhado sem `GlobalWorkerOptions.workerPort` ou `worker` explícito; `GlobalWorkerOptions.workerSrc` (o que o código define) só diz de onde baixar.
- Não há cache das miniaturas: cada montagem baixa o PDF inteiro de novo (o `?inline=1` não tem cache de navegador garantido; o anexo sai do banco a cada pedido, spec 025).
- O e2e (`e2e/tests/agentes.spec.ts:1350`) só confere que o `pdf-card` aparece.

### Impacto
Memória e CPU crescendo com o número de PDFs da sessão (cada worker do pdf.js com o documento carregado ocupa dezenas de MB); vazamento definitivo a cada desmontagem rápida. Sessões de conciliação e de contratos, com vários PDFs, são as mais afetadas.

## Como reproduzir
1. Numa sessão, anexar 5 PDFs grandes.
2. No DevTools → Memory/Performance (ou `chrome://inspect` → workers), contar os workers dedicados: 5 ficam vivos depois das miniaturas prontas.
3. Minimizar e restaurar a janela rapidamente algumas vezes: os workers anteriores não somem.

## Solução proposta
1. Um único `PDFWorker` para a aba: criar uma vez (`new pdfjs.PDFWorker()`) e passar `worker` no `getDocument` (ou definir `GlobalWorkerOptions.workerPort` uma vez).
2. `loadPdf` devolve o `PDFDocumentLoadingTask`; o cleanup chama `task.destroy()` mesmo antes de carregar.
3. `PdfThumb` destrói o documento logo depois de desenhar (fica só o canvas) e guarda a miniatura num cache por `attachmentId` (`Map<string, string>` com `canvas.toDataURL()`), sem baixar de novo ao remontar.
4. Desenhar a miniatura só quando visível (`IntersectionObserver`).
5. Passar `isEvalSupported: false` no `getDocument` (endurecimento, junto com a atualização já registrada).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/agents/AttachmentPreview.tsx
+++ b/apps/web/src/agents/AttachmentPreview.tsx
   useEffect(() => {
     let cancelled = false;
-    let destroy: (() => Promise<void>) | null = null;
-    loadPdf(url)
-      .then(async (doc) => {
-        destroy = () => doc.destroy();
-        if (cancelled || !canvas.current) return;
+    const task = openPdf(url); // devolve o loading task, com o worker compartilhado
+    task.promise
+      .then(async (doc) => {
+        if (cancelled || !canvas.current) return;
         …
         if (context) await page.render({ canvasContext: context, viewport, canvas: el }).promise;
       })
-      .catch(() => !cancelled && setFailed(true));
+      .catch(() => !cancelled && setFailed(true))
+      .finally(() => void task.destroy());
     return () => {
       cancelled = true;
-      void destroy?.();
+      void task.destroy();
     };
```

## Critérios de aceite
- [ ] Com N miniaturas prontas, no máximo um worker do pdf.js por aba.
- [ ] Desmontar antes do carregamento não deixa documento nem worker vivos.
- [ ] Remontar a janela não baixa de novo os PDFs já desenhados.

## Testes recomendados
`e2e/tests/agentes.spec.ts`, no caso das prévias (linha 1350): anexar três PDFs (`minimalPdf()` de `apps/server/test/helpers.ts` como fonte), esperar as miniaturas e conferir `page.workers().length <= 1`; minimizar a janela e conferir que o número não cresce ao restaurar.

## Limitações e suposições
Nada foi executado; o consumo exato por worker depende do PDF.

## Análise (triagem)

## Resolução (executor)
