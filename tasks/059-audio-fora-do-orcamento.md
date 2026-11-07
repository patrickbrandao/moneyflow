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

# Texto→áudio e transcrição consomem o provedor sem passar pelo orçamento

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** contorno de orçamento / custo
- **Arquivos afetados:** `apps/server/src/services/chat-media.ts:162-182,237-259,271-306`, `apps/server/src/agents/transcriptions.ts`, `docs/028-limites-e-uso.md:11-12`
- **Depende de / relacionado a:** 060
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Quem estourou o orçamento de IA do mês não consegue mais conversar, mas ainda consegue mandar áudios para transcrever e pedir a leitura em voz das mensagens, gastando com o provedor além do teto.

### Evidência e análise técnica
- Nenhuma chamada a `assertCanStartRun`, `assertBudget` ou `exceededBudget` no upload, que enfileira a transcrição (`chat-media.ts:162-182`), no "tentar de novo" (`:237-259`) e no `messageSpeech`, que chama `speak` (`:271-306`).
- O laço de `agents/transcriptions.ts` também não confere o orçamento.
- O upload exige só ser dono da conversa e não confere `archived_at`.

### Verificação (tentativa de refutação)
- A fala reaproveita o cache por mensagem e trecho (`:288-295`), o que limita o gasto ao histórico existente, salvo se o admin trocar o modelo ou a voz. A transcrição é limitada só pelo número de uploads (20 MB cada).
- `docs/028:11-12` fala em bloquear "criar execução" e "cada chamada ao modelo", sem citar áudio. É lacuna da spec, não violação literal. O custo entra em `ai_usage`, mas nada o barra.

### Impacto
Gasto acima do teto mensal, limitado por uploads e pelo histórico.

## Como reproduzir
Com o orçamento do usuário a 100%: `sendMessage` responde 429, mas o upload de um WAV gera uma chamada a `/v1/audio/transcriptions` no provedor falso, e o speech de uma mensagem nova chama `/v1/audio/speech`.

## Solução proposta
- `assertBudget(ctx, conversation.agent_id, conversation.purpose !== 'chat')` em `messageSpeech`, antes do `speak`.
- Em `uploadChatAttachment` e `retryTranscription`, não enfileirar a transcrição (ou responder 429) com o orçamento estourado. Qual dos dois é decisão de produto.
- Opcional: `exceededBudget` no laço de `transcriptions.ts`, antes da chamada.
- Atualizar `docs/028` (bloqueio em 100% também para áudio→texto e texto→áudio) e `docs/025`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/chat-media.ts
+++ b/apps/server/src/services/chat-media.ts
@@
     if (readOnly) throw forbidden(t.agents.errors.readOnly);
+    await assertBudget(ctx, conversation.agent_id, conversation.purpose !== 'chat');
     const audio = await speak(
@@
   const transcriber = audio ? await inferenceCredentials(ctx.db, conversation.agent_id, 'transcription', ctx.access.actor.id) : null;
+  if (transcriber?.model) await assertBudget(ctx, conversation.agent_id, conversation.purpose !== 'chat');
```

## Critérios de aceite
- [ ] Com o orçamento a 100%, fala nova e transcrição nova respondem 429 `budget_exceeded` (ou o anexo é gravado sem transcrição, conforme a decisão).
- [ ] O admin continua isento, e o áudio em cache continua tocando.
- [ ] Specs 028 e 025 atualizadas.

## Testes recomendados
`test/budgets.test.ts` e `test/chat-media.test.ts`, com um orçamento baixo já estourado: o provedor falso não recebe chamada em `/v1/audio/*`. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Falhar no upload ou só pular a transcrição é decisão de produto: a triagem deve levá-la ao usuário.

## Análise (triagem)

Sem triage (auditoria verificada; a sessão principal designou o app). Confirmado em `services/chat-media.ts`: o upload enfileirava a transcrição, o "tentar de novo" a devolvia à fila e o `messageSpeech` chamava `speak` sem nenhuma checagem de orçamento. O modelo de dados permite registrar a transcrição como falha com o motivo: `ai_attachment_derivatives` aceita `status = 'failed'` com `error` (a aplicação já insere derivados `speech`), e a chave (anexo, provedor, modelo) faz o "tentar de novo" retomá-la por `ai_transcription_retry`. Executor: app.

## Resolução (executor)

Decisão da sessão principal (2026-11-07): com o orçamento estourado, o upload de áudio grava o anexo mas não enfileira a transcrição (fica como falha com o motivo); o "tentar de novo" e o texto→áudio respondem 429 `budget_exceeded`; admin isento.

- `uploadChatAttachment`: com a inferência de transcrição e `exceededBudget` (orçamento da conversa; `flows` quando `purpose ≠ 'chat'`), insere o derivado `transcription` `failed` com "Orçamento de IA do mês atingido: <escopo>", sem chamar o provedor. `retryTranscription` e a fala nova de `messageSpeech` chamam `assertBudget` (429); a fala em cache continua. O admin é isento pelo próprio `exceededBudget`.
- Não acrescentei a checagem no laço de `agents/transcriptions.ts` (opcional na tarefa): a transcrição que já estava na fila antes do estouro ainda roda.
- Teste: `test/chat-media.test.ts` ("orçamento estourado (spec 028, tarefa 059)") — com o orçamento do usuário estourado: upload grava com a transcrição `failed` e nenhuma chamada a `/v1/audio/transcriptions`, o "tentar de novo" e a fala nova dão 429 `budget_exceeded` sem chamar `/v1/audio/speech`, o cache toca, o admin (com o próprio orçamento estourado) enfileira, e sem o orçamento o "tentar de novo" retoma e transcreve.
- Specs: `docs/028-limites-e-uso.md` (Bloqueio em 100%: áudio) e `docs/025-chat-multimidia.md` (Falhas e a rota da fala).
