---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# E2E: arquivos rodam em paralelo na mesma pilha e o agente ativo de um spec muda o resultado dos outros

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** teste
- **Subcategoria:** isolamento e flakiness dos e2e
- **Arquivos afetados:** `e2e/playwright.config.ts:8-24`, `e2e/tests/agentes.spec.ts:119-176`, `e2e/tests/visao.spec.ts:160-249`, `e2e/tests/operacao.spec.ts:86-89`, `e2e/tests/operacao.spec.ts:173-187`, `e2e/tests/anotacoes.spec.ts:114`, `e2e/fakes/fake-llm.ts:504`, `e2e/fakes/fake-telegram.ts:196`, `apps/server/src/services/ai-flows.ts:36-47`, `apps/server/src/routes/statements.ts:75`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Os testes de tela rodam vários arquivos ao mesmo tempo contra o mesmo sistema. Enquanto o teste dos agentes está rodando, qualquer outro teste que importa um extrato aciona, sem querer, o agente de IA de teste, e o resultado muda conforme a ordem e a velocidade da máquina. Os próprios testes já têm remendos para isso, o que esconde o problema em vez de resolvê-lo.

### Evidência e análise técnica
1. **Paralelismo entre arquivos.** `playwright.config.ts` define `fullyParallel: false` mas não define `workers` (`e2e/playwright.config.ts:8-24`). No Playwright 1.64 o padrão é `"50%"` dos CPUs (`node_modules/.pnpm/playwright@1.64.0/.../lib/common/index.js:534`, `resolveWorkers(... userConfig.workers, "50%")`). `fullyParallel: false` só serializa os testes dentro de um arquivo; arquivos diferentes vão para workers diferentes, todos contra a mesma pilha e o mesmo banco. Numa máquina de desenvolvimento com 12 núcleos são 6 arquivos ao mesmo tempo; no runner do GitHub, 1 ou 2.
2. **Estado global criado por um spec e lido pelos outros.** `agentes.spec.ts` cria no `beforeAll` um provedor e um agente **ativos** apontando para o provedor falso (`agentes.spec.ts:139-160`), e `visao.spec.ts` faz o mesmo para o Telegram (`visao.spec.ts:170-187`). O "agente dos fluxos" é o marcado **ou o primeiro ativo com provedor ativo** (`ai-flows.ts:36-47`), e toda importação de extrato chama `suggestImportClassifications(..., { auto: true })` (`routes/statements.ts:75`). Resultado: enquanto um desses specs está no ar, os imports de `operacao`, `conta`, `conciliacao-provisoria`, `contratos` e `contratos-pagamentos` enfileiram uma execução do agente de teste, que sugere entidade e categoria nas linhas.
3. **Os remendos confirmam o vazamento.** `operacao.spec.ts:87-89`: "Com um agente dos fluxos configurado (outros testes), a linha pode chegar com a entidade sugerida e travada", seguido de `if (await swapEntity.isVisible()) await swapEntity.click();`. `operacao.spec.ts:173-187`: espera a execução do agente e limpa as sugestões `classificationSource === 'agent'` antes de testar o "Aplicar regras". O `isVisible()` não espera: se a sugestão do agente chega depois da checagem, o campo Entidade já está travado e o `fill` seguinte falha. O mesmo padrão aparece em `anotacoes.spec.ts:114`.
4. **Portas fixas sem tratamento de erro.** Os falsos sobem em 18081–18083 com `server.listen(port, host, resolve)` sem ouvinte de `error` (`fake-llm.ts:504`, `fake-telegram.ts:196`). Se a porta estiver ocupada (por exemplo, o `node e2e/fakes/fake-llm.ts 18082` que o `AGENTS.md:50` manda rodar à mão), o `EADDRINUSE` vira exceção não tratada e derruba o worker do Playwright em vez de uma mensagem clara.
5. **Sobras entre execuções locais.** A pilha local não é zerada entre execuções (só o CI faz `down -v`, `ci.yml:87`). Se uma execução é interrompida antes do `afterAll` (`agentes.spec.ts:167-176`), o agente e o provedor continuam ativos apontando para uma porta morta, e todo import seguinte enfileira uma execução que falha depois das tentativas.

### Verificação (tentativa de refutação)
- Conferi o padrão de `workers` no código instalado do Playwright (citado acima): é 50% dos CPUs, não 1.
- Conferi se os specs de import desligam a IA: nenhum cria a conta com algo que impeça a sugestão; a sugestão automática depende só de existir um agente ativo (`ai-flows.ts:140-146`).
- O `afterAll` desativa os agentes, e `isActive: false` também limpa `use_for_flows` (`ai-admin.ts:652-653`); então o vazamento é durante a execução concorrente e nas execuções interrompidas, não depois de uma execução completa.
- Com 1 worker (runner de 2 vCPUs) a ordem alfabética põe `agentes.spec.ts` primeiro e o `afterAll` limpa antes dos demais, mas `visao.spec.ts` (último) e qualquer máquina com mais núcleos reabrem o problema.

### Impacto
Falhas intermitentes que dependem do número de núcleos e da ordem dos arquivos, mais difíceis de reproduzir no CI do que na máquina do desenvolvedor; e testes cheios de `if` que deixam de testar o caminho pretendido (o teste de "Aplicar regras" só funciona porque apaga o que o agente fez).

## Como reproduzir
1. Pilha no ar com `TELEGRAM_API_BASE` apontando para a Bot API falsa.
2. Numa máquina com 8 ou mais núcleos: `pnpm e2e` (6+ workers). Rodar algumas vezes.
3. Observar nos logs do worker da pilha execuções de agente com `purpose` de sugestão disparadas por imports de `operacao`, `conta` e `contratos` enquanto `agentes.spec.ts` está rodando; e, de vez em quando, o `fill` da Entidade em `operacao.spec.ts:90` falhando.
4. Para o item 4: deixar `node e2e/fakes/fake-llm.ts 18082` rodando e chamar `pnpm e2e`.

## Solução proposta
1. Tornar a execução determinística: `workers: 1` no `playwright.config.ts`, ou dois projetos — `operacao` (todos os specs sem IA, em paralelo) e `ia` (`agentes`, `visao`) com `dependencies: ['operacao']` e `workers: 1` — para que nenhum agente de teste exista enquanto os imports rodam.
2. `globalSetup`/`globalTeardown` desativando pela API qualquer provedor e agente com nome `E2E%` que tenha sobrado ativo.
3. Remover os remendos (`operacao.spec.ts:87-89`, `:173-187`) depois do item 1, e trocar `if (await x.isVisible())` por uma espera explícita do estado esperado.
4. Nos falsos, `server.once('error', reject)` antes do `listen`, com a mensagem "porta 18082 ocupada: pare o fake-llm manual".

### Diff/patch proposto — NÃO APLICADO
```ts
// e2e/playwright.config.ts
  fullyParallel: false,
  // A pilha é uma só: arquivos em paralelo dividem o banco e o agente dos fluxos (o primeiro ativo).
  workers: 1,
```
```ts
// e2e/fakes/fake-llm.ts (idem fake-telegram.ts)
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
});
```

## Critérios de aceite
- [ ] Nenhum spec que importa extrato vê sugestão de agente criado por outro spec.
- [ ] Os remendos de `operacao.spec.ts` saem e o teste continua passando.
- [ ] Porta ocupada gera erro claro no `beforeAll`, sem derrubar o worker.
- [ ] Uma execução interrompida não deixa agente `E2E` ativo para a próxima.

## Testes recomendados
`pnpm e2e` três vezes seguidas numa máquina com muitos núcleos, e uma vez com `--repeat-each=3` em `operacao.spec.ts`, sem falha.

## Limitações e suposições
Nada foi executado (e2e fora do escopo desta revisão). O número de vCPUs do runner depende de o repositório ser público (4) ou privado (2). A falha intermitente do item 3 é inferida pela ordem das chamadas, não foi observada.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código atual:
- `playwright.config.ts` sem `workers`;
- `agentes.spec.ts` e `visao.spec.ts` criam provedor e agente ativos;
- o agente dos fluxos é o primeiro ativo (`flowAgentId`), e o import chama `suggestImportClassifications(…, { auto: true })`;
- os remendos de `operacao.spec.ts` (o `if (await swapEntity.isVisible())` e a limpeza das sugestões `agent` antes do "Aplicar regras");
- o `server.listen` dos dois falsos sem ouvinte de `error`.

O `anotacoes.spec.ts:114` não é vazamento de agente: é o popover do alarme, que o clique no título (fora dele) fecha pelo `useClickOutside`. O `if` escondia esse fechamento, que é determinístico.

## Resolução (executor)

1. **Um arquivo por vez**: `workers: 1` no `e2e/playwright.config.ts`, com o motivo no comentário. Decisão: a opção mais simples da tarefa, em vez dos dois projetos com `dependencies`. Com 1 worker os arquivos rodam em ordem; o `afterAll` do `agentes.spec.ts` desliga o agente antes dos seguintes, e o `visao.spec.ts` (o último) liga e desliga o dele dentro do próprio teste. O CI do GitHub já rodava com 1 ou 2 workers; o `timeout-minutes` do job `image` (tarefa 184) leva isso em conta.
2. **Sobras de execução interrompida**: o `e2e/global-setup.ts` desliga, pela API, os agentes e provedores ativos cujo nome começa com `E2E`. Outro agente ativo na pilha (criado à mão) não é tocado, só avisado no console.
3. **Remendos trocados por esperas do estado certo**:
   - `operacao.spec.ts`: o diálogo "Lançar a linha" não tem o "Trocar entidade" (`toHaveCount(0)`), e o import da poupança devolve `aiSuggestion` `{ queued: false, runId: null }`. Saíram a espera da execução e a limpeza das sugestões;
   - `anotacoes.spec.ts`: `await expect(popover).toBeHidden()` e o clique no ícone, no lugar do `if (!(await popover.isVisible()))`.
4. **Porta ocupada**: `fake-llm.ts` e `fake-telegram.ts` escutam com `once('error')` antes do `listen`. O `EADDRINUSE` rejeita com "a porta N está ocupada (pare o fake-llm manual…)", em vez de virar exceção solta no worker do Playwright.

Testes:
- `apps/server/test/e2e-fakes.test.ts`: os dois falsos, com a porta já ocupada por outro, rejeitam com a mensagem da porta. Passou no Postgres local.
- Os specs alterados (`operacao`, `anotacoes`) não rodaram aqui; ficam para o e2e completo da sessão principal. O critério de aceite "três vezes seguidas sem falha" também fica para essa execução.

Verificação: rápida, `pnpm verify:quick --base 290403d` (lint, typecheck do e2e e do servidor, `test/e2e-fakes.test.ts`).
