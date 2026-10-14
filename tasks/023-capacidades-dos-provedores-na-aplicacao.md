---
status: aberta
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-14
commit:
---

# Capacidades, Anthropic compatível, provedor por inferência e visão por descrição (F10)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [024](../docs/024-capacidades-dos-provedores.md), seção "Aplicação (app)". O que fazer: Flags e modelos padrão no modal do provedor (padrão por tipo, teste por flag), interruptores de cache/raciocínio no Anthropic compatível, bloco "Inferências" no agente (provedor padrão preenche), `resolveInference`, visão direta/descrição/camada de texto do PDF, `transcribe`/`speak`/`embed`, indexação por par em uso e busca pelo par do agente; testes.

Ordem: Depois da 022. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [024](../docs/024-capacidades-dos-provedores.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **Adaptadores**:
  - `agents/llm/anthropic.ts`: `cache_control` (l. 136–138) e `thinking` passam a depender dos interruptores do provedor;
  - `agents/llm/openai.ts`: `transcribe`, `speak` e `embedTexts` com `dimensions: 1536`.
- **`agents/inferences.ts`**, novo: `resolveInference`.
- **`runner.ts`**: `loadAttachment` (l. ~272) hoje manda o arquivo cru ao modelo. Entram o pré-processamento (visão direta, descrição ou camada de texto) e a gravação dos derivados em transação curta.
- **Embeddings**: `agents/embeddings.ts`, `agents/search.ts` e `agents/worker.ts` indexam por par e buscam pelo par do agente.
- **`services/ai-admin.ts`**:
  - provedor: flags, modelos padrão e o teste por flag;
  - agente: o bloco de inferências;
  - recusa de desmarcar flag em uso.
- **`services/conversations.ts`**: `uploadMessageAttachment` recusa imagem sem visão (422).
- **Fluxos**: `services/ai-flows.ts` e `agents/flows.ts` passam a usar a visão do agente.
- **Shared**: `agents/schemas.ts` e `agents/types.ts`.
- **Web**: `components/admin-ai/ProvidersTab.tsx` e `AgentsTab.tsx`, mais o progresso do índice no detalhe do provedor (021).
- **Backup**: `catalog.ts`.
- **Banco**: `pnpm db:pull` depois da 022.

**Dependência nova**
- A camada de texto do PDF é extraída no servidor. Hoje o `pdfjs-dist` existe só em `apps/web`. Ele entraria no bundle da API e do worker (`dist/main.mjs`), então é preciso conferir o build e a imagem.
- O provedor falso (`e2e/fakes/fake-llm.ts`) precisa de `/v1/audio/transcriptions`, `/v1/audio/speech` e `dimensions` nos embeddings.

**Riscos e observações**
- As funções de embeddings trocam de assinatura (022): esta tarefa vai na mesma branch.
- A descrição fica em cache por anexo e modelo, para não ser chamada de novo.
- A assinatura do raciocínio só volta ao mesmo provedor e modelo (011).

**Dependências**
- Depende da 022 e usa o invólucro da 021.
- A 025 depende desta.

**Como verificar**
- Os testes da 024: flags por tipo, provedor padrão, flag em uso, imagem direta/descrita/recusada, PDF pela camada de texto, dois índices e o cache desligado.
- O e2e do provedor com todas as flags.

**Pontos para a revisão da spec**
1. (024, Anthropic compatível) "Testar conexão faz uma chamada mínima ao modelo informado", mas o provedor não tem um modelo de texto definido hoje. Recomendação: usar o modelo padrão de `text` em `default_models`, obrigatório no Anthropic compatível.
2. Os pontos de banco da 022 (derivados e os 7 dias) também afetam esta tarefa.

## Resolução (executor)
