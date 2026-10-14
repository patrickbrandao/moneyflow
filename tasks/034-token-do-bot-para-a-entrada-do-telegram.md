---
status: concluida
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: alta
criada: 2026-10-14
commit:
---

# Leitura do token do bot para a entrada do Telegram (F15)

## Descrição
A 0045 (tarefa 032) deu ao Telegram de entrada o segredo do webhook, o pareamento e a dedup, mas a aplicação não tem como ler o `bot_token` fora de uma mensagem reservada da outbox (`message_destination_token(message_id)`, status `sending`) ou do backup do admin (`admin_message_destination_token`). A entrada precisa do token em chamadas que não são mensagens da outbox (spec [029](../docs/029-fluxos-autonomos.md), "Integração Telegram"):

- `setWebhook` ao ligar "Receber mensagens" e `deleteWebhook` ao desligar, desativar ou arquivar o destino (o dono do destino nem sempre é admin);
- no webhook (API, sem sessão): `answerCallbackQuery`, `getFile` e o download do arquivo (`/file/bot<token>/<path>`), e as respostas diretas ao chat privado (aviso de chat não pareado, comandos, recusa);
- no worker: `sendChatAction` ("digitando…") enquanto a execução roda, e a resposta final e os botões Aprovar/Recusar ao chat privado pareado.

Mandar as respostas pela outbox não serve: ela entrega no `chat_id` do destino, e o histórico do destino (visível a quem gerencia um destino de caixa) mostraria a conversa privada de outro usuário com o agente. Passar o token por uma mensagem "de controle" reservada só para isso poluiria o histórico (um `sendChatAction` a cada 4 s).

## Necessidade exata
Uma função `SECURITY DEFINER`, com `EXECUTE` só para `moneyflow_app`, no padrão das demais leitoras de segredo:

- `telegram_inbound_bot_token(p_destination_id uuid) RETURNS text`;
- devolve o `bot_token` só de destino `telegram` **ativo, não arquivado e com `webhook_secret_hash` não nulo** (a entrada está ligada, ou já foi ligada e o hash ficou);
  - ao ligar, a aplicação grava `inbound_enabled = true`, o agente e o hash na mesma transação em que lê o token e chama `setWebhook` (desfaz se o Telegram recusar), então a leitura dentro da transação precisa enxergar o hash recém-gravado;
  - ao desligar, desativar ou arquivar, a aplicação lê o token antes do UPDATE (ainda ativo) e chama `deleteWebhook` depois;
- `42501` em qualquer outro caso (inativo, arquivado, nunca ligado) e `P0002` se o destino não existe;
- comentário dizendo que é a leitura do token para a entrada (spec 029), fora de logs, respostas, auditoria e tools;
- atualizar a 016 (*Segurança*, o parágrafo do bot token) e o pgTAP: certo, inativo, arquivado, sem hash, inexistente, e `moneyflow_app` sem SELECT na coluna continua valendo.

Sugestão: migration nova `0046` (a 0045 já está aplicada no banco de desenvolvimento). Depois, `make dump` e informar a aplicação para o `pnpm db:pull`.

## Como reproduzir
Não se aplica (necessidade nova da tarefa [033](033-fluxos-autonomos-na-aplicacao.md)).

## Análise (triagem)
Aberta pelo agente de aplicação durante a 033; designada direto ao dba (escopo `database/`).

## Resolução (executor)
Feito pelo dba em 2026-10-14 (sem commit; a sessão principal commita). Como pedido, sem decisões em aberto.

**Migration `database/migrations/0046_telegram_inbound_bot_token.sql`**
- `telegram_inbound_bot_token(p_destination_id uuid) RETURNS text`: `plpgsql STABLE SECURITY DEFINER`, `search_path` fixo, `EXECUTE` revogado de `PUBLIC` e concedido só a `moneyflow_app`.
- Devolve `bot_token` só de destino `channel = 'telegram'`, `is_active`, `archived_at IS NULL` e `webhook_secret_hash IS NOT NULL`. Não exige `inbound_enabled`: um destino com a entrada desligada e o hash mantido ainda devolve o token (para o `deleteWebhook`).
- Destino inexistente: `P0002` (`no_data_found`). Inativo, arquivado ou nunca ligado (sem hash): `42501` (`insufficient_privilege`). A mensagem de erro traz só o id do destino, nunca o token.
- Lê na mesma transação: o hash gravado antes, na mesma transação, já vale (função `STABLE`, mesmo snapshot dos comandos anteriores).
- `COMMENT ON FUNCTION` diz que é a leitura para a entrada (spec 029) e que o token fica fora de logs, respostas, auditoria, eventos e tools.
- Down: `DROP FUNCTION`.

**pgTAP `database/tests/0046_telegram_inbound_bot_token.sql`** (21 testes): função `SECURITY DEFINER`/`STABLE` com `search_path` fixo; `EXECUTE` só para a aplicação; `moneyflow_app` continua sem SELECT em `bot_token` e `webhook_secret_hash` (e `SELECT bot_token` dá `42501`). Casos, como `moneyflow_app`: antes de gravar o hash, `42501`; depois de ligar (`inbound_enabled`, agente e hash) na mesma transação, devolve o token; entrada desligada com o hash mantido devolve o token; inativo, arquivado e nunca ligado dão `42501`; inexistente, `P0002`; o erro não traz o token; lido antes de desativar e, depois de desativar na mesma transação, `42501`.

- `make -C database test`: 42 arquivos, 3258 testes, PASS (inclui o down da 0046).
- `make dump` rodado (`database/schema.sql`); aplicada no banco de desenvolvimento (46 aplicadas, nenhuma pendente).
- Docs: [016](../docs/016-banco-de-dados.md), em *Segurança*, no parágrafo do bot token. O resumo do INDEX não mudou.

**Para a aplicação (033)**: `pnpm db:pull` (só uma função nova, nenhuma tabela nem coluna mudou). Chame `SELECT telegram_inbound_bot_token($1)` dentro do `withTx` que grava a entrada. Trate `42501`/`P0002` como "entrada indisponível", sem expor o token.
