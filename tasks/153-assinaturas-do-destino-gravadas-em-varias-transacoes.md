---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# set_message_subscriptions grava cada assinatura numa transação: falha no meio deixa metade aplicada

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** transação mal delimitada
- **Arquivos afetados:** `apps/server/src/agents/tool-handlers-admin.ts:455-481`, `apps/server/src/services/messages.ts:312-341`, `packages/shared/src/agents/tools-admin.ts:188-199`
- **Depende de / relacionado a:** tarefa 099 (o "Tente de novo" depois de uma gravação parcial)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O agente pode mudar várias assinaturas de um destino do Telegram de uma vez, e o cartão mostra o conjunto. Se uma delas falhar, as anteriores já ficaram gravadas e as seguintes não: o destino fica num meio-termo que ninguém aprovou.

### Evidência e análise técnica
- O `run` (`tool-handlers-admin.ts:476-480`) faz `for (sub of subscriptions) await messages.upsertSubscription(...)` e depois `for (kind of remove) await messages.deleteSubscription(...)`.
- Cada chamada abre a própria transação (`messages.ts:316` e `:337`, `withTx`). Não há transação envolvendo o lote.
- A prévia mostra a mudança como um todo (`:455-475`). O mesmo `eventKind` pode vir em `subscriptions` e em `remove` (o schema, `tools-admin.ts:194-198`, não recusa): a execução cria e apaga em seguida.

### Verificação (tentativa de refutação)
- As checagens fáceis (caixas legíveis, parâmetros pelo Zod do evento, destino arquivado) rodam antes de cada gravação, mas por item: a segunda assinatura pode falhar depois de a primeira ter sido gravada (ex.: o destino arquivado por outra pessoa entre as duas, uma regra do banco nas caixas, timeout).
- Sem kit (ou em `allow`, ou no `/mcp`), nem a prévia roda.

### Impacto
Estado parcial raro, mas silencioso: o modelo recebe um erro e não sabe o que ficou gravado. Avisos (vencimentos, orçamento, aprovações) passam a sair ou a não sair para um destino sem que o usuário tenha aprovado aquela combinação.

## Como reproduzir
Destino com duas assinaturas pedidas, a segunda com uma caixa que o usuário perde a leitura entre a prévia e a aprovação: a primeira fica gravada e a tool devolve 403.

## Solução proposta
- Função de serviço `setSubscriptions(ctx, destinationId, { upsert, remove })` que valida tudo antes e grava numa única `withTx` (reaproveitando o corpo de `upsertSubscription` com o `tx` recebido).
- Recusar no schema o mesmo `eventKind` em `subscriptions` e `remove`, e repetido em `subscriptions`.

## Critérios de aceite
- [ ] Uma falha em qualquer item não deixa nenhuma mudança do lote gravada.
- [ ] Entrada com o mesmo evento nas duas listas é recusada com mensagem clara.

## Testes recomendados
`apps/server/test/agent-tools-admin.test.ts` (ou `messages.test.ts`): lote com o segundo item inválido no banco → nenhuma assinatura alterada; `eventKind` repetido → erro de validação.

## Limitações e suposições
Não procurei uma regra do banco específica que falhe na segunda assinatura; o cenário de corrida basta para o estado parcial.

## Análise (triagem)

## Resolução (executor)
