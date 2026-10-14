---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-10-14
commit:
---

# Áudio gerado por mensagem e metadados de anexo no banco (F11)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [025](../docs/025-chat-multimidia.md), seção "Banco (dba)". O que fazer: Origem `message_id` + `block_index` no derivado `speech` (ou forma equivalente) com o anexo gerado em `attachment_links`; `ai_message_attachments.duration_ms`/`page_count`; claim da fila de transcrições.

Ordem: Depois da F10; depois vem a 025. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [025](../docs/025-chat-multimidia.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, pgTAP e `schema.sql`.
- Parte de `ai_attachment_derivatives`, criada na 022.
- `attachment_links` é uma VIEW (`schema.sql` l. 6350): o áudio gerado entra num ramo novo, `ai_message_speech`.
- As linhas de `ai_message_attachments` (l. 5574) são criadas pelo banco, pelo trigger `ai_messages_after_insert`, a partir dos blocos da mensagem.

**Riscos e observações**
- **`duration_ms`/`page_count` em `ai_message_attachments`**: a duração e o número de páginas são conhecidos no upload, antes de a mensagem existir, mas a linha do vínculo só nasce no INSERT da mensagem. A aplicação teria de fazer um UPDATE depois, e o mesmo anexo pode estar em várias mensagens (bifurcação). Recomendação: guardar no próprio anexo (coluna em `attachments` ou metadado do derivado).
- **Fila de transcrição**: claim com `SKIP LOCKED` nos derivados `pending`, com tentativas e uma reserva que expira.
- **Exclusão da conversa**: hoje ela apaga os anexos que ficam sem vínculo (`services/conversations.ts`). O ramo novo da view muda o que conta como "sem vínculo". O CASCADE precisa ir da mensagem para o derivado `speech` e daí para o anexo gerado, ou a aplicação apaga o anexo.

**Dependências**
- Depois da F10 (022 e 023). A 025 vem depois.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - o derivado `speech` é único por mensagem, bloco, modelo e voz;
  - o anexo gerado aparece em `attachment_links`;
  - excluir a conversa leva o áudio gerado;
  - dois workers não reservam a mesma transcrição.

**Pontos para a revisão da spec**
1. (025 × 024, Banco) A origem do `speech` (mensagem + bloco) contradiz a definição de `ai_attachment_derivatives` na 024, onde `attachment_id` é a origem e falta `voice`. Recomendação: resolver na 024 (veja a 022, ponto 1). Esta tarefa fica só com os metadados e a fila.
2. (025, Banco) `duration_ms`/`page_count` no vínculo `ai_message_attachments`. Recomendação: guardar no anexo.

## Resolução (executor)
