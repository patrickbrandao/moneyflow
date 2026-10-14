---
status: concluida
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
Feito pelo dba em 2026-10-14 (sem commit ainda; a sessão principal commita).

**Migration `database/migrations/0041_ai_provider_capabilities.sql`**
- **`ai_providers`**:
  - `capabilities text[] NOT NULL`: subconjunto de `text|vision|embeddings|transcription|speech`, sem repetição, gravado em ordem canônica (`ai_providers_capabilities_check`). Omitido no INSERT = padrão do tipo (anthropic = text + vision; openai = todas). `anthropic` ⊆ {text, vision} (`ai_providers_capabilities_kind_check`).
  - `default_models jsonb NOT NULL DEFAULT '{}'`: chaves `text`, `vision`, `embeddings`, `transcription`, `speech` (formato de modelo) e `speech_voice` (só com `speech`), cada uma só com a flag ligada (`ai_providers_default_models_check`). Desmarcar uma flag exige tirar o modelo dela no mesmo UPDATE.
  - `prompt_cache_enabled` e `thinking_enabled` (`NOT NULL`): omitidos no INSERT = `base_url IS NULL`.
  - **Modelo de texto obrigatório** só no Anthropic compatível (`anthropic` + `base_url` + flag `text`), como na spec, que põe a regra sob "Anthropic compatível" (`ai_providers_text_model_check`). É conferido só quando tipo, `base_url`, flags ou modelos mudam. Assim, um provedor antigo sem modelo ainda pode ser desativado ou arquivado.
  - Saíram `embedding_model`, o CHECK dele e o índice `ai_providers_embedding_key`. As quatro colunas novas têm `GRANT SELECT` explícito.
  - O trigger `ai_providers_validate` aplica os padrões, a ordem, a regra do modelo de texto e a da flag em uso.
- **`ai_agent_inferences`** (PK `agent_id`, `capability`; `capability` `vision|embeddings|transcription|speech`; `model` nulo = padrão; `voice` só em `speech`):
  - CASCADE com o agente; FK do provedor sem `ON DELETE` (`23503`);
  - auditada com `record_id = agent_id`.
  - Triggers, todos `23514`:
    - provedor sem a flag: `ai_agent_inferences_provider_capability_check`;
    - provedor de texto do agente sem `text`: `ai_agents_provider_text_check` (ponto 3);
    - tirar uma flag em uso, arquivado inclusive (ponto 5): `ai_providers_capability_in_use_check`, com os nomes dos agentes no `DETAIL`.
  - Os dois lados leem o provedor com `FOR SHARE`, contra corrida.
- **`ai_attachment_derivatives`**, definida inteira (ponto 1):
  - origem: exatamente uma entre `attachment_id` e `message_id` + `block_index` (0–9999), e o `speech` se e somente se a origem é a mensagem;
  - `kind` `description|pdf_text|transcription|speech`; `provider_id`/`model` nulos só e sempre em `pdf_text` (extraído no servidor); `voice` só em `speech`; `content` até 5 milhões de caracteres;
  - `result_attachment_id` só em `speech`; `done` exige `content`, ou o resultado no `speech`;
  - fila: `status` `pending|running|done|failed` (`failed` com `error`), `attempts` 0–100, `locked_at` se e somente se `running`;
  - único `NULLS NOT DISTINCT` (`ai_attachment_derivatives_key`); origem, tipo, provedor, modelo e voz imutáveis (`ai_attachment_derivatives_immutable_check`);
  - CASCADE da mensagem, do anexo, do provedor e do resultado;
  - o áudio gerado entra em `attachment_links` como `ai_message_speech` (alvo = a mensagem). Trocado ou com o derivado excluído, inclusive ao excluir a conversa, **o banco apaga o anexo** se ele não tem outro vínculo.
  - Índice parcial da fila. Fora da auditoria.
- **Embeddings por par** (ponto 2):
  - `ai_embedding_indexes` (PK `provider_id`, `model`; `last_in_use_at`; CASCADE com o provedor);
  - `ai_embeddings.provider_id NOT NULL`, com a FK composta para o par (`ai_embeddings_index_fkey`, CASCADE). O único passou a (`object_type`, `object_id`, `provider_id`, `model`) e a fila de reindexação, a (`provider_id`, `model`, `updated_at`);
  - visão `ai_embedding_pairs_in_use` (agentes ativos e não arquivados, provedor ativo e com a flag, modelo nulo = padrão);
  - `ai_embedding_indexes_touch()` registra os pares em uso e os devolve;
  - `ai_embedding_indexes_purge(prazo = 7 dias)` apaga os pares parados fora de uso com os vetores e devolve quantos vetores saíram (`22023` com prazo < 1 h);
  - visão `ai_embedding_index_stats` (progresso por par).
  - `ai_embeddings_search(vetor, provedor, modelo, caixas, tipos, limite)`:
    - roda com `SET hnsw.iterative_scan = relaxed_order` (pgvector 0.8.7 na imagem);
    - reordena por `dist + 0`. Sem o `+ 0`, o PostgreSQL 17+ reaproveita a ordem da CTE e devolvia fora de ordem; o teste pegou.
  - Testei o `pg_dump -Fc` seguido do `pg_restore --single-transaction` com o `SET` da função: restaura.
- **Credenciais**:
  - `ai_capability_credentials(agente, capacidade, ator)` (ponto 4: também dentro da execução). Aceita `text` (provedor e modelo do agente) e devolve o modelo resolvido, que pode ser nulo se nem a inferência nem o provedor o têm, e a voz só no `speech`.
    - `22023`: capacidade desconhecida.
    - `42501`: ator não é usuário ativo; agente inativo ou arquivado; provedor inativo, arquivado ou sem a flag.
    - `P0002`: agente inexistente ou sem provedor para a capacidade.
  - `ai_embedding_credentials(provedor)` devolve `default_model`. `42501` com o provedor inativo, arquivado ou sem a flag; `P0002` se não existe.
  - `ai_run_provider_credentials` também exige a flag `text` (`42501`).
- **Uso e preços**:
  - `ai_usage`: `audio_seconds numeric(12,3)` e `characters bigint`, os dois ≥ 0 (`ai_usage_audio_check`);
  - `ai_model_prices`: `audio_input_per_minute` e `speech_per_million_chars`, opcionais, ≥ 0 (`ai_model_prices_audio_values_check`);
  - custo = tokens + segundos ÷ 60 × preço do minuto + caracteres × preço por milhão (preço nulo conta zero);
  - `vision_describe|transcription|speech` em `ai_usage.purpose` e em `ai_requests.purpose`. O `ai_conversations.purpose` não muda: as finalidades novas não são de conversa.
- **Migração dos dados**:
  - flags pelo tipo; `embedding_model` → `default_models.embeddings`;
  - Anthropic compatível ganha o `text` do modelo de um agente dele (senão do último uso, senão da tabela de preços);
  - cache e raciocínio ficam ligados só sem `base_url`;
  - vetores: com o provedor cujo `embedding_model` é o modelo deles (o ativo primeiro, mesmo inativo); sem provedor, apagados. Os pares entram em `ai_embedding_indexes`.
  - **Decisão a confirmar**: para nada mudar de comportamento, cada agente com provedor ganhou a inferência `vision` no próprio provedor de texto, e o anexo continua indo direto ao modelo. Todo agente ganhou a `embeddings` no provedor de embeddings ativo de antes, quando havia; sem isso, os vetores migrados seriam purgados em 7 dias. Recomendo registrar na spec 024.
- Down: desfaz tudo.
  - As finalidades novas voltam a `chat`.
  - O `embedding_model` volta a um provedor ativo só: o que mais agentes usam.
  - Os vetores duplicados por par ficam no provedor que manteve o `embedding_model`.
  - Os áudios gerados saem.
  - Testado com dados num banco de rascunho (up, down, up) e no dev com o seed.

**Testes**
- `database/tests/0041_ai_provider_capabilities.sql` (217 testes):
  - estrutura, `ON DELETE` das FKs, privilégios e o `proconfig` da busca;
  - padrões por tipo e `base_url`, ordem canônica, cada CHECK, o Anthropic compatível (inclusive o legado sem modelo);
  - `anthropic` com `embeddings` recusado;
  - inferências: flag exigida, flag em uso com `DETAIL` (arquivado conta), texto exige `text`, auditoria com `record_id = agent_id`;
  - credenciais:
    - resolução de modelo e voz;
    - `22023`/`42501`/`P0002`;
    - inativo e sem a flag;
    - a execução com provedor sem `text`;
  - derivados: origem, unicidade `NULLS NOT DISTINCT`, cada CHECK, a fila, imutabilidade, `attachment_links`, áudio trocado, áudio com outro vínculo, exclusão da conversa e do anexo;
  - pares:
    - em uso, `touch`, FK, progresso e purga (par em uso nunca sai);
    - a busca filtra pelo par (dois provedores, mesmo modelo);
    - com o HNSW forçado, a busca sem varredura iterativa perde o par raro e a função acha os 5, em ordem. Vetores gêmeos deixam o teste estável: 80 de 80 execuções;
  - custo de áudio (por minuto, por caractere, por token) e as finalidades novas;
  - o fluxo como `moneyflow_app`.
- Ajustados os testes de áreas antigas que usavam o que saiu:
  - `0024` (`embedding_model`, `ai_embedding_credentials(uuid)`, vários provedores com embeddings);
  - `0027`;
  - `0029` (par registrado e a busca com o provedor);
  - `0015` (os dois caches fora da auditoria).
- `make test`: PASS (37 arquivos, 2629 testes). `make dump` rodado. O seed carrega.

**Para a 023 (app)**
- `pnpm db:pull`.
  - Colunas novas: `ai_providers.capabilities/default_models/prompt_cache_enabled/thinking_enabled`, `ai_usage.audio_seconds/characters`, `ai_model_prices.audio_input_per_minute/speech_per_million_chars` e `ai_embeddings.provider_id`.
  - Tabelas novas: `ai_agent_inferences`, `ai_attachment_derivatives` e `ai_embedding_indexes`; visões `ai_embedding_pairs_in_use` e `ai_embedding_index_stats`.
  - **Saiu `ai_providers.embedding_model`**: tirar de `PROVIDER_COLUMNS`, INSERT/UPDATE e tipos e schemas do shared (`embeddingModel`).
- Assinaturas novas:
  - `ai_embedding_credentials()` → `ai_embedding_credentials(provedor)`: devolve `default_model`, não mais `embedding_model`, e dá erro em vez de 0 linhas;
  - `ai_embeddings_search(vetor, modelo, …)` → `ai_embeddings_search(vetor, provedor, modelo, caixas, tipos, limite)`;
  - novas: `ai_capability_credentials(agente, capacidade, ator)`, `ai_embedding_indexes_touch()` e `ai_embedding_indexes_purge(intervalo)`;
  - `ai_run_provider_credentials` tem a mesma assinatura (agora `42501` sem `text`).
- **Embeddings**: o INSERT em `ai_embeddings` leva `provider_id`, e o par precisa estar registrado. Chame `ai_embedding_indexes_touch()` no início de cada ciclo, antes de gravar; senão, `23503 ai_embeddings_index_fkey`. O `ON CONFLICT` passa a (`object_type`, `object_id`, `provider_id`, `model`). A purga entra no laço de manutenção.
- **Provedores**:
  - para usar os padrões do banco, omita `capabilities`, `prompt_cache_enabled` e `thinking_enabled` no INSERT;
  - Anthropic com `base_url` precisa de `default_models.text`, inclusive nos testes de integração e e2e que cadastram o provedor falso como Anthropic;
  - ao desmarcar uma flag, tire o modelo dela no mesmo UPDATE.
- Erros a traduzir:
  - `ai_providers_capabilities_check`;
  - `ai_providers_capabilities_kind_check`;
  - `ai_providers_default_models_check`;
  - `ai_providers_text_model_check`;
  - `ai_providers_capability_in_use_check` (`DETAIL` = nomes dos agentes, separados por vírgula);
  - `ai_agents_provider_text_check`;
  - `ai_agent_inferences_provider_capability_check`;
  - `ai_agent_inferences_capability_check`, `_model_check`, `_voice_check`;
  - `ai_agent_inferences_pkey` (23505);
  - `ai_agent_inferences_provider_id_fkey` (23503, provedor em uso);
  - `ai_model_prices_audio_values_check`.
- Remover as traduções `ai_providers_embedding_key` e `ai_providers_embedding_model_check`.
- Erros internos, que não deveriam chegar ao usuário: `ai_attachment_derivatives_*`, `ai_embeddings_index_fkey`, `ai_usage_audio_check`.
- **Backup** (`catalog.ts`):
  - `ai_agent_inferences` em `COMPOSITE_KEYS` (`['agent_id', 'capability']`, `capability` texto) e `OWNED_BY` (`['agent_id']`); depende de provedores e agentes;
  - `ai_attachment_derivatives` e `ai_embedding_indexes` em `EXCLUDED_TABLES`.
  - Arquivos antigos:
    - `ai_providers.embedding_model` vira `default_models.embeddings` e sai da linha;
    - a linha sem `capabilities`/`prompt_cache_enabled`/`thinking_enabled` vai sem a coluna (o banco preenche);
    - o Anthropic com `base_url` sem `text` precisa de um modelo (o de um agente do arquivo), senão volta como conflito;
    - recomendo repetir a regra da migração para os agentes de arquivo antigo.
  - Um anexo cujo único vínculo é `ai_message_speech` não deveria ir no backup sem o derivado.
- **Exclusão da conversa** (`conversations.ts`): o banco já apaga o áudio gerado. `attachment_links` ganhou o ramo `ai_message_speech`.

**Para a spec 024 (fora da pasta do dba)**
- Registrar:
  - a migração das inferências (decisão a confirmar acima);
  - a regra do modelo de texto restrita ao Anthropic compatível, com o legado conferido só na edição;
  - `default_models` só com chaves de flag ligada;
  - `pdf_text` sem provedor;
  - o `block_index` como trecho da mensagem definido pela aplicação;
  - o banco apagando o áudio gerado;
  - os auxiliares `ai_embedding_pairs_in_use`/`touch`/`purge`/`ai_embedding_index_stats`;
  - `ai_capability_credentials` aceitando `text`.
- A 024 (tarefa) fica com `attachments.duration_ms/page_count` e o claim da fila. As colunas da fila e o ramo de `attachment_links` já estão aqui.
