---
status: concluida
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
Feito pelo dba em 2026-10-14 (sem commit ainda; a sessão principal commita). Os pontos 1 e 2 da revisão ficaram como a triagem recomendou: a origem do `speech` (mensagem + bloco), a voz, o ramo `ai_message_speech` de `attachment_links` e a exclusão do áudio gerado com a conversa já vieram na 0041 (tarefa 022) e estão testados lá; a duração e as páginas ficaram no anexo.

**Migration `database/migrations/0042_ai_chat_multimedia.sql`**
- **`attachments`**:
  - `duration_ms integer` (1 ms a 24 h, só com `mime_type` `audio/*` ou `video/*`: o Safari grava `video/mp4` às vezes) — `attachments_duration_ms_check`;
  - `page_count integer` (1 a 100 mil, só com `application/pdf`) — `attachments_page_count_check`;
  - os dois opcionais (nulos passam), atualizáveis depois do upload, e a troca do `mime_type` que os deixe inválidos é recusada;
  - `attachments_audit_row()` passa a registrar os dois (o conteúdo continua fora).
- **`ai_attachment_derivatives`** ganhou:
  - `lock_token uuid`, a cerca da reserva, como em `ai_runs`. O `ai_attachment_derivatives_lock_check` passou a exigir `locked_at` **e** `lock_token` se e somente se `running`;
  - `conversation_id` (FK `ON DELETE SET NULL`, com índice): a conversa em que a transcrição foi pedida. Sem ela, o worker não teria a quem atribuir o uso e a requisição (spec 023: agente, usuário e conversa), nem um ator para as credenciais. Excluir a conversa deixa o cache do anexo.
- **Fila da transcrição** (só `kind = 'transcription'`):
  - `ai_transcription_enqueue(anexo, provedor, modelo, conversa = NULL)` → a linha:
    - insere `pending`;
    - se já existe uma para o anexo, o provedor e o modelo, devolve a existente como está (o `ON CONFLICT DO NOTHING` sozinho não devolveria a linha).
  - `ai_transcription_claim(limite = 1, reserva_velha = '10 minutes', tentativas = 3)` → `SETOF ai_attachment_derivatives`:
    - `FOR UPDATE SKIP LOCKED`, em ordem de criação;
    - pega as `pending` e as `running` com reserva mais velha que o prazo (o worker caiu);
    - grava `running`, `locked_at`, `lock_token` novo e `attempts + 1`;
    - sem tentativas restantes, a reserva velha vira `failed` com `stale_lock: …`, e a pendente, com `max_attempts: …`.
  - `ai_transcription_credentials(id, lock_token)` (`SECURITY DEFINER`, sem `EXECUTE` para PUBLIC): devolve a chave do provedor do derivado só para quem tem a reserva, mais a atribuição.
  - `ai_transcription_complete(id, lock_token, texto)` e `ai_transcription_fail(id, lock_token, erro)` → `boolean`. `false` = reserva perdida: descarte.
  - `ai_transcription_retry(id)` → a linha: `failed` → `pending`, tentativas zeradas e sem erro; nos outros estados, nada muda (clique repetido não dá erro).
- Down: desfaz tudo (testado pelo `make test`: up, rollback, up).

**Testes**
- `database/tests/0042_ai_chat_multimedia.sql` (119 testes):
  - estrutura, `SET NULL` da conversa, `SECURITY DEFINER` e privilégios;
  - os limites e o tipo MIME de `duration_ms`/`page_count`, a troca de MIME e a auditoria;
  - **dois workers de verdade (dblink)**: o 2º pula a linha travada pelo 1º sem esperar, e cada transcrição é reservada uma vez só;
  - enfileirar (idempotente, erros), os parâmetros do claim, a descrição pendente fora da fila e a cerca obrigatória em `running`;
  - credenciais: atribuição pela conversa, sem conversa, cerca errada ou nula, inexistente, outro tipo, provedor inativo ou sem a flag, dono ou agente inativo;
  - concluir (cerca errada, texto nulo, de novo, texto vazio) e falhar (corte em 4000, mensagem padrão);
  - tentar de novo; reserva velha retomada com cerca nova (o worker antigo não grava nem lê a chave); limite de tentativas na reserva velha e na pendente;
  - fila fora da auditoria; conversa excluída; o fluxo inteiro como `moneyflow_app`.
- Ajustados: `0011` (colunas de `attachments`) e `0041` (colunas dos derivados; a reserva manual passou a levar `lock_token`).
- `make test`: PASS (38 arquivos, 2748 testes). `make dump` rodado; o seed carrega.
- Docs: [016](../docs/016-banco-de-dados.md) (Anexos e "Fila da transcrição" em Derivados) e o resumo da 016 no [INDEX](../docs/INDEX.md).

**Para a 025 (app)**
- `pnpm db:pull`. Colunas novas: `attachments.duration_ms` e `page_count`, `ai_attachment_derivatives.lock_token` e `conversation_id`.
- **Upload da conversa**:
  - grave `duration_ms` (áudio) e `page_count` (PDF) no INSERT do anexo, ou num UPDATE depois. Normalize o MIME: com `application/octet-stream`, a duração é recusada;
  - se o agente tem a inferência `transcription`, resolva provedor e modelo por `ai_capability_credentials(agente, 'transcription', usuário)` (modelo nulo = não configurado: não enfileire) e chame `ai_transcription_enqueue(anexo, provedor, modelo, conversa)`.
- **Worker**, a cada ciclo:
  1. `SELECT * FROM ai_transcription_claim(n)` numa transação curta, e COMMIT;
  2. `ai_transcription_credentials(id, lock_token)` (na falha `42501`, chame `ai_transcription_fail`; na `23514`, descarte);
  3. chame o provedor;
  4. grave `ai_usage`/`ai_requests` com `purpose = 'transcription'`, usuário, agente e conversa vindos das credenciais;
  5. `ai_transcription_complete` ou `ai_transcription_fail`.
  - O prazo padrão da reserva é 10 min (não há heartbeat). Se uma transcrição puder passar disso, passe um `p_stale_after` maior.
- **"Tentar de novo"**: `POST /api/attachments/:id/transcribe` → `ai_transcription_retry(id do derivado)`; a permissão de escrita é da aplicação. Se o agente agora usa outro provedor ou modelo, chame `ai_transcription_enqueue` com os novos: é outra linha.
- **Espera no runner**: os derivados `transcription` dos anexos da mensagem, em `pending`/`running`. Recomendo usar o derivado mais recente do anexo, qualquer que seja o provedor, para não esperar por uma linha que nunca vai existir quando o agente troca de inferência.
- **Erros**:
  - a traduzir:
    - `attachments_duration_ms_check`;
    - `attachments_page_count_check`;
    - `P0002` do `ai_transcription_retry` (404).
  - internos (não deveriam chegar ao usuário):
    - `22023` do claim;
    - `ai_attachment_derivatives_lock_check`, `_result_check`, `_content_check`, `_model_check` e `_provider_check`;
    - `23503` do enqueue.
- **TTS (`speech`)**: nada de fila. Insira o derivado (com `message_id`/`block_index`/`voice`, `ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key`) já `done` com o `result_attachment_id`. Se alguém marcar uma linha como `running` à mão, ela precisa de `locked_at` e `lock_token`.
- **Backup**: os derivados continuam fora; `duration_ms`/`page_count` entram com o anexo pelo catálogo genérico (arquivos antigos vêm sem eles, nulos).

**Para a spec 025 (fora da pasta do dba)**: registrar em "Banco":
- `conversation_id` no derivado, para a atribuição do uso;
- as funções da fila, com o prazo de 10 min e as 3 tentativas;
- a falha definitiva (as novas tentativas de HTTP ficam no adaptador, spec 023);
- o "tentar de novo", que zera as tentativas;
- o MIME exigido para a duração e as páginas.
