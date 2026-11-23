---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Variáveis de ambiente numéricas vazias ou inválidas viram 0 ou NaN em silêncio

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** validação da configuração por ambiente
- **Arquivos afetados:** `apps/server/src/config.ts:99-142`, `apps/server/src/config.ts:145-150`, `apps/server/src/config.ts:70-76`, `apps/server/src/agents/worker.ts:53-66`, `apps/server/src/agents/worker.ts:130-134`, `apps/server/src/worker.ts:48`, `apps/server/src/worker.ts:63`, `apps/server/src/auth/session.ts:16-22`, `apps/server/src/routes/auth.ts:15`, `apps/server/src/integrations/telegram.ts:55,91`
- **Depende de / relacionado a:** tarefa 066 (fez a validação só do `SESSION_IDLE_HOURS`)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se uma variável de ambiente numérica ficar vazia ou com um valor errado (`30d` em vez de `30`, `quatro` em vez de `4`), o sistema sobe normalmente e se comporta mal sem avisar: os agentes de IA nunca rodam, o worker passa a consultar o banco centenas de vezes por segundo, ou ninguém consegue entrar porque o login dá erro ou a sessão já nasce vencida. Nada no log explica a causa.

### Evidência e análise técnica
`loadConfig` trata dois grupos de forma diferente. Os mais novos passam por `clampInt` (vazio ou inválido = padrão, com faixa; `config.ts:145-150`) ou pela checagem de `SESSION_IDLE_HOURS` (`config.ts:70-76`). Os mais antigos usam `Number(env.X ?? padrão)` (`config.ts:102-141`): `??` só cobre `undefined`, então `''` vira `0` e `'abc'`/`'30d'` vira `NaN`, e nada confere o resultado nem falha no boot.

Efeitos de cada variável:

| Variável | Valor inválido vira | Efeito |
|---|---|---|
| `SESSION_DAYS` | `NaN` (`abc`, `30d`) ou `0` (vazio) | `NaN`: `new Date(NaN).toISOString()` lança `RangeError` em `createSession` (`session.ts:18-22`) e todo login responde 500. Vazio: `expiresAt = now`, todo login cria uma sessão já vencida (o login devolve 200, mas a próxima chamada é 401) |
| `AGENT_CONCURRENCY` | `Math.max(1, NaN)` = `NaN` (`config.ts:130`) | em `claim()` (`agents/worker.ts:61-65`), `active.size < NaN` e `active.size >= NaN` são falsos: o laço nunca reserva execução. Nenhuma execução de agente roda, sem erro no log |
| `AGENT_POLL_MS`, `AGENT_MAINTENANCE_MS` (e `WORKER_INTERVAL_MS`, `MESSAGE_INTERVAL_MS`) | `NaN` ou `0` (`config.ts:108,124,129`) | `setInterval(fn, NaN/0)` roda a cada ~1 ms (`agents/worker.ts:130-134`, `worker.ts:48,63`): `ai_run_claim`, a transcrição e as receitas são consultados sem pausa, e a materialização das séries, cartões, contratos e o laço de mensagens reexecutam sem pausa (as travas `running`/`sending` só evitam sobreposição) |
| `TELEGRAM_TIMEOUT_MS`, `LOOKUP_TIMEOUT_MS` | `NaN` ou `0` | `NaN`: `AbortSignal.timeout(NaN)` lança `TypeError` (conferido no Node local), tratado como erro de rede: toda mensagem falha 5 vezes e vira `failed` (`telegram.ts:55,91`), e a consulta de CNPJ/CEP dá 503. `0`: toda consulta e todo envio estouram o tempo na hora |
| `LOGIN_RATE_LIMIT` | `NaN` ou `0` (`routes/auth.ts:15`) | `NaN`: o `@fastify/rate-limit` troca por 1000 (`index.js:201-205`), o limite de login fica 100 vezes mais frouxo. `0`: bloqueia todo login |
| `NOTIFY_AT` | inválido | cai em `08:00` sem aviso (`config.ts:128`) |
| `PORT` | `0` (vazio) | a API escuta numa porta aleatória (`PORT` inválido não vazio já falha no `listen`) |

O caso realista é o compose do projeto externo de produção com `AGENT_CONCURRENCY: ${AGENT_CONCURRENCY}` e a variável ausente do `.env`: o Compose passa string vazia (só avisa no terminal).

### Verificação (tentativa de refutação)
- O `docker-compose.yml` deste repositório usa `${VAR:-padrão}`, que também troca o vazio pelo padrão: aqui o vazio não causa o defeito. Ele aparece no `.env` do `pnpm dev` (um `AGENT_POLL_MS=` comentado pela metade), em composes sem o `:-` (a produção usa um projeto externo, `docs/018`) e, para valor errado como `30d`, em qualquer ambiente.
- Testes: `auth.test.ts:198-201` cobre só `SESSION_IDLE_HOURS`; `lookup.test.ts:257-263`, só o CNPJ Aberto. Nenhum teste de `loadConfig` com número vazio ou inválido nos outros campos.
- `sessionIdleHours` (`config.ts:70-76`) já mostra o padrão certo (lança com mensagem clara), mas não foi aplicado aos demais.
- `BACKUP_MAX_UPLOAD_MB` provavelmente falha no registro do parser; ficou fora da tabela.

### Impacto
Falha silenciosa e difícil de diagnosticar em produção: login fora do ar, agentes "não respondem" (`AGENT_CONCURRENCY`) ou o banco e a CPU ficam sob carga constante (`*_INTERVAL_MS`, `AGENT_POLL_MS`). Depende de alguém errar a variável (frequência baixa), mas o custo de cada ocorrência é alto.

## Como reproduzir
1. `AGENT_CONCURRENCY=quatro pnpm dev:worker`: mande uma mensagem a um agente; a execução fica `queued` para sempre e o log não mostra erro.
2. `.env` com `AGENT_POLL_MS=` → `pnpm dev:worker`: com `log_statement = 'all'` no Postgres de desenvolvimento, o log mostra `ai_run_claim` centenas de vezes por segundo (ou o `xact_commit` de `pg_stat_database` dispara).
3. `.env` com `SESSION_DAYS=` → `pnpm dev`: login devolve 200, mas a próxima chamada é 401.
4. `SESSION_DAYS=30d pnpm dev`: `POST /api/auth/login` responde 500.

## Solução proposta
1. Uma função `intEnv(name, { default, min, max })` que trata vazio como ausente e **lança** com a mensagem pt-BR ("AGENT_CONCURRENCY precisa ser um inteiro entre 1 e 64; veja .env.example") para valor inválido ou fora da faixa, como `sessionIdleHours` faz.
2. Usá-la em todos os numéricos de `config.ts:102-141` (`PORT` 1–65535, `SESSION_DAYS` ≥ 1, intervalos ≥ 100 ms, `AGENT_CONCURRENCY` 1–64, `LOGIN_RATE_LIMIT` ≥ 1, timeouts ≥ 100 ms, `BACKUP_MAX_UPLOAD_MB` ≥ 1). As faixas são sugestão.
3. Decidir: inválido lança (falha no boot, preferível) e vazio usa o padrão. Para os campos que hoje usam `clampInt` (que corrige calado), decidir entre falhar ou avisar no log, e registrar a decisão no `.env.example`.

### Diff/patch proposto — NÃO APLICADO
```ts
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} precisa ser um inteiro entre ${min} e ${max} (veja .env.example).`);
  return n;
}
// ...
agentConcurrency: intEnv(env, 'AGENT_CONCURRENCY', 4, 1, 64),
agentPollMs: intEnv(env, 'AGENT_POLL_MS', 1000, 100),
sessionDays: intEnv(env, 'SESSION_DAYS', 30, 1, 3650),
messageIntervalMs: intEnv(env, 'MESSAGE_INTERVAL_MS', 30_000, 1000, 3_600_000),
```

## Critérios de aceite
- [ ] Vazio em qualquer variável numérica usa o padrão documentado.
- [ ] Valor não inteiro ou fora da faixa impede o boot com mensagem que cita a variável.
- [ ] Nenhuma variável numérica de `config.ts` usa `Number(env.X ?? …)` direto.
- [ ] Os padrões e os valores do `.env.example` continuam aceitos.

## Testes recomendados
`apps/server/test/auth.test.ts` (ao lado de "recusa SESSION_IDLE_HOURS inválido") ou um `test/config.test.ts` novo, sem banco: `loadConfig({ DATABASE_URL, AGENT_CONCURRENCY: 'abc' })` lança; `AGENT_POLL_MS: ''` dá 1000; `SESSION_DAYS: '0'` e `SESSION_DAYS=30d` lançam; `PORT: '70000'` lança; `MESSAGE_INTERVAL_MS=0` e `TELEGRAM_TIMEOUT_MS=x` lançam; os valores do `.env.example` passam.

## Limitações e suposições
Só o `AbortSignal.timeout(NaN)` e o `new Date(NaN)` foram executados (Node local); o resto é leitura do código (`Math.max(1, NaN)` e `Number('')` são comportamento da linguagem). Não vi o compose do projeto externo de produção.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado em `apps/server/src/config.ts`: os campos antigos usavam `Number(env.X ?? padrão)` (vazio = 0, `30d` = `NaN`, sem conferência) e os novos `clampInt`, que corrigia calado; só `SESSION_IDLE_HOURS` lançava. O `AGENT_CONCURRENCY` com `Math.max(1, NaN)` dava `NaN`.

## Resolução (executor)

- `apps/server/src/config.ts`: `intEnv(env, nome, padrão, min, max)` (exportada) para todas as numéricas — vazia ou ausente = o padrão; não inteira (`30d`, `1.5`, `quatro`) ou fora da faixa lança "`X` precisa ser um inteiro entre `min` e `max` (veja .env.example); recebido …", que impede o boot. Saem `clampInt` e `sessionIdleHours`. `NOTIFY_AT` fora de `HH:MM` também lança (vazio = 08:00).
- Decisão: inválido sempre impede o boot, inclusive nos campos que antes passavam pelo `clampInt` (corrigir calado escondia o erro). Faixas: `PORT` 1–65535, `SESSION_DAYS` 1–3650, `SESSION_IDLE_HOURS` 0–87600 (0 desliga), `WORKER_INTERVAL_MS` e `AGENT_MAINTENANCE_MS` 1 s–24 h, `MESSAGE_INTERVAL_MS` e `AGENT_TASK_INTERVAL_MS` 1 s–1 h, `AGENT_POLL_MS` 100 ms–60 s, `AGENT_CONCURRENCY` 1–64, `LOOKUP_TIMEOUT_MS` 100 ms–120 s, `TELEGRAM_TIMEOUT_MS` 100 ms–300 s, `LOGIN_RATE_LIMIT` ≥ 1, `BACKUP_MAX_UPLOAD_MB` 1–4096, `AI_DOCUMENT_TIMEOUT_MS` 1 s–30 min; as do antigo `clampInt` mantêm a faixa que já tinham.
- `.env.example`: o comentário da regra no topo da seção Aplicação. Spec: `docs/001`, linha nova "Configuração".
- Testes: `apps/server/test/config.test.ts` (novo, sem banco): vazio usa o padrão; `AGENT_CONCURRENCY=quatro`/`0`, `SESSION_DAYS=30d`/`0`, `PORT=70000`, `MESSAGE_INTERVAL_MS=0`, `WORKER_INTERVAL_MS=1.5`, `TELEGRAM_TIMEOUT_MS=x`, `LOOKUP_TIMEOUT_MS=NaN`, `LOGIN_RATE_LIMIT=0`, `AGENT_POLL_MS=10`, `AI_RUNS_PER_MINUTE=5000` e outros lançam citando a variável; os valores do `.env.example` e os limites das faixas (0 onde vale) passam. O caso de `SESSION_IDLE_HOURS` em `test/auth.test.ts` segue valendo.
- Verificação: `pnpm verify:quick`.
