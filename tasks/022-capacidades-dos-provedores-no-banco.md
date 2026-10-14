---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-14
commit:
---

# Capacidades, inferências por agente, derivados de anexo e embeddings por modelo no banco (F10)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [024](../docs/024-capacidades-dos-provedores.md), seção "Banco (dba)". O que fazer: `ai_providers.capabilities`/`default_models`/`prompt_cache_enabled`/`thinking_enabled` (sai `embedding_model` e a regra de um provedor de embeddings), `ai_agent_inferences` com trigger de flag, `ai_attachment_derivatives`, chave de `ai_embeddings` com `provider_id`, `ai_capability_credentials` e `ai_embedding_credentials(provedor)`, finalidades `vision_describe|transcription|speech`, `audio_seconds`/`characters` e os preços de áudio.

Ordem: Depois da F9; depois vem a 023. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [024](../docs/024-capacidades-dos-provedores.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, `schema.sql` e o pgTAP das áreas `0024`, `0027` e `0029`.
- Estado atual em `schema.sql`:
  - `ai_providers.embedding_model`, com CHECK `kind = 'openai'` (l. 5791) e o índice único `ai_providers_embedding_key` (l. 10411);
  - `ai_embedding_credentials()`, sem parâmetro (l. 436);
  - `ai_embeddings` com único em (`object_type`, `object_id`, `model`) (l. 9464) e sem `provider_id`;
  - `ai_embeddings_search(p_query, p_model, …)` (l. 517) e um HNSW único em `embedding` (l. 10355);
  - o CHECK de `ai_usage.purpose` (l. 5616);
  - `ai_run_provider_credentials(run)` só devolve o provedor de texto da execução.

**Riscos e observações**
- **Segredo em `ai_providers`**: as colunas novas (`capabilities`, `default_models`, `prompt_cache_enabled`, `thinking_enabled`) precisam de `GRANT SELECT` explícito.
- **Assinaturas que mudam**: `ai_embedding_credentials` e `ai_embeddings_search` mudam de assinatura. A aplicação (`agents/embeddings.ts`, `agents/search.ts`) quebra até a 023, então as duas tarefas precisam ir na mesma branch.
- **Busca com vários pares (provedor, modelo) no mesmo HNSW**: o filtro aplicado depois do índice derruba a revocação, e o `moneyflow_app` não tem DDL para criar índices parciais por par. Recomendação: `SET LOCAL hnsw.iterative_scan = relaxed_order` dentro de `ai_embeddings_search`. Exige pgvector 0.8 ou mais; a imagem `pgvector/pgvector:pg18` atende.
- **Migração dos vetores**: atribuir o provedor cujo `embedding_model` é o modelo do vetor, mesmo inativo. Sem provedor, apagar o vetor.
- **Visão por descrição**: roda dentro da execução reservada, com outro provedor. `ai_capability_credentials` também é usada durante a execução, com o usuário da execução como ator.
- **Backup** (código da aplicação, na 023):
  - `ai_agent_inferences` tem chave composta e precisa de `COMPOSITE_KEYS`;
  - `ai_attachment_derivatives` vai para `EXCLUDED_TABLES`.

**Dependências**
- Depois da F9: as finalidades novas também valem em `ai_requests`.
- A 023 depende desta. A 024 completa os derivados.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - `anthropic` com `embeddings` é recusado;
  - o trigger exige a flag e impede tirá-la com vínculo (23514);
  - as credenciais dão 42501 com provedor inativo ou sem a flag;
  - a busca filtra pelo par;
  - a migração dos vetores.

**Pontos para a revisão da spec**
1. (024, Banco) `ai_attachment_derivatives` está incompleta.
   - É única por (…, `voice`), mas `voice` não está na lista de colunas.
   - No `speech`, a origem é uma mensagem (025), não um anexo, e `attachment_id` não pode ser obrigatório.
   - Recomendação: definir a tabela já aqui com:
     - `voice`;
     - `attachment_id` nulo, mais `message_id`/`block_index` para o `speech`, com um CHECK de exatamente uma origem;
     - o único com `NULLS NOT DISTINCT`;
     - as colunas de fila (`attempts`, `locked_at`) que a 025 usa.
2. (024, Embeddings) "Apagados depois de 7 dias sem uso" não tem onde guardar desde quando o par está sem uso. Recomendação: a tabela `ai_embedding_indexes(provider_id, model, last_in_use_at)`, mantida pelo worker. Ela também serve ao "progresso do índice".
3. (024, Banco) O trigger de flag só cobre `ai_agent_inferences`, mas o provedor de texto do agente (`ai_agents.provider_id`) também deveria exigir `text`. Recomendação: estender.
4. (024, Credenciais) "`ai_capability_credentials` fora de execução reservada" também vale dentro da execução (visão no runner). Recomendação: ajustar o texto.
5. (024, Desmarcar flag em uso) Não diz se agentes arquivados contam. Recomendação: contam, porque o vínculo existe.

## Resolução (executor)
