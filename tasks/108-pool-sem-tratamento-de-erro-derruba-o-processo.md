---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Pool do Postgres sem `on('error')`: conexão ociosa que cai derruba a API e o worker

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** exceção não tratada no pool de conexões
- **Arquivos afetados:** `packages/db/src/index.ts:28-30`, `apps/server/src/main.ts:13-15`
- **Depende de / relacionado a:** tarefa 070, tarefa 107
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o banco reinicia (atualização, deploy, queda de rede), a API e o worker caem junto, de uma vez, no meio do que estavam fazendo. O Docker os sobe de novo, mas pedidos em andamento falham, as janelas dos agentes perdem a conexão e uma mensagem do Telegram que estava saindo pode ser enviada duas vezes.

### Evidência e análise técnica
- `createPool` cria `new pg.Pool({ connectionString, max, application_name })` e ninguém registra `pool.on('error', …)` (`packages/db/src/index.ts:28-30`; `main.ts:14`). Procurei `on('error'` em `apps/server/src` e `packages/db/src`: só a conexão de LISTEN do `events-hub.ts:42` tem o handler.
- No `pg`, um cliente ocioso que recebe o FATAL do servidor (57P01 "terminating connection due to administrator command", ou a conexão fechada) sem consulta ativa chama `this.emit('error', err)` (`pg@8.23.1/lib/client.js:416-433`). O pool pendura em todo cliente ocioso o `idleListener`, que reemite no próprio pool: `pool.emit('error', err, client)` (`pg-pool/index.js:51-63`).
- Um `EventEmitter` sem ouvinte de `'error'` lança o erro; como vem de um evento do socket, vira exceção não capturada e o Node encerra o processo (não há `process.on('uncaughtException')`).
- Sempre existe um cliente ocioso: o worker consulta a fila dos agentes a cada `AGENT_POLL_MS` (1 s) e o `idleTimeoutMillis` padrão do pool é 10 s; a API tem a sondagem do console e o SSE (releitura a cada 5 s).

### Verificação (tentativa de refutação)
- O `restart: unless-stopped` do compose (`docker-compose.yml:15`) reergue os contêineres, então o sistema se recupera; o defeito é a queda em si, não a falta de volta.
- As execuções de agente têm lease e são retomadas por outro worker; a outbox tem a reserva vencida em 5 min. Mas a mensagem enviada ao Telegram e ainda não marcada como `sent` sai de novo depois da retomada, e as requisições HTTP e os SSE abertos morrem.
- Não há teste que derrube uma conexão ociosa.

### Impacto
Todo reinício do Postgres derruba os dois processos. Em produção, onde o banco é atualizado junto com a pilha, isso acontece a cada deploy do banco e em qualquer falha de rede entre os contêineres.

## Como reproduzir
1. `pnpm dev:worker` com o banco local.
2. Num `psql` como `moneyflow_app` (o papel pode sinalizar os próprios backends): `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'moneyflow' AND state = 'idle';`
3. O worker termina com `error: terminating connection due to administrator command` não tratado.

## Solução proposta
1. `createPool(url, max, onError?)`: registrar `pool.on('error', onError ?? (() => {}))`; em `main.ts`, passar um `log.warn({ err }, 'banco: conexão ociosa caiu')`. O pool já descarta o cliente com erro; a próxima consulta abre outro.
2. Aproveitar para dar teto ao que hoje espera para sempre: `connectionTimeoutMillis` (ex.: 10 s) e `keepAlive: true`.
3. Opcional: `process.on('unhandledRejection')` logando e saindo de forma controlada, para não depender do comportamento padrão.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
-export function createPool(url: string, max = 10) {
-  return new pg.Pool({ connectionString: url, max, application_name: 'moneyflow' });
+export function createPool(url: string, max = 10, onError: (error: Error) => void = () => {}) {
+  const pool = new pg.Pool({ connectionString: url, max, application_name: 'moneyflow', keepAlive: true, connectionTimeoutMillis: 10_000 });
+  // Cliente ocioso que perde a conexão: o pool já o descarta; sem este ouvinte, o processo cai.
+  pool.on('error', onError);
+  return pool;
 }
```

## Critérios de aceite
- [ ] Terminar as conexões ociosas da aplicação não derruba a API nem o worker; a consulta seguinte funciona.
- [ ] A queda fica registrada como aviso no log.

## Testes recomendados
`apps/server/test/` (novo caso, por exemplo em `test/health.test.ts`): faça uma consulta, termine as conexões ociosas do papel com `pg_terminate_backend` por outro cliente, espere o evento e confira que o processo segue vivo e que `GET /api/health` responde 200. No modo local, o `moneyflow_app` pode sinalizar os próprios backends.

## Limitações e suposições
Nada foi executado. O comportamento do `pg` e do `pg-pool` foi lido no código instalado (`pg@8.23.1`).

## Análise (triagem)

## Resolução (executor)
