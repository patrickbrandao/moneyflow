---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-11-21
commit:
---

# Bifurcar a sessão não religa os arquivos gerados pelas tools

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** anexos na bifurcação (specs 026 e 027)
- **Arquivos afetados:** `database/schema.sql:922-958` (`ai_conversation_fork`), `database/schema.sql:965` (comentário), `database/schema.sql:1437-1451` (`ai_messages_after_insert`), `apps/server/src/agents/runner.ts:419-428`, `apps/server/src/agents/tool-helpers.ts:86-95`, `apps/server/src/services/conversations.ts:252-266`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o agente gera um arquivo (um CSV, um backup) e o usuário depois bifurca a conversa, a cópia mostra a mensagem do arquivo, mas o arquivo não fica preso a ela. Na sessão nova, o agente não consegue mais usar esse arquivo ("o anexo não é desta sessão"). E, se o usuário excluir a conversa original, o arquivo é apagado, embora a cópia ainda o cite.

### Evidência e análise técnica
- Arquivo gerado por tool (`producesFile`, spec 027) é ligado à mensagem `tool` por um INSERT explícito em `ai_message_attachments` (`runner.ts:419-428`). Ele não vira bloco `attachment`, porque o papel `tool` só aceita `tool_result` (`ai_message_content_valid`, `schema.sql:1379-1384`).
- `ai_conversation_fork` (`schema.sql:951-955`) copia só `seq`, `role` e `content`. Os vínculos da cópia nascem do trigger `ai_messages_after_insert` (`schema.sql:1444-1448`), que lê apenas os blocos `attachment` do conteúdo. O vínculo do arquivo gerado não é copiado.
- O comentário da função promete "anexos religados" (`schema.sql:965`).
- Consequências:
  1. `toolAttachment` (`tool-helpers.ts:86-95`) exige que o anexo esteja em `ai_message_attachments` de uma mensagem da conversa da execução. Na sessão bifurcada, "importe aquele arquivo" falha com `attachment_not_in_session`.
  2. `deleteConversation` (`conversations.ts:256-265`) apaga os anexos da conversa que ficaram sem vínculo em `attachment_links`. Excluir a original (finalizada pela bifurcação) apaga o arquivo, e o `tool_result` da cópia passa a apontar para um anexo inexistente (download 404).

### Verificação (tentativa de refutação)
- `forkConversation` (`conversations.ts:275-294`) só chama `ai_conversation_fork`; a aplicação não copia vínculos depois.
- O download na cópia ainda funciona enquanto a original existe, porque `assertReadable` (`attachments.ts:212-219`) aceita o anexo de mensagem de uma conversa do mesmo dono. Por isso o efeito visível aparece só no uso pelo agente e depois da exclusão.
- Os testes da bifurcação (`database/tests/0043_ai_agent_sessions.sql:175-210` e `apps/server/test/agents.test.ts:974-994`) usam só mensagens de texto.

### Impacto
Usuário que bifurca depois de gerar um arquivo perde o acesso do agente a ele na sessão nova e pode perder o arquivo ao limpar as sessões antigas. Pouco frequente.

## Como reproduzir
1. No console, peça ao agente uma tool com `producesFile` (ex.: exportar categorias em CSV).
2. Bifurque a conversa na última mensagem.
3. Na cópia, peça "use o arquivo gerado acima" numa tool que recebe `attachmentId`: erro `attachment_not_in_session`.
4. Exclua a conversa original e tente baixar o arquivo pela cópia: 404.

## Solução proposta
Em migration nova (dba), `ai_conversation_fork` copia os vínculos das mensagens copiadas, casando por `seq`:

### Diff/patch proposto — NÃO APLICADO
```diff
   INSERT INTO ai_messages (conversation_id, seq, role, content)
   SELECT new_id, m.seq, m.role, m.content
     FROM ai_messages m
    WHERE m.conversation_id = src.id AND m.seq <= upto
    ORDER BY m.seq;
+  -- Vínculos que não vêm de blocos attachment (arquivos gerados pelas tools, spec 027).
+  INSERT INTO ai_message_attachments (message_id, attachment_id)
+  SELECT n.id, ma.attachment_id
+    FROM ai_messages o
+    JOIN ai_message_attachments ma ON ma.message_id = o.id
+    JOIN ai_messages n ON n.conversation_id = new_id AND n.seq = o.seq
+   WHERE o.conversation_id = src.id AND o.seq <= upto
+  ON CONFLICT DO NOTHING;
   RETURN new_id;
```

## Critérios de aceite
- [ ] A mensagem `tool` copiada tem os mesmos anexos da original em `ai_message_attachments`.
- [ ] Na sessão bifurcada, a tool que recebe o anexo gerado antes da bifurcação funciona.
- [ ] Excluir a conversa original não apaga um arquivo que a cópia ainda referencia.

## Testes recomendados
- `database/tests/0043_ai_agent_sessions.sql`: mensagem `tool` com vínculo explícito em `ai_message_attachments`; depois da bifurcação, o vínculo existe na cópia.
- `apps/server/test/agents.test.ts` (`describe('sessões (spec 026)')`): gerar arquivo com uma tool falsa `producesFile`, bifurcar, excluir a original e baixar o anexo pela cópia (200).

## Limitações e suposições
Nada foi executado. Não conferi como o front desenha o link do arquivo na mensagem copiada; o efeito descrito vale para o agente e para o download.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no `schema.sql`: `ai_conversation_fork` copiava só `seq`, `role` e `content`. Os vínculos da cópia nasciam só do `ai_messages_after_insert`, que lê os blocos `attachment`. O papel `tool` só aceita `tool_result` (`ai_message_content_valid`), então o arquivo gerado por uma tool, ligado por INSERT explícito em `ai_message_attachments`, ficava sem vínculo na cópia. O comentário da função prometia "anexos religados".

## Resolução (executor)

Migration `database/migrations/0066_ai_conversation_fork_attachments.sql`; teste `database/tests/0066_ai_conversation_fork_attachments.sql`.

- `ai_conversation_fork` copia, depois das mensagens, todos os vínculos de `ai_message_attachments` das mensagens copiadas, casando por `seq`, com `ON CONFLICT (message_id, attachment_id) DO NOTHING`. Os vínculos dos blocos já vêm do trigger. O comentário da função foi atualizado.
- Decisão: o áudio gerado por mensagem (`ai_attachment_derivatives`, `speech`) não é copiado. Ele é refeito sob demanda, e copiá-lo pediria duplicar o derivado.

Testes:
- a cópia tem o anexo do bloco e o arquivo gerado na mensagem `tool`, sem duplicar e sem o vínculo de depois do corte;
- a origem não muda;
- o arquivo está numa mensagem da conversa da cópia, que é o critério do `toolAttachment`;
- a bifurcação da bifurcação leva os vínculos adiante;
- excluir a original deixa em `attachment_links` os anexos que a cópia cita. Só o anexo de depois do corte fica órfão.

Verificação:
- `make test T=/tests/0066_ai_conversation_fork_attachments.sql` passou, com o down da 0066.
- `0026`, `0042` e `0043` passaram de novo.
- `docs/016` (Sessões, Bifurcação) atualizada. `make dump` rodado.

Para a aplicação, nada obrigatório. O teste de integração recomendado (gerar um arquivo, bifurcar, excluir a original e baixar pela cópia) continua útil em `apps/server/test/agents.test.ts`.
