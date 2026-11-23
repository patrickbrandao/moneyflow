---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: c5e748d
---

# Documentação de entrada contradiz as specs e o código (contrato, agentes, variáveis de ambiente)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** `docs/INDEX.md`, `README.md`, `AGENTS.md`, `.env.example` e comentário do Vite
- **Arquivos afetados:** `docs/INDEX.md:17`, `docs/INDEX.md:62`, `docs/INDEX.md:65`, `docs/015-fases.md:23`, `README.md:38`, `README.md:60`, `AGENTS.md:86`, `.env.example:13`, `.env.example:24-25`, `apps/server/src/config.ts:101`, `apps/server/src/config.ts:106`, `apps/server/src/config.ts:112-114`, `apps/server/src/main.ts:12`, `apps/web/vite.config.ts:5-11`
- **Depende de / relacionado a:** tarefa 124
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Os textos que alguém (pessoa ou agente) lê primeiro ainda descrevem o sistema de algumas versões atrás: dizem que o contrato gera parcelas e que a renovação é uma tarefa para aprovar, que o agente tem uma "lista de tools" — coisas que mudaram. E o arquivo de exemplo de configuração não lista algumas variáveis que o sistema lê, além de citar uma que ninguém lê.

### Evidência e análise técnica
1. **Contrato no `docs/INDEX.md`.** `docs/INDEX.md:17`: "**Contrato**: … gera os títulos das parcelas do ciclo, e a renovação é uma tarefa aprovada pelo usuário." A spec 020 diz o contrário: "O contrato não gera parcelas próprias: as ocorrências são títulos normais da série" (`docs/020-contratos.md:4`); a 034 tira o `renewal_pending` ("a renovação é uma ação", `docs/034-contratos-sobre-series.md:11`), faz a renovação automática pelo worker (`:40`, `:89`) e deixa `contract_renewal_tasks` só como histórico (`:61`). O código segue a 034 (`syncLifecycle`, `apps/server/src/services/contracts.ts:486-506`). O `AGENTS.md:7` importa o INDEX, então todo agente recebe a frase errada logo no começo.
2. **README.** `README.md:38`: o agente se configura com "tools habilitadas, se as escritas pedem confirmação". Desde a F7 isso é o kit de ferramentas, que "substitui a lista de tools e a flag de confirmação do agente" (`docs/015-fases.md:9`, spec 021); e o provedor passou a ser por inferência ("Provedor padrão", spec 024). `README.md:60` lista as specs só até "fases e banco de dados" (as 019–035 não aparecem: contratos, backup, anotações…).
3. **Tempo verbal vencido.** `AGENTS.md:86`: "As tools dos agentes (F4) reaproveitarão os mesmos serviços" — a F4 foi entregue e o `AGENTS.md:94` descreve as tools como existentes.
4. **Marcas de entrega desiguais.** `docs/INDEX.md:59-61` e `:64` dizem "(entregue)" para F15–F17 e F20; `:62` (F18, 032) e `:65` (F21, 035) não; `docs/015-fases.md:23` também não marca a F21, publicada na v0.1.21.
5. **`.env.example` × código.**
   - Lidas e não documentadas: `HOST` (`config.ts:101`, padrão `0.0.0.0` — em `pnpm dev` a API escuta em todas as interfaces), `WEB_DIST` (`:106`), `CNPJ_ABERTO_BASE` e `BRASILAPI_BASE` (`:112-114`), `MODE` (`main.ts:12`), `API_PORT` e `WEB_PORT` (`vite.config.ts:6`, `:11`).
   - Documentada e sem efeito na raiz: `MONEYFLOW_DB_PORT` (`.env.example:13`). O banco de desenvolvimento lê `database/.env` (o `database/Makefile` roda o compose dentro de `database/`), e a pilha da raiz substitui a porta por `STACK_DB_PORT` (`docker/database.override.yml:7-8`, `!override`).
6. **Comentário do Vite errado.** `vite.config.ts:5`: "encaminha `/api` … para a API (**PORT do .env**, padrão 3001)". O código lê `process.env.API_PORT` (`:6`) e o Vite não carrega o `.env` da raiz na configuração. Quem muda `PORT=3002` no `.env` (como o `.env.example:24-25` sugere) fica com o proxy apontando para a 3001.

### Verificação (tentativa de refutação)
- Conferi que `docs/INDEX.md` lista todas as 35 specs de `docs/` e nenhuma a mais (comparei os links com os arquivos): o índice está completo; o problema é só o texto geral e as marcas.
- `HOST` vem definido na imagem (`Dockerfile:24`), então em produção não importa; o padrão `0.0.0.0` só pesa no desenvolvimento.
- Procurei `API_PORT` no `.env.example`, no `AGENTS.md` e no `package.json` (`dev` roda `vite` sem flags): não aparece.

### Impacto
Agentes e pessoas partem de uma descrição errada do contrato (a regra mais mexida das últimas fases) e de instruções de configuração do agente que não existem mais na tela. Na configuração, tempo perdido com proxy do Vite e com uma variável sem efeito.

## Como reproduzir
1. Ler `docs/INDEX.md:17` e `docs/020-contratos.md:4` lado a lado.
2. No `.env`, `PORT=3002`; `pnpm dev`; abrir `http://localhost:5174`: o login falha (o proxy vai à 3001).

## Solução proposta
1. `docs/INDEX.md:17`: "**Contrato**: documento e vínculo com uma entidade (eu recebo ou eu pago), com vigência, documentos em PDF e markdown e obrigações em séries recorrentes nas contas ou no cartão; aditivo, renovação (manual ou automática pelo worker) e rescisão operam sobre as séries."
2. `README.md:38`: kit de ferramentas e "Provedor padrão"; `README.md:60`: trocar a enumeração por "veja o índice".
3. `AGENTS.md:86`: presente ("As tools dos agentes reaproveitam…").
4. Marcar "(entregue)" na 032 e na 035 do INDEX e na F21 da 015 (ou tirar a marca de todas e deixar o estado só na 015).
5. `.env.example`: acrescentar `HOST` (com `127.0.0.1` como sugestão para dev), `API_PORT`/`WEB_PORT` (ou fazer o `vite.config.ts` usar `loadEnv` e ler `PORT` da raiz), e comentários para `WEB_DIST`, `MODE`, `CNPJ_ABERTO_BASE`, `BRASILAPI_BASE`; remover `MONEYFLOW_DB_PORT` da raiz (fica no `database/.env.example`).
6. `vite.config.ts`: ler `PORT` do `.env` da raiz por `loadEnv(mode, '../..', '')`, ou corrigir o comentário.

## Critérios de aceite
- [ ] Nenhuma frase do `docs/INDEX.md`, `README.md` ou `AGENTS.md` contradiz a 020/034 nem a 021/024.
- [ ] Toda variável lida em `config.ts`, `main.ts` e `vite.config.ts` está no `.env.example`, e nenhuma do `.env.example` da raiz fica sem efeito.
- [ ] Mudar `PORT` no `.env` mantém o proxy do Vite funcionando (ou o comentário diz a verdade).

## Testes recomendados
Sem teste de código. Opcional: um teste unitário em `apps/server/test` que lê `.env.example` e confere que toda chave usada em `loadConfig` aparece nele.

## Limitações e suposições
Nada foi executado; o comportamento do Vite (não carrega `.env` de fora da raiz do projeto Vite na config) foi deduzido do código.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Conferido no código atual da integração (`fe8786d`), ponto a ponto:
1. `docs/INDEX.md:17` ainda dizia que o contrato "gera os títulos das parcelas do ciclo" e que a renovação é uma tarefa aprovada: confirmado, contra a 020/034 e o `syncLifecycle`.
2. `README.md`: "tools habilitadas, se as escritas pedem confirmação" e a enumeração das specs até a 016: confirmados. Também o botão "Atualizar tools", que hoje é "Testar e atualizar tools".
3. `AGENTS.md`: "reaproveitarão" (F4 no futuro): confirmado.
4. Marcas "(entregue)" desiguais no INDEX (029–031, 033 e 034 sim; 032 e 035 não) e a F21 sem marca na 015: confirmado.
5. `.env.example`: `HOST`, `WEB_DIST`, `CNPJ_ABERTO_BASE`, `BRASILAPI_BASE`, `MODE`, `API_PORT` e `WEB_PORT` lidos e não documentados, e `MONEYFLOW_DB_PORT` sem efeito na raiz (a porta do banco da pilha é trocada pelo `!override` do `docker/database.override.yml`): confirmados.
6. `vite.config.ts`: o comentário falava do `PORT` do `.env`, mas o código lia só `process.env.API_PORT`: confirmado.

O que mudou nesta rodada e foi conferido também: Node 26 e pnpm sem corepack, o `verify:quick` com o `related.json`, o `make release` com o `release-check`, `DB_*_MS`, `SHUTDOWN_GRACE_MS` e a validação das numéricas no boot. O `AGENTS.md` e o `.env.example` já estavam certos nesses pontos; faltavam o `README` (requisitos) e o `.claude/agents/app.md` (a heurística antiga do `verify:quick`).

## Resolução (executor)

- **Contrato** (`docs/INDEX.md`): o conceito passou a ser o da 034 ("documento e vínculo… obrigações em séries recorrentes nas contas ou no cartão; aditivo, renovação, manual ou automática pelo worker, e rescisão operam sobre as séries"). O `README` ganhou o mesmo conceito.
- **`README.md`**: o provedor com os tipos da tela, a URL base, as capacidades com o modelo padrão e o teste por capacidade; o **Kit de Ferramentas** (e o aviso de que o agente sem kit roda as tools internas sem pedir aprovação; as do MCP pedem, salvo as só de leitura); o **Provedor padrão** no agente; "Testar e atualizar tools" e as instruções do MCP; Uso e Requisições; a conciliação com IA, as tarefas agendadas, o Controle MCP e o Telegram de entrada ("Receber mensagens", `PUBLIC_BASE_URL` e o pareamento); os requisitos (Node 26, pnpm 9.12) e o `.env.example`; as specs pelo índice, sem enumerar.
- **`AGENTS.md`**: "As tools dos agentes reaproveitam os mesmos serviços, com o mesmo `Access`"; o ator `agent` "nas execuções de agente" (em vez de "na F4").
- **Marcas de entrega**: decisão, tirar a marca do INDEX e deixar o estado só na 015. A 015 diz que as fases F1–F21 estão entregues e marca a F21 ("Entregue (tarefas 046 e 047, v0.1.21)").
- **`.env.example`**:
  - `HOST=127.0.0.1` ativo, com o comentário (sem a variável, 0.0.0.0, como na imagem, que define `HOST`; 0.0.0.0 no `pnpm dev` expõe a API com o admin de senha conhecida). Decisão: a sugestão da tarefa, ativa no exemplo; o `.env` de quem já copiou não muda, e o proxy do Vite continua indo a `localhost`;
  - comentados, com o que fazem: `WEB_PORT`, `API_PORT`, `MODE`, `WEB_DIST`, `CNPJ_ABERTO_BASE` e `BRASILAPI_BASE`;
  - `MONEYFLOW_DB_PORT` saiu da raiz (fica no `database/.env.example`), com a nota de onde ficam as portas do banco;
  - `LOGIN_RATE_LIMIT` e `TRUSTED_PROXIES` saíram da seção "Docker Compose da raiz" para a da aplicação, porque a API os lê também no `pnpm dev`.
- **`apps/web/vite.config.ts`**: a configuração virou função e lê o `.env` da raiz por `loadEnv(mode, <raiz>, '')`: o proxy vai à `API_PORT` ou à `PORT` (padrão 3001) e o Vite escuta na `WEB_PORT` (5174). O ambiente vence o arquivo, como na API (`--env-file-if-exists`). Só a configuração lê essas variáveis: o `import.meta.env` do console continua só com o prefixo `VITE_` (conferido pelo `resolveConfig`: as chaves do cliente seguem `BASE_URL`, `MODE`, `DEV`, `PROD`). Conferido à mão com o `resolveConfig` do Vite: `PORT=3007` no `.env` leva o proxy à 3007; `PORT=3002` no ambiente, à 3002; `API_PORT=3009 WEB_PORT=5199`, à 3009 com o Vite na 5199.
- **`docs/001-stack-e-entrega.md`** (Configuração): o Vite com o `PORT` da raiz e a conferência do `.env.example`.
- **Agentes** (pedido da sessão principal): no `.claude/agents/app.md`, só a regra da verificação, com a da tarefa 127 (os testes de integração saem do `apps/server/test/related.json` e do teste de mesmo nome; arquivo de `apps/server/src` sem teste mapeado faz o `verify:quick` falhar com a lista, e o mapa ganha a entrada no mesmo commit, ou o teste vai depois de `--`). O `dba.md` e o `triage.md` foram conferidos só quanto aos comandos: `make test T=/tests/NNNN_area.sql`, `make dump` e `make -C database psql` existem no `database/Makefile` como descritos; nada mudou neles.

Testes (`apps/server/test/config.test.ts`, `describe('.env.example da raiz (tarefa 185)')`):
- toda variável lida por `config.ts`, `health.ts`, `main.ts` e `vite.config.ts` (`env.X` e `intEnv(env, 'X', …)`) está no `.env.example`, ativa ou comentada;
- toda chave do `.env.example` é lida pelo código ou pelo compose da raiz (sem contar as portas do compose do banco, trocadas pelo override).

Os dois pegam a regressão: com `MONEYFLOW_DB_PORT` de volta e sem `HOST`, falham citando cada uma. O `test/related.json` ganhou `.env.example`, `apps/web/vite.config.ts`, `docker-compose.yml` e `docker/database.override.yml` → `test/config.test.ts`.

Verificação: rápida, `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_docs pnpm verify:quick --base fe8786d` e `pnpm lint`; todos os links relativos dos `.md` alterados existem.
