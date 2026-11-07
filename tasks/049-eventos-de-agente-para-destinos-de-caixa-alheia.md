---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-07
commit: 9991a6b
---

# Eventos de agente vão para destinos de caixa que o usuário da execução não lê

- **Severidade:** alta
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** vazamento de dados entre caixas / autorização ausente
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:84-89,453-463,772-775,812-819`, `apps/server/src/agents/events-hub.ts:138-147`, `apps/server/src/agents/tool-handlers.ts:936-950`, `apps/server/src/services/messages.ts:70-73,312-315`, `docs/013-mensagens-telegram.md:32`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder; achado de forma independente por dois lotes)

## Descrição

### Explicação para leigos
Quem cuida de uma caixa pode criar um "grupo de avisos" no Telegram para ela. Do jeito que está, esse grupo passa a receber as respostas dos assistentes de IA de todos os usuários do sistema, inclusive sobre finanças que os membros da caixa não podem ver. Também recebe o texto livre que qualquer agente manda pela tool `notify_user`.

### Evidência e análise técnica
- `emitAgentEvent` (`message-worker.ts:816-818`): `const sharedCaixa = sub.owner_caixa_id !== null && (event.caixaId ? scope.includes(event.caixaId) : event.kind !== 'ai_awaiting_approval' && scope.length > 0);`
- `scope` vem de `destinationScope(db, sub)` (`:84-89`). Para destino de caixa, é a caixa dona e os cartões dela, sem relação com o usuário do evento.
- Os dois emissores não passam `caixaId`: `agent_completed` (`events-hub.ts:138-147`, com a última resposta do assistente ou o erro, até 2000 caracteres) e `notify_user` (`tool-handlers.ts:939-948`). Sem `caixaId`, a condição vira `scope.length > 0`, que vale para todo destino de caixa não arquivada.
- `activeSubscriptions` (`:453-463`) filtra só pelo tipo de evento, e o `caixa_filter` da assinatura é ignorado.

### Verificação (tentativa de refutação)
- `upsertSubscription` (`messages.ts:312-315`) só exige gerenciar o destino (`canManage`, escrita na caixa, `:70-73`) e não restringe o tipo de evento. `agent_completed` e `agent_message` estão na lista permitida (`packages/shared/src/schemas/vision.ts:97-98,124-125`).
- Nenhum ponto do caminho confere se `event.userId` lê a caixa do destino.
- Contraria a spec: `docs/013:32` diz "aos de caixa que ele lê", e o comentário em `message-worker.ts:772-775` diz "das caixas que ele lê". O teste `apps/server/test/vision.test.ts:442-472` cobre só o destino pessoal.

### Impacto
Resumos financeiros, nomes, valores e erros de execução de qualquer usuário, admin incluído, vão para um chat externo. A outbox guarda o payload, e o histórico de mensagens mostra o texto a quem lê a caixa do destino. O `notify_user`, inclusive pelo `/mcp`, deixa qualquer usuário mandar texto arbitrário ao Telegram de caixas com que não tem relação, o que abre caminho para phishing.

## Como reproduzir
1. Como editor da caixa X, criar um destino de caixa X e assinar `agent_completed`.
2. Como um usuário B sem acesso a X, conversar com um agente e fechar o console antes do fim da execução.
3. A resposta final de B é enfileirada para o chat do destino de X.

## Solução proposta
- Destino de caixa só recebe evento de agente se o usuário do evento lê a caixa dona do destino, via `loadAccess` do ator e `canRead(sub.owner_caixa_id)`.
- Com `caixaId`, manter também `scope.includes(caixaId)`.
- Respeitar o `caixa_filter` da assinatura, se houver.
- Precisar o texto de `docs/013:32`: "a caixa dona do destino, que o usuário da execução lê".

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/message-worker.ts
+++ b/apps/server/src/services/message-worker.ts
@@
   const subs = await activeSubscriptions(db, [event.kind]);
+  const [actor] = await db.select(userColumns).from(users).where(eq(users.id, event.userId));
+  const actorAccess = actor?.isActive ? await loadAccess(db, actor as Actor) : null;
   let queued = 0;
   for (const sub of subs) {
     const scope = await destinationScope(db, sub);
     const personal = sub.owner_user_id === event.userId;
     // A aprovação pendente sem caixa (tarefa agendada) é do usuário: só os destinos pessoais dele.
     const sharedCaixa =
       sub.owner_caixa_id !== null &&
-      (event.caixaId ? scope.includes(event.caixaId) : event.kind !== 'ai_awaiting_approval' && scope.length > 0);
+      actorAccess !== null &&
+      actorAccess.canRead(sub.owner_caixa_id) &&
+      (event.caixaId ? scope.includes(event.caixaId) : event.kind !== 'ai_awaiting_approval');
     if (!personal && !sharedCaixa) continue;
```
Os imports de `loadAccess`, `userColumns`, `users` e `eq` precisam ser conferidos no arquivo.

## Critérios de aceite
- [ ] O destino da caixa X não recebe `agent_completed` nem `agent_message` de um usuário sem leitura em X.
- [ ] Recebe o de um membro de X e o do admin.
- [ ] O destino pessoal do usuário continua recebendo.
- [ ] `ai_awaiting_approval` da conciliação segue indo aos destinos de caixa que veem a caixa do lote.
- [ ] `docs/013` precisada.

## Testes recomendados
Em `apps/server/test/vision.test.ts`, ao lado do teste de `emitAgentEvent`, ou em `test/autonomous.test.ts`: dois usuários (A, editor de X; B, sem acesso a X) e um destino de X assinando `agent_completed`. Esperado: `emitAgentEvent` com `userId` B dá `queued 0`; com A dá `queued 1`. O mesmo para `notify_user` pelo handler. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Leitura estática. Pelo desenho, membros da caixa continuam vendo as respostas de um colega que também lê a caixa.

## Análise (triagem)

Triagem em 2026-11-07, sobre o `main` (`1ebb073`). Confirmei lendo o código. Não rodei teste, porque para reproduzir seria preciso escrever um teste novo.

**Causa confirmada.** Em `emitAgentEvent` (`apps/server/src/services/message-worker.ts`, por volta das linhas 812-819), um destino de caixa entra na fila quando `sub.owner_caixa_id !== null` e vale uma de duas condições: com `caixaId`, `scope.includes(caixaId)`; sem `caixaId`, `kind !== 'ai_awaiting_approval' && scope.length > 0`. `destinationScope` (linhas 84-89) devolve, para um destino de caixa, a caixa e os cartões dela. Nada ali olha `event.userId`. Os dois emissores de `agent_completed`/`agent_message` chamam sem `caixaId`:
- `agents/events-hub.ts:138` manda a última resposta do assistente ou o erro, até 2000 caracteres.
- `agents/tool-handlers.ts:939` é o `notify_user`, também chamado pelo `/mcp`.

Por isso, todo destino de caixa não arquivada que assina esses tipos recebe os eventos de qualquer usuário. `activeSubscriptions` só filtra pelo tipo de evento. O `caixa_filter` só é aplicado em `produceMessages` (`applyFilter`, linha 542), e `emitAgentEvent` o ignora. O caso `ai_awaiting_approval` (`services/autonomous-notify.ts:67`) passa `caixaId` e não sofre do problema. Isso contraria `docs/013-mensagens-telegram.md` (item Agente: "aos de caixa que ele lê") e o próprio comentário de `emitAgentEvent`. O único teste, em `test/vision.test.ts:442`, cobre só o destino pessoal.

**Correção indicada.** Seguir o diff da tarefa, com dois ajustes:
- Carregar o `Access` do usuário do evento uma vez, fora do laço: `userColumns`, `isActive` e `loadAccess`, como `destinationScope` já faz. Exigir `access.canRead(sub.owner_caixa_id)` para destino de caixa. O admin global passa.
- Manter `scope.length > 0`, para que um destino de caixa arquivada continue fora. Com `caixaId`, manter também `scope.includes(caixaId)`.

Respeitar o `caixa_filter` da assinatura é opcional: num destino de caixa ele só pode restringir à própria caixa ou aos cartões dela. Sem `caixaId`, a sugestão é ignorar o filtro e deixar isso registrado. Destino global e destino pessoal de outro usuário seguem sem receber.

**Arquivos.** `apps/server/src/services/message-worker.ts` (`emitAgentEvent`); testes em `apps/server/test/vision.test.ts`, ao lado do teste atual, ou em `test/autonomous.test.ts`; spec `docs/013-mensagens-telegram.md`, no item Agente, que deve dizer "a caixa dona do destino, que o usuário da execução lê". Também afeta a spec 011 (`notify_user`), mas o texto dela não muda. Nada em `database/`.

**Risco.** Baixo. A mudança fica numa função só, e o comportamento de quem lê a caixa não muda. É preciso conferir que o caso `ai_awaiting_approval` da conciliação, com caixa, continua indo ao destino da caixa do lote.

**Como verificar.**
1. Montar: usuário A editor da caixa X, usuário B sem acesso a X, um destino de X assinando `agent_completed` e `agent_message`. Esperado:
   - `emitAgentEvent` com B: `queued 0`.
   - Com A e com o admin: `queued 1`.
   - O destino pessoal de B continua recebendo.
   - `notify_user` pelo handler, como B: `queued` sem o destino de X.
   - `ai_awaiting_approval` com `caixaId` de X continua indo ao destino de X.
2. Depois rodar `pnpm --filter @moneyflow/server test:local test/vision.test.ts -t "evento de agente"` e `pnpm verify:quick`.

**Executor:** `app`. Tipo `bug`, prioridade alta (vazamento de dados entre caixas para um chat externo). Não depende de decisão de produto.

## Resolução (executor)

**O que mudou.** `apps/server/src/services/message-worker.ts` (`emitAgentEvent`): o `Access` do usuário do evento é carregado uma vez, sob demanda (`userColumns`, `isActive`, `loadAccess`), e um destino de caixa só entra se esse usuário lê a caixa dona dele (`canRead(owner_caixa_id)`; admin global passa, usuário inativo não). Depois disso a regra antiga continua: com `caixaId`, `scope.includes(caixaId)`; sem, `kind !== 'ai_awaiting_approval' && scope.length > 0` (caixa arquivada fica fora). O destino pessoal do usuário segue igual. O `caixa_filter` da assinatura continua ignorado sem caixa no evento (decisão da triagem, registrada no comentário e na spec). Comentário da função corrigido.

**Testes.** `apps/server/test/vision.test.ts`, caso novo "evento de agente: o destino de caixa só recebe de quem lê a caixa dona dele (tarefa 049)": destino da caixa A assinando `agent_completed`, `agent_message` e `ai_awaiting_approval`; o usuário sem acesso a A não enfileira nada para ele (os dois tipos), o editor de A e o admin enfileiram 1; o destino pessoal do usuário sem acesso continua recebendo; `ai_awaiting_approval` com a caixa A vai ao destino (membro), com a caixa B não vai (nem do admin) e do usuário sem acesso não vai; a tool `notify_user` pelo handler (caminho do `/mcp`) não enfileira para o destino de A quando o usuário não lê A e enfileira quando lê. `vision.test.ts` (9) e `autonomous.test.ts` (17) passam no modo local.

**Specs.** `docs/013-mensagens-telegram.md`, item Agente.

