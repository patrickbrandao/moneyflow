---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Regravar o token do mesmo bot com a entrada ligada apaga o webhook recém-criado

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** deleteWebhook no bot que acabou de ser religado
- **Arquivos afetados:** `apps/server/src/services/messages.ts:191-238`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se o usuário colar de novo o mesmo token do bot ao editar um destino que recebe mensagens (por exemplo, tentando "consertar" um bot que não responde), a tela confirma que está tudo certo, mas o bot para de receber mensagens. O sistema religa o webhook e, logo em seguida, o desliga achando que é o bot antigo.

### Evidência e análise técnica
Em `updateDestination` (`messages.ts:191-238`), com `d.inboundEnabled = true` e `input.botToken` informado:
- `tokenChanged = input.botToken !== undefined` (`:207`) é verdadeiro para qualquer token digitado, inclusive o mesmo;
- `oldToken` é lido antes da troca (`:216`): é o mesmo token;
- `enabling` é verdadeiro (`:209`): na transação, grava o token, um segredo novo e chama `setWebhook` com ele (`:222-229`);
- depois, `if (oldToken && (disabling || tokenChanged)) await dropWebhook(ctx.config, oldToken)` (`:236`) chama `deleteWebhook` no mesmo bot, que apaga o webhook que acabou de ser criado (o webhook é do bot, não do token).

O destino fica com `inbound_enabled = true`, a tela mostra "Receber mensagens" ligado e o Telegram não entrega mais nada (o `deleteWebhook` ainda usa `drop_pending_updates: true`, `integrations/telegram.ts:161-163`).

### Verificação (tentativa de refutação)
- Com um token novo de outro bot, o fluxo está certo: o webhook sai do bot antigo.
- Com um token regenerado do mesmo bot (BotFather), o antigo fica inválido e o `deleteWebhook` falha calado (`.catch(() => null)`, `:271`), então não há dano.
- O dano fica no mesmo token (ou em qualquer token cujo `bot_id`, a parte antes de `:`, seja o do destino e o antigo ainda valha). O campo vem vazio na edição (`docs/013:19`), então digitar o token de novo é um gesto natural para quem acha que precisa.
- Nenhum teste troca o token com a entrada ligada (`autonomous.test.ts`).

### Impacto
O Telegram de entrada para de funcionar sem nenhum sinal na interface; o conserto (desligar e ligar a entrada) não é óbvio.

## Como reproduzir
1. Destino com "Receber mensagens" ligado (Bot API falsa).
2. `PATCH /api/message-destinations/:id` com `{ "botToken": "<o mesmo token>" }`.
3. A Bot API falsa registra `setWebhook` seguido de `deleteWebhook` no mesmo bot; mensagens novas ao bot não chegam ao webhook.

## Solução proposta
Só derrubar o webhook antigo quando o bot mudou (comparando a parte pública do token):

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/messages.ts
+++ b/apps/server/src/services/messages.ts
-  const tokenChanged = input.botToken !== undefined;
+  const tokenChanged = input.botToken !== undefined;
+  // O webhook é do bot: com o mesmo bot (mesmo bot_id), o setWebhook novo já substitui o antigo.
+  const botChanged = tokenChanged && input.botToken!.split(':')[0] !== d.botId;
@@
-  const oldToken = d.inboundEnabled && (disabling || tokenChanged) ? await inboundToken(ctx.db, id) : null;
+  const oldToken = d.inboundEnabled && (disabling || botChanged) ? await inboundToken(ctx.db, id) : null;
@@
-  if (oldToken && (disabling || tokenChanged)) await dropWebhook(ctx.config, oldToken);
+  if (oldToken && (disabling || botChanged)) await dropWebhook(ctx.config, oldToken);
```
(`DestRow` precisa ganhar `botId`, que já vem em `DEST_COLUMNS`.)

## Critérios de aceite
- [ ] Regravar o mesmo token com a entrada ligada mantém o webhook (um `setWebhook`, nenhum `deleteWebhook`).
- [ ] Trocar para o token de outro bot continua chamando `deleteWebhook` no antigo.

## Testes recomendados
`apps/server/test/autonomous.test.ts`, no `describe` do Telegram de entrada: PATCH com o mesmo token e conferência das chamadas registradas pela Bot API falsa (`e2e/fakes/fake-telegram.ts`); e PATCH com o token de um segundo bot, esperando o `deleteWebhook` no primeiro.

## Limitações e suposições
Nada foi executado. A Bot API falsa precisa guardar o webhook por bot (não por token) para o teste refletir o Telegram real; não conferi como ela guarda hoje.

## Análise (triagem)

## Resolução (executor)
