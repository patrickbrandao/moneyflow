---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# Resposta e prévias de aprovação seguem para o Telegram depois de desfazer o pareamento ou desligar a entrada

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** autorização revogada não respeitada
- **Arquivos afetados:** `apps/server/src/services/telegram-inbound.ts:196-208,554-558,594-612,633-671`, `apps/server/src/agents/runner.ts:85-98`, `apps/server/src/services/messages.ts:231-234`, `database/migrations/0046_telegram_inbound_bot_token.sql:22-27`, `docs/029-fluxos-autonomos.md:64`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Desfazer o vínculo do Telegram, por exemplo depois de perder o celular, não corta a resposta que já estava a caminho. Ela, e os cartões de aprovação com valores e nomes, ainda chegam ao chat desvinculado.

### Evidência e análise técnica
- `deliverRunToTelegram` (`telegram-inbound.ts:633-671`) e `startTyping` (`:604-612`) leem só a origem gravada no evento (`telegramOrigin`, `:594-601`) e o token por `inboundToken`. Nenhum dos dois consulta `telegram_links.revoked_at` nem `inbound_enabled`. `processRun` (`runner.ts:85-98`) chama os dois.
- `revokeLink` (`:196-208`) só grava `revoked_at` e não para a execução.
- Desligar a entrada (`messages.ts:231-234`) faz só `inbound_enabled = false` e mantém o `webhook_secret_hash`, então `telegram_inbound_bot_token` (`0046:22-27`) continua entregando o token.

### Verificação (tentativa de refutação)
- O clique nos botões é recusado depois da revogação (`handleCallback`, `:554-558`), mas a prévia da confirmação já chegou ao chat.
- Desativar ou arquivar o destino bloqueia o envio; desfazer o pareamento e desligar a entrada, não.
- Uma execução que espera aprovação e é aprovada depois pelo console retoma e entrega a resposta final ao chat.
- `docs/029:64` fala em desfazer pareamentos, sem dizer o que acontece com as execuções em curso.
- Rebaixado de média para baixa: o destinatário é o mesmo chat que estava legitimamente pareado, e a janela vai só até a execução em curso terminar.

### Impacto
A resposta do agente e as prévias de confirmação vão para um chat que o usuário quis desligar.

## Como reproduzir
Com a Bot API falsa: parear, mandar uma mensagem que leve a uma tool em `ask`, revogar o link, aprovar pela API do console. O texto final chega ao chat em `telegram.calls`.

## Solução proposta
- Antes de enviar e no `startTyping`, conferir que existe link ativo para (destino, chat, `run.user_id`) e que `inbound_enabled` está ligado. Sem isso, não enviar (opcionalmente, gravar `telegram/sent` com `skipped`).
- Opcional: `revokeLink` pedir o cancelamento das execuções ativas desse chat.
- Documentar em `docs/029`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/telegram-inbound.ts
+++ b/apps/server/src/services/telegram-inbound.ts
@@
   const run = await loadRun(db, runId);
   if (!run) return;
+  const live = await db.execute<{ ok: boolean }>(sql`
+    SELECT EXISTS (SELECT 1 FROM telegram_links l JOIN message_destinations d ON d.id = l.destination_id
+                    WHERE l.destination_id = ${origin.destinationId} AND l.chat_id = ${origin.chatId}::bigint
+                      AND l.user_id = ${run.user_id} AND l.revoked_at IS NULL AND d.inbound_enabled) AS ok`);
+  if (!live.rows[0]?.ok) return;
   const token = await inboundToken(db, origin.destinationId);
   if (!token) return;
```

## Critérios de aceite
- [ ] Depois de revogar o pareamento, ou de desligar a entrada, nenhum `sendMessage` nem `sendChatAction` daquela execução chega à Bot API.
- [ ] `docs/029` atualizada.

## Testes recomendados
`test/autonomous.test.ts` com `e2e/fakes/fake-telegram.ts`, no cenário de "Como reproduzir" e com a entrada desligada. Nada disso foi executado nesta auditoria.

## Limitações e suposições
O tipo de `telegram_links.chat_id` não foi conferido. O consume usa `bigint`, então é provável que seja o mesmo.

## Análise (triagem)
Sem triagem formal: a sessão principal designou o `app`. Causa confirmada no código atual: `deliverRunToTelegram` e `startTyping` (`services/telegram-inbound.ts`) só liam a origem do evento e o token (`inboundToken`), sem olhar `telegram_links.revoked_at` nem `inbound_enabled`; `revokeLink` só gravava `revoked_at`. `telegram_links.chat_id` é `bigint` (`database/schema.sql`), e a origem guarda o chat como texto.

Decisões da sessão principal: conferir link ativo + `inbound_enabled` antes de enviar e no "digitando…"; ao revogar, pedir o cancelamento das execuções ativas originadas daquele chat se houver caminho simples e seguro (havia: `stopRun` na mesma transação).

## Resolução (executor)
- `originLive(db, origem, userId)` em `services/telegram-inbound.ts`: existe o link (destino, `chat_id::bigint`, usuário da execução) sem `revoked_at` e o destino com `inbound_enabled`, ativo e não arquivado. `deliverRunToTelegram` sai sem enviar (nem cartões nem resposta final) quando não; `startTyping` recebe o `userId` (`runner.ts` passa `claimed.user_id`), não começa sem o link e confere a cada tique de 4 s, parando o intervalo quando o pareamento cai.
- `revokeLink`: na mesma transação do `revoked_at`, acha as execuções ativas do usuário do link com o evento `telegram`/`origin` daquele destino e chat e chama `stopRun` (exportado de `services/conversations.ts`): na fila ou esperando aprovação, canceladas na hora; rodando, pedido de parar ao worker. Desligar a entrada não cancela (a resposta fica no console), só bloqueia o envio.
- Teste novo em `apps/server/test/autonomous.test.ts`: "entrada desligada ou pareamento desfeito: nada da execução vai ao chat; desfazer para a execução daquele chat (tarefa 061)" — com a Bot API falsa: entrada desligada com a execução esperando, aprovada pelo console, conclui sem nenhum `sendMessage`/`sendChatAction` ao chat; pareamento desfeito cancela a execução (aprovar depois não decide nada: `decided: 0`), nada vai ao chat e o outro chat pareado do usuário segue valendo.
- Spec: `docs/029-fluxos-autonomos.md` (seção Telegram de entrada: a checagem antes de cada envio e o cancelamento ao desfazer).
- Rodado no Postgres local (`test:local`): `test/autonomous.test.ts` inteiro, 20/20. O caso depende dos anteriores do `describe` (destino com a entrada ligada e o chat pareado), como os outros do Telegram; sozinho, rode com `-t "ligar \"Receber mensagens\"|uso único e expira|tarefa 061"` (3/3). Ajuste na primeira rodada: aprovar pelo console uma execução já cancelada devolve 200 com `decided: 0` e `runStatus: 'canceled'`, não 422; o teste passou a conferir isso.
