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

# Resposta e botões do agente no Telegram são marcados como enviados antes do envio e se perdem numa falha

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** entrega no máximo uma vez sem nova tentativa
- **Arquivos afetados:** `apps/server/src/services/telegram-inbound.ts:267-275,680-719`, `apps/server/src/integrations/telegram.ts:118-149`, `apps/server/src/agents/runner.ts:92-97`, `docs/029-fluxos-autonomos.md:148`
- **Depende de / relacionado a:** tarefa 061 (o `originLive` antes de cada envio)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o agente termina de responder a uma mensagem vinda do Telegram, o sistema anota "já mandei" e só depois tenta mandar. Se o Telegram estiver fora por um instante, a resposta (ou os botões Aprovar/Recusar) nunca chega ao chat. O usuário fica esperando e, se escrever de novo, ouve que há uma execução esperando aprovação, sem os botões para aprovar.

### Evidência e análise técnica
- `deliverRunToTelegram` grava o evento `telegram/sent` e depois envia: `await mark(key); await b.say(...)` para cada cartão de confirmação (`telegram-inbound.ts:706-707`) e `await mark('final')` antes da resposta final (`:712-718`).
- `bot().say` engole a falha: `if (!result.ok) deps.log.warn(...)` (`:270-273`). `sendChatMessage` só repete uma vez num 429 de até 30 s e no HTML recusado (`integrations/telegram.ts:132-147`); erro de rede, timeout (`TELEGRAM_TIMEOUT_MS`, 10 s) e 5xx não têm nova tentativa.
- `deliverRunToTelegram` só é chamado uma vez, no fim de `processRun` (`runner.ts:92-97`). Com a marca gravada, nada volta a tentar.
- Na resposta longa em várias partes (`:717-718`), uma parte que falha some e as seguintes saem, e o texto chega truncado no meio.

### Verificação (tentativa de refutação)
- A spec pede que o que já foi ao chat não se repita (`docs/029:148`), e marcar antes evita duplicar se o processo cair entre o envio e a marca. Mas o efeito oposto (perder a resposta numa falha comum de rede) não está documentado nem tratado.
- A resposta continua no console, então não há perda de dado, só de entrega.
- Os testes do Telegram (`autonomous.test.ts`) usam a Bot API falsa sempre disponível; nenhum simula falha no envio da resposta.

### Impacto
Em qualquer instabilidade da Bot API, o usuário do Telegram fica sem a resposta ou sem os botões, sem aviso nenhum. No caso dos botões, a conversa trava até alguém aprovar pelo console ou a confirmação expirar (7 dias).

## Como reproduzir
1. Telegram de entrada pareado com a Bot API falsa (`e2e/fakes/fake-telegram.ts`).
2. Configure a falsa para responder 502 no próximo `sendMessage`.
3. Mande uma mensagem pelo chat: a execução conclui, o evento `telegram/sent` com `key: 'final'` é gravado e nenhuma resposta chega ao chat, nem depois.

## Solução proposta
1. `say` devolve `ok`/erro em vez de só logar.
2. Marcar `sent` depois do envio bem-sucedido (o risco de repetir fica no intervalo entre o envio e a marca, bem menor que o de perder).
3. Em falha transitória (rede, 5xx, 429 longo), tentar de novo com espera curta (duas ou três vezes, 2–10 s); se ainda falhar, gravar um evento `telegram/failed` e, na próxima mensagem do usuário naquele chat (ou num tique da manutenção), reenviar o que ficou pendente: cartões de confirmações ainda pendentes e a resposta final sem `sent`.
4. Na resposta em partes, marcar por parte (`final:0`, `final:1`…), para não repetir as que já saíram.

## Critérios de aceite
- [ ] Com a Bot API falhando uma vez com 502, a resposta final chega ao chat.
- [ ] Os botões de uma confirmação pendente chegam mesmo que o primeiro envio falhe.
- [ ] Nada se repete quando o envio funciona da primeira vez.

## Testes recomendados
`apps/server/test/autonomous.test.ts`, no `describe` do Telegram: a Bot API falsa com um modo "falha N vezes" no `sendMessage`; mensagem do chat → execução concluída → a resposta aparece na falsa depois da nova tentativa e o evento `telegram/sent` só existe depois dela. O mesmo para o cartão de confirmação com uma tool em `ask`.

## Limitações e suposições
Nada foi executado. A escolha entre "no máximo uma vez" e "pelo menos uma vez" é de produto; proponho a segunda porque a duplicata de uma resposta é menos grave que a perda dos botões de aprovação.

## Análise (triagem)

## Resolução (executor)
