# 024 — Capacidades dos provedores e provedor por inferência (F10)

Os provedores declaram o que sabem fazer. O agente escolhe um provedor (e um modelo) para cada tipo de inferência. O tipo `anthropic` passa a cobrir formalmente as APIs compatíveis com a Messages API. Decisões da entrevista de 2026-10-13.

## Tipos de provedor
- **Dois tipos**, como hoje:
  - **`anthropic`**: Messages API. O `base_url` vazio é a API oficial; preenchido, é um servidor compatível com a Messages API (OpenRouter, MiniMax, Z.ai, proxies).
  - **`openai`**: Chat Completions e os endpoints de embeddings e áudio. O `base_url` vazio é a OpenAI oficial; num compatível, a URL termina em `/v1`.
- **Anthropic compatível**:
  - O provedor com `base_url` exige um **modelo de texto padrão** (o modelo da chamada mínima do teste e a sugestão no agente). O "testar conexão" faz uma chamada mínima a esse modelo. Se `models.list` não existir, a tela mostra "listagem indisponível: digite o modelo", sem erro.
  - O provedor tem dois interruptores de recursos da Messages API: **cache de prompt** e **raciocínio** (thinking). Ficam ligados por padrão na API oficial e desligados quando há `base_url`. Desligados, o adaptador não manda `cache_control` nem `thinking`, mesmo que o agente peça.
  - As regras de [011](011-agentes-de-ia.md) (assinatura do raciocínio só para o mesmo provedor e modelo) continuam.

## Capacidades (flags do provedor)
- **Flags**:
  - `text`: texto→texto (chat, título, fluxos);
  - `vision`: aceita imagens e PDF;
  - `embeddings`;
  - `transcription`: áudio→texto;
  - `speech`: texto→áudio.
- **Quem marca**: o admin. As flags vêm pré-marcadas pelo tipo: `anthropic` = `text` + `vision`; `openai` = todas. O tipo `anthropic` só aceita `text` e `vision`, porque a API não tem embeddings nem áudio.
- **Modelo padrão**: cada flag ligada tem o seu, e o TTS também a voz padrão. Sugestões na tela:
  - `vision`: o mesmo modelo de texto;
  - `embeddings`: `text-embedding-3-small`;
  - `transcription`: `gpt-4o-transcribe`;
  - `speech`: `gpt-4o-mini-tts`, voz `alloy`.
- O campo `embedding_model` de hoje vira o modelo padrão de `embeddings`, e a regra "no máximo um provedor ativo com embeddings" deixa de existir.
- **Testar conexão**: avisa, flag a flag, se um recurso marcado falha (uma chamada mínima por flag, gravada em Requisições, [023](023-requisicoes-ao-provedor.md)). O embedding precisa voltar com 1536 dimensões: nos `text-embedding-3-*` o MoneyFlow manda `dimensions: 1536`; num modelo que devolve outra dimensão, o teste falha com "o modelo precisa produzir 1536 dimensões".
- **Desmarcar uma flag em uso** por algum agente é recusado, com a lista dos agentes. Isso vale também para `text`: o provedor de texto do agente precisa ter a flag `text`.

## Provedor por inferência no agente
- O formulário do agente começa pelo **Provedor padrão**. Ao escolhê-lo, ele preenche:
  - o provedor de **texto**;
  - os de **visão**, **embeddings**, **áudio→texto** e **texto→áudio**, quando ele tem a capacidade.
- Cada campo pode ser trocado depois. A lista de cada campo só traz os provedores ativos com aquela flag, e "Nenhum" vale para todos menos o texto.
- **Modelo**: cada inferência herda o modelo padrão do provedor escolhido (nulo = herdar), e o admin pode trocá-lo. O texto continua com o modelo do agente (obrigatório para ficar ativo). O TTS também tem a voz.
- A lista de agentes mostra ícones das capacidades configuradas.
- O agente dos fluxos usa a mesma configuração (a leitura de documento e a de contrato usam a visão).

## Como cada inferência é usada
- **Imagem e PDF** (a regra também vale para os fluxos):
  - Se o provedor de visão do agente é o mesmo do texto e tem `vision`, o anexo vai direto ao modelo de texto, como hoje.
  - Senão, o provedor de visão **descreve/extrai** o anexo, uma vez por anexo e modelo. O resultado fica guardado como derivado do anexo, e o texto vai ao modelo de texto como `[Imagem "nome" — descrição]: …`.
  - Sem provedor de visão:
    - o PDF vai pela **camada de texto** (extraída no servidor com pdf.js); um PDF escaneado sem texto vira o aviso "PDF sem texto e o agente não tem visão";
    - a imagem é **recusada ao anexar** (422 "Este agente não lê imagens").
- **Embeddings**: veja abaixo.
- **Áudio→texto e texto→áudio**: [025](025-chat-multimidia.md).

## Índice de embeddings por modelo em uso
- O worker indexa, para **cada par distinto (provedor, modelo)** de embeddings usado por algum agente ativo, as entidades, os títulos, as compras de cartão e as linhas de extrato. O custo da indexação cresce com cada par novo, o que é aceito.
- A dimensão continua fixa em 1536.
- A busca (`semantic_search`, `search_records`) usa o par do agente que a chamou.
  - Enquanto o índice do par não está completo, a busca usa o que já existe e completa com trigramas, avisando "índice em construção".
  - Agente sem embeddings: só trigramas, como hoje.
- Os vetores de um par que nenhum agente ativo usa mais são apagados depois de 7 dias. O par em uso fica registrado em `ai_embedding_indexes` (abaixo), com a última vez em que esteve em uso.
- Vários modelos dividem o mesmo índice HNSW; a busca filtra por provedor e modelo com `hnsw.iterative_scan` ligado, para não perder resultados no filtro.
- O detalhe do provedor mostra o progresso do índice por modelo (indexados / total).

## Uso e preços
- Novas finalidades em `ai_usage.purpose`: `vision_describe`, `transcription` e `speech`.
- O uso de áudio também registra `audio_seconds` (transcrição) e `characters` (TTS).
- Os preços (`ai_model_prices`) ganham `audio_input_per_minute` e `speech_per_million_chars`, opcionais, para os modelos cobrados assim. Os cobrados por token usam os preços de entrada e saída de sempre.

## Banco (dba)
- **`ai_providers`**:
  - `capabilities text[]`: subconjunto de {`text`,`vision`,`embeddings`,`transcription`,`speech`}, com padrão pelo tipo e `anthropic` ⊆ {`text`,`vision`};
  - `default_models jsonb`: um modelo por capacidade, mais `speech_voice`. Absorve o `embedding_model`, que sai;
  - `prompt_cache_enabled` e `thinking_enabled`, booleanos com padrão pelo `base_url` (decidido na aplicação ao criar);
  - sai o índice/regra de um provedor de embeddings só.
- **`ai_agent_inferences`**:
  - colunas: `agent_id`, `capability` (`vision|embeddings|transcription|speech`), `provider_id`, `model` (nulo = padrão do provedor) e `voice`. A chave primária é (`agent_id`, `capability`);
  - um trigger exige que o provedor tenha a flag, e a flag não sai do provedor enquanto houver vínculo (`23514`);
  - o texto continua em `ai_agents.provider_id/model`.
- **`ai_attachment_derivatives`** (definida inteira aqui; a [025](025-chat-multimidia.md) só a usa):
  - origem: **exatamente uma** entre `attachment_id` (descrição, texto do PDF, transcrição) e `message_id` + `block_index` (o áudio gerado de uma mensagem, `speech`), por CHECK;
  - `kind` (`description|pdf_text|transcription|speech`), `provider_id`, `model`, `voice` (só no `speech`), `content` (texto), `result_attachment_id` (o áudio gerado, no `speech`), `status` (`pending|running|done|failed`), `error`, `attempts`, `locked_at` (fila da transcrição), `created_at`/`updated_at`;
  - único por (`attachment_id`, `message_id`, `block_index`, `kind`, `provider_id`, `model`, `voice`) com `NULLS NOT DISTINCT`;
  - excluir a mensagem ou o anexo leva o derivado; o áudio gerado entra em `attachment_links` para não virar órfão.
- **`ai_embedding_indexes`**: (`provider_id`, `model`) como chave, `last_in_use_at`; o worker atualiza a cada ciclo para os pares em uso e purga os vetores dos pares parados há mais de 7 dias.
- **`ai_embeddings`**: a chave única passa a (`object_type`, `object_id`, `provider_id`, `model`), e `ai_embeddings_search` recebe o provedor. Os vetores existentes migram com o provedor de embeddings de hoje.
- **Credenciais fora de uma execução reservada** (transcrição no upload, TTS, indexação):
  - `ai_capability_credentials(agente, capacidade, ator)` (`SECURITY DEFINER`): exige ator ativo, agente ativo e provedor ativo com a flag; usada também durante a execução (visão por descrição);
  - `ai_embedding_credentials(provedor)` passa a receber o provedor.
  - Nenhuma devolve chave para provedor inativo ou sem a flag (`42501`).
- **Uso e preços**: as finalidades novas, `audio_seconds`/`characters` em `ai_usage` e as duas colunas de preço.
- **Backup**: a tabela de inferências entra como filha do agente; os derivados ficam fora (são cache).

## Aplicação (app)
- **Adaptadores**: em `openai.ts`, `transcribe()`, `speak()` e `embed()` com `dimensions`; em `anthropic.ts`, os interruptores de cache e raciocínio. Toda chamada passa pelo registro de requisições ([023](023-requisicoes-ao-provedor.md)).
- **Resolução**: `resolveInference(agent, capability)` devolve provedor, modelo e voz já com os padrões, em `agents/inferences.ts`.
- **Visão**: o pré-processamento dos anexos fica no runner, antes da chamada, e grava os derivados em transação curta.
- **Worker**: a indexação de embeddings roda por par em uso.
- **Telas**: as flags e os modelos padrão no modal do provedor; o bloco "Inferências" no formulário do agente.

## Testes
- **Integração** (provedor falso):
  - flags padrão por tipo, e `anthropic` com `embeddings` recusado;
  - o provedor padrão preenche as inferências que ele suporta;
  - desmarcar uma flag em uso é recusado;
  - imagem com visão no texto vai direto; com visão em outro provedor vira descrição (uma vez só); sem visão, recusada;
  - PDF sem visão vai pela camada de texto;
  - dois agentes com modelos de embeddings diferentes geram dois índices, e a busca usa o do agente;
  - Anthropic compatível com cache desligado não manda `cache_control`.
- **e2e**: cadastrar um provedor OpenAI-compatível falso com todas as flags e criar um agente que herda tudo.
