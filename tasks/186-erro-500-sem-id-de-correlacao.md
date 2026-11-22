---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Erro 500 sem identificador: o usuário vê "Algo deu errado" e o log não tem como ser achado

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** melhoria
- **Subcategoria:** observabilidade (correlação de requisição)
- **Arquivos afetados:** `apps/server/src/app.ts:53-59`, `apps/server/src/app.ts:97-114`, `apps/web/src/lib/api.ts:50-56`, `packages/shared/src/i18n/pt-BR.ts:150`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando algo quebra no servidor, a tela só diz "Algo deu errado. Tente de novo." Não aparece nenhum código para o usuário informar, e o registro do erro no servidor tem um número que recomeça do zero a cada reinício. Achar o erro certo no log, em produção, vira adivinhação por horário.

### Evidência e análise técnica
- `Fastify({ logger, trustProxy, bodyLimit })` (`app.ts:53-59`) não define `genReqId` nem `requestIdHeader`. No Fastify 5.12.5, o padrão é um contador por processo: `req-${nextReqId.toString(36)}` (`node_modules/.pnpm/fastify@5.12.5/.../lib/req-id-gen-factory.js:31-43`), e `requestIdHeader` é `false` (`fastify.js:882`). O id recomeça em `req-1` a cada reinício e se repete entre a API e outras réplicas.
- O id não volta ao cliente: nenhum `x-request-id` na resposta (procurei `request-id`, `reqId` e `genReqId` em `apps/server/src`: nada).
- O handler de erro registra o 500 com `request.log.error(error)` e responde só `{ error: { code: 'internal', message: t.errors.generic } }` (`app.ts:112-113`). No console, o `ApiError` mostra essa mensagem (`api.ts:56`; texto em `pt-BR.ts:150`).
- O worker não tem id por passada; só as execuções de agente carregam `runId` nos logs.

### Verificação (tentativa de refutação)
- O logger é JSON (pino) com `reqId` em cada linha do request, então a correlação *dentro* do log existe; o que falta é o elo com o usuário e um id único entre reinícios.
- A produção fica num projeto externo e pode ter um proxy que gera `X-Request-Id`, mas a API não o lê (`requestIdHeader: false`) nem o devolve.

### Impacto
Cada relato de erro do usuário exige procurar no log por horário aproximado, rota e usuário. Baixa frequência, mas o tempo de diagnóstico é alto, e é a informação que uma tarefa em `tasks/` precisaria para reproduzir.

## Como reproduzir
1. Provoque um 500 (ex.: derrube o Postgres no meio de uma requisição).
2. A tela mostra "Algo deu errado. Tente de novo."; a resposta não tem cabeçalho nem campo com id.
3. Reinicie a API: o próximo request volta a ser `req-1` no log.

## Solução proposta
1. `genReqId: (req) => (trusted && req.headers['x-request-id']) || randomUUID()` — aceitar o id do proxy só quando `TRUSTED_PROXIES` estiver definido, como já se faz com o IP (tarefa 050).
2. Hook `onSend` (junto de `registerSecurityHeaders`) com `reply.header('x-request-id', request.id)`.
3. No 500, incluir `requestId: request.id` no corpo; no console, mostrar "Algo deu errado (código abc123)" com o começo do id e um botão de copiar.
4. No worker, um `log.child({ tick: randomUUID() })` por passada de cada laço.

### Diff/patch proposto — NÃO APLICADO
```ts
// apps/server/src/app.ts
const app = Fastify({
  logger: ...,
  genReqId: (req) => {
    const fromProxy = config.trustedProxies.length > 0 ? req.headers['x-request-id'] : undefined;
    return typeof fromProxy === 'string' && /^[\w-]{8,64}$/.test(fromProxy) ? fromProxy : randomUUID();
  },
  ...
});
app.addHook('onSend', async (request, reply) => { reply.header('x-request-id', request.id); });
...
request.log.error(error);
return reply.status(500).send({ error: { code: 'internal', message: t.errors.generic, requestId: request.id } });
```

## Critérios de aceite
- [ ] Toda resposta da API tem `x-request-id`, único entre reinícios.
- [ ] O 500 traz `requestId` no corpo e o console o mostra ao usuário.
- [ ] O id do proxy só é aceito com `TRUSTED_PROXIES` definido e com formato válido.

## Testes recomendados
`apps/server/test/security-headers.test.ts`: toda resposta tem `x-request-id` com formato de UUID; com `TRUSTED_PROXIES` e o cabeçalho do proxy, o id é o dele; sem `TRUSTED_PROXIES`, o do cliente é ignorado; uma rota de teste que lança devolve `requestId` igual ao cabeçalho.

## Limitações e suposições
Nada foi executado. Não vi o proxy da produção. Métricas (fila de execuções, outbox pendente) também não existem, mas ficaram fora deste achado para não misturar assuntos.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: o `Fastify(...)` não definia `genReqId` (o padrão é o contador `req-1`, `req-2`… do processo), nenhuma resposta levava o id e o 500 respondia só `{ code: 'internal', message }`.

## Resolução (executor)

- `apps/server/src/app.ts`: `genReqId` devolve um UUID (`randomUUID`) por requisição; com `TRUSTED_PROXIES` definido, aceita o `X-Request-Id` do proxy quando ele casa com `^[\w-]{8,64}$` (sem `TRUSTED_PROXIES`, o do cliente é ignorado, como no IP da tarefa 050). Um `onSend` põe `x-request-id` em toda resposta, e o 500 devolve `requestId` no corpo; a linha do erro no log já leva o mesmo id (`reqId`), resolvido junto com a tarefa 070.
- Shared: `ApiError.error.requestId` opcional (`types.ts`) e `t.errors.genericWithCode(código)`.
- Console: `apiErrorFrom` (`apps/web/src/lib/api.ts`, usado também por `upload.ts` e `download.ts`) guarda o `requestId` no `ApiError` e, no 500, mostra "Algo deu errado (código abc12345). Tente de novo." com os 8 primeiros caracteres do id. Decisão: sem botão de copiar (o código é texto selecionável na mensagem; o id completo fica no cabeçalho e no log).
- O `log.child` por passada do worker ficou para a tarefa 107 (laços do worker), que mexe no mesmo arquivo.
- Testes: `apps/server/test/security-headers.test.ts` (o `x-request-id` UUID e diferente em cada resposta, inclusive 401/404 e o SPA; o do cliente ignorado sem `TRUSTED_PROXIES`; com `TRUSTED_PROXIES`, o do proxy vale e o fora do formato vira UUID) e `apps/server/test/errors.test.ts` (o `requestId` do 500 igual ao cabeçalho e presente no log).
- Spec: `docs/001`, linha "Logs e erros".
- Verificação: `pnpm verify:quick` (com `test/errors.test.ts` e `test/security-headers.test.ts`).
