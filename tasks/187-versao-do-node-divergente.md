---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Node 26 no desenvolvimento, 22 no CI e na imagem, `@types/node` 26 e `corepack enable` que não existe mais

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** versão do runtime e do gerenciador de pacotes
- **Arquivos afetados:** `package.json:6-9`, `apps/server/package.json:33`, `packages/shared/package.json:18`, `packages/db/package.json:18`, `e2e/package.json:13`, `apps/server/build.mjs:13`, `Dockerfile:6-10`, `.github/workflows/ci.yml:19-21`, `.github/workflows/ci.yml:71-73`, `AGENTS.md:27`, `AGENTS.md:50`, `e2e/fakes/fake-llm.ts:516`
- **Depende de / relacionado a:** tarefa 184 (fixar a base da imagem)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O código é escrito e testado num Node bem mais novo do que o que roda em produção, e os tipos do TypeScript são os do Node novo. Uma função que só existe no Node novo passa em tudo localmente e quebra na produção. E a instrução de instalação do projeto manda usar um comando que o Node novo já não traz.

### Evidência e análise técnica
- `package.json:7-9`: `"engines": { "node": ">=22.12.0" }`, sem teto, sem `.nvmrc`/`.node-version`/`.tool-versions` e sem `engine-strict`. A máquina de desenvolvimento tem `node v26.13.1`; o CI usa `node-version: 22` (`ci.yml:21`, `:73`), a imagem `ARG NODE_VERSION=22` (`Dockerfile:6`) e o bundle `target: 'node22'` (`build.mjs:13`).
- Todos os pacotes têm `@types/node` **26.6.5** (`apps/server/package.json:33`, `packages/shared/package.json:18`, `packages/db/package.json:18`, `e2e/package.json:13`). O `tsc` aceita APIs do Node 23–26; o `esbuild` com `target: node22` só rebaixa sintaxe, não APIs. Um uso novo passa no typecheck e nos testes locais (Node 26) e só quebra no CI, se o caminho tiver teste, ou na produção.
- `AGENTS.md:27`: "Node 22.12+ e pnpm 9 (`corepack enable`)". O Node 25 deixou de trazer o corepack; na máquina, `corepack: command not found` (o `pnpm` vem do Homebrew). O `Dockerfile:10` (`RUN corepack enable`) também quebra no dia em que `NODE_VERSION` subir para 26 (o próximo LTS).
- `AGENTS.md:50`: `node e2e/fakes/fake-llm.ts 18082`. Rodar `.ts` direto só funciona sem flag a partir do 22.18 (ou 23.6); o próprio arquivo documenta `node --experimental-strip-types e2e/fakes/fake-llm.ts 18082` (`fake-llm.ts:516`). Com 22.12–22.17, que o `engines` permite, o comando do `AGENTS.md` falha.

### Verificação (tentativa de refutação)
- Procurei usos de APIs posteriores ao Node 22 (`fs.glob`, `URLPattern`, `RegExp.escape`, `Error.isError`, `Float16Array`, `Uint8Array.fromBase64`, `zstd`, `process.getBuiltinModule`, `Promise.try`…) em `apps/server/src`, `packages/*/src`, `e2e` e nos testes: nenhum. Hoje não há quebra; o achado é o risco e a instrução errada.
- O `lib: ["ES2023"]` do `tsconfig.base.json` já barra as APIs ECMAScript novas; o buraco é só nas APIs do Node, que vêm do `@types/node`.

### Impacto
Risco de regressão "funciona na minha máquina" que só aparece em produção; instrução de setup quebrada para quem segue o `AGENTS.md` com o Node atual; atualização futura da base da imagem quebrando o build.

## Como reproduzir
1. `node --version` (26.x) e `corepack --version` → comando não encontrado.
2. Num arquivo do servidor, use o `URLPattern` global (tipado no `@types/node@26`, `url.d.ts:459`, e ausente como global no Node 22): `pnpm typecheck` passa, `pnpm test:local` passa no Node 26, e o bundle falha ao subir no `node:22`.

## Solução proposta
1. `.nvmrc` com `22` (ou decidir subir para 24 LTS em tudo) e `node-version-file: .nvmrc` no `setup-node` do CI.
2. `engines.node: ">=22.18 <23"` (ou `^22.18 || ^24`) e `.npmrc` com `engine-strict=true`, para o `pnpm install` recusar o Node errado.
3. `@types/node` na mesma major do runtime (`22.x`) em todos os pacotes.
4. Trocar `corepack enable` no `AGENTS.md` por "instale o pnpm 9.12 (`npm i -g pnpm@9.12.0` ou o gerenciador do sistema)"; no `Dockerfile`, `RUN npm i -g pnpm@9.12.0` (ou fixar o corepack: `npm i -g corepack`).
5. `AGENTS.md:50`: usar o mesmo comando do arquivo (`node --experimental-strip-types …`) ou subir o mínimo para 22.18.

## Critérios de aceite
- [ ] Desenvolvimento, CI e imagem na mesma major do Node, declarada num único lugar.
- [ ] `@types/node` na major do runtime.
- [ ] As instruções de instalação funcionam com a versão declarada.

## Testes recomendados
`pnpm install` com um Node fora do `engines` deve falhar; `pnpm typecheck` com um `URLPattern` de teste deve falhar depois do `@types/node@22`.

## Limitações e suposições
A data exata de remoção do corepack (Node 25) e do strip-types sem flag (22.18) é de memória, não conferida na rede; a ausência do corepack no Node 26 desta máquina foi conferida.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código atual: `engines.node` `>=22.12.0` sem teto, sem `.nvmrc` nem `engine-strict`; CI e imagem no 22 (`node-version: 22`, `ARG NODE_VERSION=22`), bundle `target: 'node22'`, `@types/node` 26.6.5 nos quatro pacotes; `corepack: command not found` na máquina (Node 26.13.1, pnpm 9.12.0 do Homebrew); `RUN corepack enable` no `Dockerfile`.

## Resolução (executor)

Decisão: subir tudo para o **Node 26** (a versão desta máquina, LTS desde outubro de 2026 e a major do `@types/node` que já estava em todos os pacotes), em vez de descer o desenvolvimento e os tipos para o 22. A versão fica num lugar só, o `.nvmrc`, e o resto é conferido contra ele.

- `.nvmrc`: `26.13.1`. `package.json`: `engines.node` `>=26.13.0 <27`. `.npmrc` novo com `engine-strict=true`.
- CI (`ci.yml`): `node-version-file: .nvmrc` nos dois `setup-node`.
- `Dockerfile`: base `node:26.13.1-bookworm-slim` pelo digest (junto com a tarefa 184). O `corepack enable` saiu: o pnpm é instalado por `npm install -g` na versão do `packageManager` do `package.json`. O `.npmrc` entra no build.
- `apps/server/build.mjs`: `target: 'node26'`. `@types/node` continua 26.6.5, agora a major do runtime.
- `AGENTS.md`: Node 26 do `.nvmrc` e o pnpm 9.12 por `npm i -g pnpm@9.12.0` ou pelo gerenciador do sistema, sem o corepack. O `node e2e/fakes/fake-llm.ts 18082` funciona sem flag no Node 26; o comentário do arquivo foi alinhado.
- `scripts/check-versions.mjs` (novo, roda no job `check` do CI): falha se a imagem, o `engines`, o `target` do bundle ou o `@types/node` de qualquer pacote saírem da versão/major do `.nvmrc`, ou se um workflow usar `node-version` solto.

Testes:
- `scripts/check-versions.test.mjs` (`pnpm test:scripts`, `node --test`): imagem, engines, target e `@types/node` fora da major são acusados, o `.nvmrc` exige X.Y.Z, e o repositório passa.
- À mão: com `engines.node` trocado para `>=27.0.0 <28`, o `pnpm install --frozen-lockfile` recusou o Node 26.13.1 (`ERR_PNPM_UNSUPPORTED_ENGINE`); o arquivo voltou ao valor certo.
- Não rodei o build da imagem (fora do permitido nesta frente). O digest foi conferido com `docker buildx imagetools inspect node:26.13.1-bookworm-slim`.

Verificação: rápida, `pnpm verify:quick --base 290403d` (só o que esta frente mudou; o portão do lint, o typecheck de todos os pacotes e os testes de integração tocados no Postgres local), `pnpm test:scripts` e o build do servidor com o target `node26`.
