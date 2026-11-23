---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: d0514fa
---

# Na volta à fila por erro do provedor, o console junta o texto parcial ao novo e deixa o erro na tela

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** UX
- **Subcategoria:** evento de retentativa ambíguo
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:334-340`, `apps/server/src/agents/runner.ts:205`, `apps/web/src/agents/useConversation.ts:162-211`, `apps/web/src/agents/useConversation.ts:249`, `packages/shared/src/agents/types.ts:466`, `docs/023-requisicoes-ao-provedor.md:34`
- **Depende de / relacionado a:** tarefa 074
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando a conexão com o provedor cai no meio da resposta e o sistema tenta de novo, a janela do agente mostra o pedaço antigo colado ao começo da resposta nova. Depois que a resposta certa aparece, continua na tela um aviso de erro, como se nada tivesse funcionado.

### Evidência e análise técnica
- Na volta à fila (`runner.ts:334-340`), o runner grava só `{ type: 'error', message }`. Não grava nenhum `status: 'queued'`, nem um código que diga "vai tentar de novo". A nova reserva grava `status: 'running'` (`runner.ts:205`) e recomeça os deltas.
- No console (`useConversation.ts:162-211`):
  - `text_delta` e `thinking_delta` só acrescentam (`setLiveText((text) => text + event.text)`);
  - `status` só atualiza o status da execução;
  - `error` liga `streamError`.
  - O texto ao vivo só é zerado quando chega a mensagem do assistente (`case 'message'`). O texto da tentativa que caiu fica, e o da nova é colado depois dele.
- `streamError` só é limpo ao enviar outra mensagem (`:249`), ao finalizar ou no botão de fechar o aviso. Mesmo com a nova tentativa concluída, o aviso do provedor continua visível.
- `docs/023:34` reconhece que "os deltas já foram ao SSE do console", mas não diz como o console os descarta.

### Verificação (tentativa de refutação)
- O teste `ai-requests.test.ts:195-214` (queda no meio do stream) confere que os deltas chegaram ao SSE e que a execução conclui. Não olha o console.
- O e2e de reconexão (`e2e/tests/agentes.spec.ts`) cobre o `Last-Event-ID`, não a retentativa.
- Confiança "provável": o efeito na tela foi deduzido da leitura do hook, sem rodar o console.

### Impacto
Texto duplicado ou embaralhado durante a nova tentativa, e um aviso de erro falso depois do sucesso. Acontece em toda queda de stream e em todo 5xx/429 persistente que esgota as tentativas da chamada.

## Como reproduzir
Com o provedor falso `{ text: 'Primeiro pedaço. Segundo pedaço. Terceiro pedaço.', chunks: 6, dropAfter: 2, delayMs: 200 }` seguido de uma resposta normal, mande uma mensagem pelo console com o worker rodando. Durante a 2ª tentativa, o texto ao vivo começa com "Primeiro pedaço." da 1ª. Ao fim, o aviso de erro continua acima da resposta.

## Solução proposta
1. Servidor: ao devolver à fila, gravar `{ type: 'error', message, code: 'provider_retry' }` (o mesmo código proposto em tarefa 074) e `{ type: 'status', status: 'queued' }`.
2. Console: no `error` com `code === 'provider_retry'`, zerar `liveText`/`liveThinking` e mostrar um aviso passageiro ("o provedor falhou; tentando de novo…") no lugar do erro. Na chegada da mensagem do assistente ou do `done` com `completed`, limpar `streamError`.

## Critérios de aceite
- [ ] Depois de uma queda no meio do stream, o texto ao vivo da nova tentativa não contém o da anterior.
- [ ] Concluída a nova tentativa, nenhum aviso de erro fica na janela.
- [ ] Uma falha definitiva (`done` com `failed`) continua mostrando o erro.

## Testes recomendados
- e2e `e2e/tests/agentes.spec.ts`: o provedor falso com `dropAfter` seguido de sucesso, conferindo o texto final da bolha e a ausência do aviso.
- Unitário do reducer de eventos, se extraído de `useConversation`.

## Limitações e suposições
Nada foi executado. A parte do console fica em `apps/web`, fora da área desta revisão, mas é a consumidora direta do evento do runner.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado na leitura do hook: o `error` da volta à fila não tinha código, o texto ao vivo só era zerado na mensagem do assistente e o `streamError` ficava depois do sucesso.

## Resolução (executor)

- Servidor (com a tarefa 074): a volta à fila grava `{ type: 'error', code: 'provider_retry' }` e, depois da espera, `{ type: 'status', status: 'queued' }`.
- `apps/web/src/agents/useConversation.ts`: no `provider_retry`, zera o texto e o raciocínio ao vivo e liga `retrying` (não o `streamError`); o primeiro delta, a mensagem do assistente ou o `done` desligam. `done` com `completed` limpa o `streamError`; o `failed` continua mostrando o erro. `ConversationPane.tsx` mostra `t.agentsUi.chat.retrying` ("O provedor de IA falhou; tentando de novo…") na linha de trabalho.
- Testes: `ai-requests.test.ts` (queda no meio do stream: os eventos `provider_retry` e `queued` no fim) e o e2e novo em `e2e/tests/agentes.spec.ts` "o stream do provedor cai no meio; a nova tentativa recomeça sem o texto parcial e sem aviso de erro" (não rodado aqui; fica para o e2e completo da sessão principal).
- Verificação: `pnpm verify:quick` (rápida), com `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s2`.
