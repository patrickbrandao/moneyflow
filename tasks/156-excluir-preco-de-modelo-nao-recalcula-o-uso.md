---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# "Excluir preço" promete que o uso passa ao preço anterior, mas o custo é congelado na gravação e o preço usado não sai

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** descrição e prévia que induzem a erro (preços de IA)
- **Arquivos afetados:** `packages/shared/src/agents/tools-admin.ts:432-451`, `apps/server/src/agents/tool-handlers-admin.ts:713-756`, `apps/server/src/services/ai-admin.ts:407-430`, `database/schema.sql:1518,3906-3927,21500`, `packages/shared/src/i18n/errors.ts:485`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O administrador cadastra um preço errado (por exemplo, por mil em vez de por milhão de tokens) e pede ao agente para apagá-lo. O agente diz que, apagando, "o custo do uso passa a seguir o preço anterior". Não é o que acontece: o custo já gravado não muda, e se o preço já foi usado ele nem pode ser apagado. O orçamento do mês continua contando o valor errado.

### Evidência e análise técnica
- Descrição de `delete_ai_price` (`tools-admin.ts:446`): "Exclui um preço cadastrado (o custo do uso passa a seguir o preço anterior, se houver)". A prévia repete (`tool-handlers-admin.ts:752`).
- O custo é calculado uma vez, no `INSERT` em `ai_usage`, pelo trigger `ai_usage_before_insert` (`schema.sql:3906-3927`): `price_id := ai_model_price_at(...)`, `cost_micros := round(...)`. Nada recalcula depois.
- `ai_usage.price_id` tem FK para `ai_model_prices(id)` sem `ON DELETE` (`schema.sql:21500`): o preço que já precificou alguma chamada não pode ser apagado. `deletePrice` (`ai-admin.ts:425-430`) recebe o 23503, e o modelo ouve a mensagem genérica "O registro está vinculado a outros dados ou referencia algo que não existe." (`errors.ts:485`).
- `create_ai_price` (`tools-admin.ts:437`): "vale a partir de validFrom" — um `validFrom` no passado também não recalcula o uso já gravado; o comentário da tabela (`schema.sql:1518`) diz que o preço de um instante é a linha mais recente, o que só vale para as chamadas futuras.

### Verificação (tentativa de refutação)
- O teste (`agent-tools-admin.test.ts:511-521`) apaga um preço recém-criado, sem uso: o caminho com uso não é testado.
- Não há rota nem função de recálculo de `ai_usage` (`grep` por `UPDATE ai_usage`).
- `docs/027` só diz "mudar o preço = cadastrar um novo com a vigência" e "`delete_ai_price` (destrutiva)": a promessa de recálculo está só na descrição e na prévia.

### Impacto
O admin (e o agente) acreditam numa correção que não aconteceu; orçamentos e o painel de uso seguem com o custo errado do mês. Frequência baixa (cadastro de preço é raro), mas o erro de unidade é fácil.

## Como reproduzir
1. `create_ai_price` com `inputPricePerMillion: 3000` (errado) e usar o modelo numa conversa.
2. `delete_ai_price` desse preço: a execução falha com a mensagem genérica de vínculo; o custo da conversa continua o calculado com 3000.

## Solução proposta
- Corrigir a descrição e a prévia de `delete_ai_price`: só preço sem uso; o uso gravado não muda.
- Traduzir o 23503 de `ai_usage_price_id_fkey` (`DB_CONSTRAINT_MESSAGES`): "Este preço já foi usado em N chamadas: cadastre um preço novo com a vigência certa."
- Se o produto quiser corrigir o passado: uma ação de admin "recalcular o custo do período" (função do banco, com o dba) que reprecifica `ai_usage` pelo `ai_model_price_at`; a prévia mostraria o antes/depois por moeda.

## Critérios de aceite
- [ ] A descrição e a prévia de `delete_ai_price` e de `create_ai_price` dizem o que acontece com o uso já gravado.
- [ ] Excluir um preço usado devolve uma mensagem específica.

## Testes recomendados
`apps/server/test/agent-tools-admin.test.ts`: preço usado por um `ai_usage` → `delete_ai_price` falha com a mensagem nova; o `cost_micros` do uso não muda.

## Limitações e suposições
O recálculo do passado é decisão de produto; a correção mínima é o texto e a mensagem.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: a descrição e a prévia de `delete_ai_price` prometiam o recálculo; o custo é congelado no INSERT de `ai_usage` e o preço usado não sai (FK `ai_usage_price_id_fkey`), com a mensagem genérica de vínculo.

## Resolução (executor)

- Decisão: a correção mínima (texto e mensagem); recalcular o passado ficaria para uma decisão de produto com o dba.
- `services/ai-admin.ts`: `priceUsageCount` e `deletePrice` recusa o preço usado com `t.agents.errors.priceInUse(n)` (código `ai_usage_price_id_fkey`), na mesma transação; a FK ganhou a tradução em `DB_CONSTRAINT_MESSAGES` (a corrida).
- `delete_ai_price`: descrição e aviso dizem que o uso gravado não muda e que o preço usado não sai; a prévia recusa já com a contagem. `create_ai_price`: descrição e aviso dizem que o custo é calculado na gravação (o `validFrom` no passado não recalcula).
- Spec 027 atualizada (preços).
- Teste: `agent-tools-admin.test.ts` (preço usado por um `ai_usage`: a tool recusa sem cartão, a rota devolve 422 com a mesma mensagem e o `cost_micros` não muda); o teste longo da configuração de IA ganhou prazo de 120 s.
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
