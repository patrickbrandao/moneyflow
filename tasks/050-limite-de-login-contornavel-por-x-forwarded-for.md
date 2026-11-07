---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-07
commit:
---

# Limite de tentativas de login contornável por X-Forwarded-For (`trustProxy: true`)

- **Severidade:** alta
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** rate limit / força bruta
- **Arquivos afetados:** `apps/server/src/app.ts:54,87`, `apps/server/src/routes/auth.ts:13-16`, `apps/server/src/routes/mcp.ts:97`, `apps/server/src/config.ts:17-18,88`, `docker-compose.yml:88-89`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O sistema conta as tentativas de senha pelo endereço de quem acessa, mas aceita o endereço que o próprio visitante declara num cabeçalho. Um atacante declara um endereço diferente a cada tentativa e nunca é bloqueado. As senhas, por decisão de produto, ficam em texto puro, e a do admin dá poder total.

### Evidência e análise técnica
- `app.ts:54`: `trustProxy: true`. `app.ts:87`: `rateLimit, { global: false }`, sem `keyGenerator`. O login tem `config: { rateLimit: { max: app.config.loginRateLimit, timeWindow: '1 minute' } }` (`routes/auth.ts:13-16`), com padrão 10 (`config.ts:88`), que o comentário descreve como "por IP".
- Fastify 5.12.5 (`lib/request.js:48-50`): com `trustProxy === true`, a função de confiança devolve sempre `true`. `request.ip` é o último elemento de `proxyAddr.all(...)` (`request.js:113-114`). Com todos confiáveis, `@fastify/proxy-addr` 5.1.2 (`index.js:55-74`) não corta a lista. Pela ordem do `forwarded`, o último elemento é o endereço mais à esquerda do XFF, que o cliente controla por inteiro.
- `@fastify/rate-limit` 11.2.1 (`index.js:58`) usa `req.ip` como chave padrão.

### Verificação (tentativa de refutação)
- O compose publica a API direto na porta (`docker-compose.yml:88-89`), sem proxy. Não há `TRUSTED_PROXIES` nem documentação de proxy no repositório.
- A produção fica num projeto externo (`docs/018:17`) e não foi verificada. Mesmo atrás de um proxy que só acrescenta ao XFF (o padrão `$proxy_add_x_forwarded_for` do nginx e o Traefik), o valor do cliente continua à esquerda e o contorno segue funcionando.
- `docs/002` não fala de proxy. Não é intencional.

### Impacto
Força bruta ilimitada de senha em `POST /api/auth/login`, rota pública, inclusive contra o admin. `sessions.ip` e `user_api_tokens.last_used_ip` (via `routes/mcp.ts:97`) também ficam forjáveis, e a auditoria de IP perde valor. Um XFF que não é IP provavelmente gera 500 no INSERT de `sessions.ip` (`inet`) depois de uma senha correta.

## Como reproduzir
Mandar 11 ou mais `POST /api/auth/login` errados do mesmo cliente, cada um com um `X-Forwarded-For: <IP aleatório válido>` diferente. Nenhum recebe 429.

## Solução proposta
- Criar a variável `TRUSTED_PROXIES` (lista de CIDRs; vazia significa `trustProxy: false`) e passá-la ao Fastify.
- Opcional: um segundo limite por login (username/e-mail), além do IP, contra botnets.
- Atualizar `.env.example`, `docker-compose.yml` e `docs/002`. Registrar em `docs/001`/`docs/018` que o proxy de produção precisa constar em `TRUSTED_PROXIES`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
@@
   const app = Fastify({
     logger: logger === true ? { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] } : logger,
-    trustProxy: true,
+    // Só os proxies de TRUSTED_PROXIES podem informar o IP do cliente (X-Forwarded-For).
+    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
     bodyLimit: 1024 * 1024,
   });
--- a/apps/server/src/config.ts
+++ b/apps/server/src/config.ts
@@
     loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
+    trustedProxies: (env.TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
```

## Critérios de aceite
- [ ] Sem `TRUSTED_PROXIES`, um XFF diferente a cada requisição não passa de `LOGIN_RATE_LIMIT` tentativas por minuto: a 11ª devolve 429.
- [ ] Com `TRUSTED_PROXIES` igual ao IP do peer, o XFF é respeitado.
- [ ] `sessions.ip` grava o IP real.
- [ ] `.env.example`, compose e `docs/002` atualizados.

## Testes recomendados
`apps/server/test/auth.test.ts`: `app.inject` com `remoteAddress` fixo e o XFF variando em 11 logins errados, esperando 429; outro caso com `TRUSTED_PROXIES` configurado. Nada disso foi executado nesta auditoria.

## Limitações e suposições
A configuração do proxy de produção não foi verificada. Botnets com muitos IPs reais exigem o limite por conta.

## Análise (triagem)

**Veredito: procede (bug de segurança, alta). Executor: `app`.** Nada em `database/`.

**Causa confirmada no código atual (commit `1ebb073`).** `apps/server/src/app.ts:54` cria o Fastify com `trustProxy: true`; `app.ts:87` registra o `@fastify/rate-limit` com `global: false` e sem `keyGenerator`; o login (`routes/auth.ts:15`) limita a `loginRateLimit` (10) por minuto pela chave padrão `req.ip`. Nas libs instaladas: Fastify 5.12.5 (`lib/request.js`, `getTrustProxyFn`: com `true` devolve sempre `true`; `ip` = último de `proxyAddr.all`, que, confiando em todos, é o endereço mais à esquerda do XFF) e `@fastify/rate-limit` 11.2.1 (`index.js:58`, `defaultKeyGenerator` = `normalizeIP(req.ip)`). `request.ip` também vai para `sessions.ip` (`routes/auth.ts:21` → `auth/session.ts:23`, coluna `inet`) e para `api_token_authenticate(..., p_ip inet)` (`routes/mcp.ts:97`). Não há `TRUSTED_PROXIES` nem menção a proxy em `.env.example`, `docker-compose.yml` ou `docs/001`/`002`/`018`; nenhum teste usa XFF.

**Reprodução (sem alterar o projeto).** Script no scratchpad com o Fastify e o rate-limit instalados em `apps/server/node_modules`, mesma configuração (`max: 10`, `1 minute`), `remoteAddress` fixo e `X-Forwarded-For: 10.0.<i>.1, 198.51.100.9` variando (simula um proxy que acrescenta ao XFF):
- `trustProxy: true`: 15 de 15 respostas 401, nenhuma 429; `req.ip` = `10.0.0.1` (o valor do cliente, à esquerda, mesmo com o "proxy" acrescentando).
- `trustProxy: false`: 10 respostas 401 e depois 429; `req.ip` = o peer.
- `X-Forwarded-For: nao-e-ip` com `trustProxy: true`: `req.ip` = `"nao-e-ip"`. No login com senha correta isso vai ao INSERT de `sessions.ip` (`inet`) e deve dar erro 22P02/500; no `/mcp`, à chamada de `api_token_authenticate`. Não executado contra o banco, mas a cadeia está confirmada pela leitura.

**Arquivos afetados.** `apps/server/src/app.ts`, `apps/server/src/config.ts` (nova `trustedProxies`), `.env.example`, `docker-compose.yml` (repassar `TRUSTED_PROXIES`), `apps/server/test/auth.test.ts`. Specs: `docs/002-usuarios-e-permissoes.md` (o limite de login é por IP real; quando o XFF vale), `docs/001-stack-e-entrega.md` (variável de ambiente) e `docs/018-versoes-e-publicacao.md` (a produção precisa declarar o proxy dela).

**Correção indicada.** A do patch da tarefa: `TRUSTED_PROXIES` como lista separada por vírgula (IPs/CIDRs ou os nomes do proxy-addr `loopback`, `linklocal`, `uniquelocal`), passada ao Fastify como string/array; vazia = `trustProxy: false`. Não usar número de saltos (o Fastify 5.12 trata número como "não confiar", fail closed). O limite por login (usuário/e-mail) é opcional e pode ficar para outra tarefa; se entrar aqui, chave separada e sem revelar se o login existe.

**Padrão de `TRUSTED_PROXIES` (decisão operacional, não bloqueia).** Recomendo **vazio** (não confiar em proxy nenhum). Não usar as faixas privadas como padrão: com a porta publicada pelo Docker (proxy de userland, Docker Desktop) o peer chega com o IP do gateway da rede do Docker, que é privado, e o contorno voltaria na instalação direta. Consequência que precisa ir para a nota da release e para a `docs/018`: a produção fica atrás de um proxy desconhecido; ao atualizar sem configurar `TRUSTED_PROXIES`, todo mundo aparece com o IP do proxy, os logins compartilham um único balde de 10 por minuto e `sessions.ip` grava o IP do proxy. Isso é seguro, mas pode travar o login se muita gente entrar ao mesmo tempo. **Pergunta para o usuário (a sessão principal leva antes de publicar, não antes de implementar):** qual é o IP/CIDR do proxy reverso da produção (ou da rede Docker dele) para pôr em `TRUSTED_PROXIES` no projeto externo?

**Risco da correção.** Baixo no código (uma opção do Fastify). O risco é operacional, só em produção, e está descrito acima. Os e2e e a integração falam direto com a API, sem proxy: não mudam (o e2e já reaproveita a sessão por causa do limite).

**Como verificar.** Testes de integração com `app.inject` e `remoteAddress` fixo: (1) sem `TRUSTED_PROXIES`, 11 logins errados com XFF diferentes a cada um, o 11º devolve 429; (2) com `TRUSTED_PROXIES` igual ao `remoteAddress`, o XFF vale (cada IP tem o seu balde, e `sessions.ip` grava o IP do XFF depois de um login certo); (3) sem `TRUSTED_PROXIES`, um XFF que não é IP não muda `sessions.ip` (fica o peer) e o login certo devolve 200. Rodar `pnpm --filter @moneyflow/server test:local test/<arquivo> -t "<nome>"` e `pnpm verify:quick`.

## Resolução (executor)

**O que mudou.**
- `apps/server/src/config.ts`: `trustedProxies` vindo de `TRUSTED_PROXIES` (lista separada por vírgula de IPs, CIDRs ou `loopback`/`linklocal`/`uniquelocal`; vazia por padrão).
- `apps/server/src/app.ts`: `trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false` (nunca `true`, sem número de saltos). O limite do login (`@fastify/rate-limit` pela chave `req.ip`), `sessions.ip` e o IP do token no `/mcp` passam a usar o IP da conexão, ou o do XFF só quando o peer é um proxy listado.
- `.env.example` e `docker-compose.yml` (serviço `api`): `TRUSTED_PROXIES` vazio, com o comentário.
- O limite por login (usuário/e-mail) ficou de fora (opcional; pode virar outra tarefa).

**Testes.** `apps/server/test/auth.test.ts`, `describe('limite de login e IP do cliente (tarefa 050)')`, cada caso com uma app própria em `LOGIN_RATE_LIMIT=10` e `remoteAddress` fixo: (1) sem `TRUSTED_PROXIES`, 11 logins errados com XFF diferentes: 10×401 e o 11º 429; (2) sem `TRUSTED_PROXIES`, XFF `nao-e-ip` no login certo: 200 e `sessions.ip` = o peer; (3) com `TRUSTED_PROXIES` = o peer, cada cliente do XFF tem o seu balde (11 IPs diferentes, todos 401), o mesmo cliente chega ao 429, `sessions.ip` grava o IP do XFF, e com `1.2.3.4, 198.51.100.21` grava o que o proxy acrescentou (o valor da esquerda não vale).

**Specs.** `docs/002-usuarios-e-permissoes.md` (limite de login por IP real e quando o XFF vale), `docs/001-stack-e-entrega.md` (ambiente local sem proxy, `TRUSTED_PROXIES` vazio) e `docs/018-versoes-e-publicacao.md` (a produção precisa configurar `TRUSTED_PROXIES` com o proxy dela antes de atualizar; sem isso todos dividem um balde e `sessions.ip` grava o IP do proxy).

**Pendência operacional (não bloqueia o código).** Antes de publicar, levar ao usuário a pergunta da triagem: qual o IP/CIDR do proxy reverso da produção (ou da rede Docker dele) para pôr em `TRUSTED_PROXIES` no projeto externo.

