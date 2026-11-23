---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: f7a4441
---

# Microfone fica gravando até 10 minutos se a janela fecha enquanto o navegador pede a permissão

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** recurso não liberado após desmontar (MediaStream, MediaRecorder, timer, object URL)
- **Arquivos afetados:** `apps/web/src/agents/AudioRecorder.tsx:47-52,66-117,126-137`, `apps/web/src/agents/ConversationPane.tsx:673`, `apps/web/src/agents/AgentWindows.tsx:289,296-298`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se você clica no microfone, o navegador pergunta se pode usar o microfone e, antes de responder, você fecha, minimiza ou ancora a janela do agente, ao clicar em "Permitir" a gravação começa escondida e o microfone fica ligado (com o aviso do navegador aceso) por até 10 minutos. Nada é enviado, mas o microfone fica aberto sem você saber por quê.

### Evidência e análise técnica
- `start` (`AudioRecorder.tsx:66-117`) faz `await navigator.mediaDevices.getUserMedia({ audio: true })` (`:79`) e, depois do `await`, sem conferir se o componente ainda está montado, guarda o stream (`:88`), cria e inicia o `MediaRecorder` (`:90,106`) e liga o `setInterval` (`:109-116`).
- O cleanup de desmontagem (`:126-137`) só para o que existe **naquele momento**: com o pedido de permissão pendente, `recorder.current` e `stream.current` ainda são nulos, então não há o que parar. Depois o `await` resolve e tudo começa num componente que já não existe.
- Só o limite de 10 min (`RECORDING_MAX_MS`, `:112-115`) chama `rec.stop()`, que no `onstop` (`:97-104`) libera as trilhas (`release`).
- Desmontar é comum: minimizar tira a janela do DOM (`AgentWindows.tsx:289,296-298`), ancorar/desancorar troca o `ConversationPane` de lugar (remonta), fechar a janela.
- Menor: desmontar na fase "revisão" não revoga o `URL.createObjectURL` da gravação (`:103`); o `revokeObjectURL` só acontece em `clearReview` e `use` (`:54-59,119-124`).

### Verificação (tentativa de refutação)
- Não há `AbortController`/`alive` no hook; `setPhase` num componente desmontado é ignorado pelo React, mas o stream e o recorder continuam.
- O e2e (`e2e/tests/agentes.spec.ts:1382-1387`) usa o microfone falso do Chromium, que concede na hora; o caso do pedido pendente não é coberto.

### Impacto
Microfone aberto sem interface por até 10 min (privacidade e bateria); o áudio fica em memória e é descartado. Pequeno vazamento de memória pelo object URL não revogado.

## Como reproduzir
1. Navegador sem permissão de microfone salva para o site.
2. Na janela do agente, clicar em gravar; com o pedido de permissão aberto, minimizar a janela.
3. Clicar em "Permitir": o indicador de microfone do navegador acende e fica aceso até 10 minutos.

## Solução proposta
1. `alive` (ref) no hook, `false` no cleanup; depois do `await getUserMedia`, se `!alive.current`, parar as trilhas e retornar.
2. Ignorar um segundo `start` enquanto `starting`.
3. No cleanup, revogar a URL da revisão (guardar a URL atual num ref).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/agents/AudioRecorder.tsx
+++ b/apps/web/src/agents/AudioRecorder.tsx
+  const alive = useRef(true);
+  const reviewUrl = useRef<string | null>(null);
@@
     try {
       media = await navigator.mediaDevices.getUserMedia({ audio: true });
     } catch (error) {
@@
     }
+    if (!alive.current) {
+      for (const track of media.getTracks()) track.stop();
+      return;
+    }
     stream.current = media;
@@
   useEffect(
-    () => () => {
+    () => {
+      alive.current = true;
+      return () => {
+        alive.current = false;
+        if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
         const rec = recorder.current;
         …
-    },
+      };
+    },
     [release],
   );
```

## Critérios de aceite
- [x] Desmontar o compositor com o pedido de permissão pendente não deixa trilha de áudio ativa depois que a permissão é concedida.
- [x] Desmontar na revisão revoga a URL da gravação.

## Testes recomendados
`e2e/tests/agentes.spec.ts`: com `page.addInitScript` envolvendo `navigator.mediaDevices.getUserMedia` (atrasar 1 s e guardar os streams em `window.__streams`), clicar em gravar, minimizar a janela antes de 1 s e conferir depois que todas as trilhas de `window.__streams` estão com `readyState === 'ended'`.

## Limitações e suposições
Nada foi executado.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado no código atual: em `useAudioRecorder` (`apps/web/src/agents/AudioRecorder.tsx`), depois do `await getUserMedia` nada conferia se o componente continuava montado, e o cleanup só parava o recorder e o stream que já existiam; a URL da revisão só era revogada em `clearReview`/`use`. Minimizar a janela tira o `ConversationPane` do DOM (`AgentWindows.tsx`).

## Resolução (executor)
`apps/web/src/agents/AudioRecorder.tsx`: o hook guarda `alive` (verdadeiro enquanto montado, falso no cleanup) e, depois do `await getUserMedia`, se a janela já desmontou, para as trilhas na hora e não cria o `MediaRecorder` nem o cronômetro. Um segundo `start` enquanto o primeiro espera a permissão é ignorado (`starting`, liberado no `finally`). O `onstop` que chega depois de desmontar (parar e fechar logo em seguida) só solta as trilhas, sem criar a URL. A URL da gravação em revisão fica num ref e é revogada ao descartar, regravar, anexar e ao desmontar; o cleanup também esquece o recorder.

Testes: e2e novo em `e2e/tests/agentes.spec.ts` → "gravação: minimizar com o pedido de permissão pendente solta o microfone (tarefa 123)": `page.addInitScript` atrasa o `getUserMedia` em 1 s e guarda as trilhas entregues; clicar em gravar, minimizar antes da resposta e conferir que a única trilha entregue termina `ended` (não rodado aqui). O `apps/web` não tem unitários. Verificação: `pnpm verify:quick`.
