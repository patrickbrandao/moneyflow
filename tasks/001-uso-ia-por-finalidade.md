---
status: concluida
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: media
criada: 2026-10-11
commit:
---

# Separar o uso de IA da leitura de documento e da classificação

## Descrição
`ai_usage.purpose` só aceita `chat|title|embedding`. A leitura de documento (`/api/title-entry/document`) e as sugestões da conciliação rodam como execuções de agente e são registradas como `chat`, então o painel de uso não separa esses custos. Pedido: aceitar `document` e `classification` em `ai_usage.purpose`. Depois, o `app` passa a gravar a finalidade certa.

## Como reproduzir
Usar a leitura de documento com um agente ativo e ver em `ai_usage` a linha com `purpose = 'chat'`.

## Análise (triagem)
**Procede** (conferido em 2026-10-13 na branch `feat/conciliacao-agente-e-series`, com contratos e as tarefas 008–010).

- `database/migrations/0027_ai_usage.sql`: `ai_usage_purpose_check` ainda é `purpose IN ('chat','title','embedding')`, e nenhuma migration posterior (até a 0032) mexe nisso.
- `apps/server/src/agents/runner.ts` (INSERT em `ai_usage` dentro do loop) grava `'chat'` fixo para toda chamada, inclusive nas execuções dos fluxos. O escopo cresceu desde a abertura: além de `document_reading` (`services/ai-flows.ts`) e `classify_lines`, os contratos (spec 020) acrescentaram `contract_reading` e `contract_markdown` (`services/contract-documents.ts`), todos em `agents/flows.ts` (`FLOW_PURPOSES`). Hoje os quatro saem como `chat`.
- O painel de uso (`services/ai-admin.ts` → `usageReport`, tela `apps/web/src/components/admin-ai/UsageTab.tsx`) lê `ai_usage_monthly_by_user` e `ai_usage_monthly_by_agent`, que não agrupam por `purpose`: mesmo com o CHECK ampliado, o painel continua sem separar. Então a parte do banco inclui um agregado por finalidade.

**Parte do banco (esta tarefa, dba):**
1. Ampliar `ai_usage_purpose_check` com as finalidades dos fluxos. Recomendação: usar os mesmos nomes do código e da tarefa 003 — `document_reading`, `classify_lines`, `contract_reading`, `contract_markdown` — em vez de `document`/`classification` (pedido original, anterior aos contratos), para não haver tabela de tradução entre `ai_conversations.purpose` e `ai_usage.purpose`.
2. Um agregado por finalidade sem mudar as linhas das views atuais: view `ai_usage_monthly_by_purpose` (mês SP, `purpose`, moeda, chamadas, execuções, tokens, custo, `has_unpriced`), `security_invoker` como as outras.
3. Opcional, recomendado se a 003 sair junto: no `ai_usage_before_insert`, quando `NEW.purpose = 'chat'` e a conversa da execução tiver finalidade de fluxo, assumir a finalidade da conversa (fica certo mesmo que a aplicação esqueça).
4. Atualizar o `COMMENT ON COLUMN ai_usage.purpose`, o pgTAP da área (0027) e a spec 016.

Fazer na mesma migration da 003 (mesmo vocabulário). Depois: **tarefa 011** (app) grava a finalidade certa e mostra o recorte no painel.

Risco: baixo (só amplia um CHECK e cria uma view). Verificação: `make -C database test`; inserir `ai_usage` com `purpose = 'document_reading'` passa e com um valor fora da lista falha (23514); a view soma por finalidade.

Ordem: 001 + 003 (dba, uma migration) → 013 → 011 (app). Esforço: pequeno (~1 h com o pgTAP).

## Resolução (executor)
Feito em 2026-10-13 (dba), na migration `database/migrations/0033_ai_purpose.sql` (junto com a 003).

- `ai_usage_purpose_check` ampliado: `chat`, `title`, `embedding`, `document_reading`, `classify_lines`, `contract_reading`, `contract_markdown` (nomes do código, `FLOW_PURPOSES`; os do pedido original, `document`/`classification`, não foram usados). Valor fora da lista: `23514 ai_usage_purpose_check`.
- `ai_usage_before_insert`: quando chega `purpose = 'chat'` e a conversa (a informada ou a da execução) tem finalidade de fluxo, a linha assume a finalidade da conversa. `title` e as finalidades explícitas ficam como vieram.
- View `ai_usage_monthly_by_purpose` (`security_invoker`): `month` (America/Sao_Paulo), `purpose`, `currency`, `calls`, `runs`, `users`, `input_tokens`, `output_tokens`, `cache_write_tokens`, `cache_read_tokens`, `cost_micros`, `has_unpriced`. `moneyflow_app` tem SELECT (GRANT explícito, além do default privilege).
- `COMMENT ON` da coluna, da função e da view; spec 016 atualizada; pgTAP em `database/tests/0027_ai_usage.sql`; `schema.sql` e `packages/db/src/generated` regenerados.
- O down devolve as linhas das finalidades novas para `chat` antes de restaurar o CHECK antigo.

Verificação: `make -C database test` verde (32 arquivos, 1912 testes). Próximo: tarefa 011 (app).
