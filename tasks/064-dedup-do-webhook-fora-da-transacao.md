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

# A dedup do webhook do Telegram fica fora do processamento, que se repete em parte na reentrega

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** bug
- **Subcategoria:** idempotência
- **Arquivos afetados:** `apps/server/src/services/telegram-inbound.ts:219-239,345-372,442-452`, `apps/server/src/routes/telegram.ts:15`, `database/migrations/0045_ai_autonomous_flows.sql:835-847`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P (documentação) ou M (idempotência)
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Se der erro no meio do tratamento de uma mensagem do Telegram, ela pode ser processada de novo e duplicar anexos e respostas. Se o servidor cair no meio, ela pode ser ignorada.

### Evidência e análise técnica
- `handleUpdate` (`telegram-inbound.ts:223-239`) chama `telegram_update_seen` em autocommit, processa e, no erro, apaga a marca (`DELETE FROM telegram_updates_seen ...`) e devolve 500 para o Telegram reentregar.
- `processUpdate` grava em várias transações separadas (`ensureActiveSession`, um `uploadChatAttachment` por arquivo, que enfileira a transcrição, `appendEvent`, `decideSafely`) e manda respostas pela Bot API. Exemplo: com várias mídias, a primeira é gravada e a segunda lança um erro que não é `AppError` (`:442-452`). A reentrega grava a primeira de novo.
- O COMMENT da função (`0045:845-847`) diz "Chame na mesma transação que processa a atualização".
- No sentido oposto, se o processo cai entre a marca e o fim, a marca fica e o update se perde.

### Verificação (tentativa de refutação)
- O desvio do COMMENT é deliberado: o comentário em `telegram-inbound.ts:219-221` assume que a marca é desfeita no erro, e o processamento tem efeitos externos que nenhuma transação desfaria.
- Não há execução duplicada: `sendToAgent` recusa uma execução ativa com `run_active`.

### Impacto
Anexos duplicados na sessão e mensagens repetidas no chat, raramente (erro de banco ou de infraestrutura no meio do processamento).

## Como reproduzir
Com a Bot API falsa devolvendo erro no download do segundo arquivo de um update com duas mídias, chamar o webhook duas vezes com o mesmo `update_id`: o primeiro anexo fica duplicado.

## Solução proposta
Alinhar código e documentação, escolhendo um caminho:
- documentar o modelo "marca antes, desfaz no erro" no COMMENT (dba) e na `docs/029`; ou
- tornar idempotentes as gravações do update, por exemplo uma chave `telegram:<update_id>:<file_unique_id>` no anexo (app).

Não vale envolver numa transação o que chama APIs externas.

### Diff/patch proposto — NÃO APLICADO
```diff
Não aplicável: a correção depende da decisão de desenho entre ajustar o COMMENT e a spec ou tornar as gravações idempotentes.
```

## Critérios de aceite
- [ ] A reentrega após erro no segundo arquivo não cria um segundo anexo para o primeiro, ou o comportamento fica documentado como aceito.
- [ ] O COMMENT de `telegram_update_seen` e a `docs/029` batem com o código.

## Testes recomendados
`test/autonomous.test.ts`, no cenário de "Como reproduzir". Nada disso foi executado nesta auditoria.

## Limitações e suposições
O caminho de código está confirmado; a falha intermediária é um cenário.

## Análise (triagem)
Sem triagem formal: designado ao `app` pela sessão principal. Confirmado: `handleUpdate` marca em autocommit, processa em várias transações e chamadas à Bot API e apaga a marca no erro; o COMMENT de `telegram_update_seen` pede a mesma transação.

Decisão da sessão principal: tornar idempotente o anexo por update (chave `update_id` + `file_unique_id`) só se houver um campo apropriado já existente, sem migration; senão, documentar o modelo "marca antes, desfaz no erro" e registrar que o COMMENT precisa ser alinhado pelo dba. Conferido em `database/schema.sql`: `attachments` não tem metadados (só nome, tipo, conteúdo, duração e páginas), `telegram_updates_seen` só tem destino, `update_id` e data, e o evento `telegram`/`origin` só nasce com a execução, depois dos anexos. Não há onde guardar a chave sem mudar o banco: fica a alternativa de documentação.

## Resolução (executor)
- Documentado o modelo **marca antes, desfaz no erro** em `docs/029-fluxos-autonomos.md` (por que a marca fica fora de transação, o que se repete numa reentrega — anexo órfão gravado de novo com a transcrição, aviso ao chat —, que a mensagem não entra duas vezes e que o update se perde se o processo cair no meio) e nos comentários de `handleUpdate`/cabeçalho de `apps/server/src/services/telegram-inbound.ts`. Código de processamento sem mudança.
- Teste novo em `apps/server/test/autonomous.test.ts`: "erro no processamento desfaz a marca do update_id; a reentrega processa uma vez e a seguinte é ignorada (tarefa 064)" — `handleUpdate` com um banco dublê cuja primeira transação falha: lança, a marca some; a reentrega pelo webhook grava a marca e a mensagem uma vez; a terceira entrega é ignorada.
- **Pendente para o dba (próxima migration):** alinhar o COMMENT de `telegram_update_seen(uuid, bigint)`, que ainda diz "Chame na mesma transação que processa a atualização", ao modelo da spec 029 (marca em autocommit antes do processamento; a aplicação apaga a marca de `telegram_updates_seen` se o processamento falhar). Se um dia quiserem a idempotência por arquivo, ela precisa de um campo novo (ex.: chave de origem no anexo), também do dba.
- Rodado no Postgres local (`test:local`): `test/autonomous.test.ts` inteiro, 20/20; sozinho, com `-t "ligar \"Receber mensagens\"|uso único e expira|tarefa 064"` (3/3), pela mesma dependência do `describe` do Telegram.
- **dba:** migration `database/migrations/0056_telegram_update_seen_comment.sql` só troca o COMMENT de `telegram_update_seen(uuid, bigint)` para o modelo "marca antes, desfaz no erro" da spec 029 (down volta ao texto da 0045); `moneyflow_app` já tinha DELETE em `telegram_updates_seen` (0045), nada a conceder. pgTAP novo `database/tests/0056_telegram_update_seen_comment.sql` (comentário novo, sem "mesma transação", DELETE e EXECUTE do app): `make test T=/tests/0056_telegram_update_seen_comment.sql` 5/5 com o down da última testado, `0045` 265/265; `make migrate` e `make dump` rodados. Sem mudança de schema para o Drizzle. Pendente: a linha de `telegram_updates_seen` em `docs/016-banco-de-dados.md` ainda diz "chamar na transação que processa a atualização".
