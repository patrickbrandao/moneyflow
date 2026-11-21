---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# `verify:quick` sai verde sem rodar teste nenhum na maior parte das mudanças do servidor

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** heurística da verificação rápida
- **Arquivos afetados:** `scripts/verify.mjs:96-100`, `scripts/verify.mjs:128-136`, `scripts/verify.mjs:151-183`, `AGENTS.md:21`, `.claude/agents/app.md:16`
- **Depende de / relacionado a:** tarefa 126
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A verificação rápida, que os agentes rodam antes de dizer "pronto", procura o teste pelo nome do arquivo alterado. Como quase nenhum arquivo do servidor tem um teste com o mesmo nome, ela pula os testes e termina com sucesso. O agente vê "verificação rápida passou" sem que nada tenha sido testado.

### Evidência e análise técnica
O mapeamento é `src/.../x.ts` → `test/x.test.ts` (`scripts/verify.mjs:154-159`). Contei com `git ls-files 'apps/server/src/*.ts'`: dos 116 arquivos, só 23 têm um `test/<mesmo nome>.test.ts`. Ficam sem teste, por exemplo:

| Arquivo alterado | Onde está o teste de verdade |
|---|---|
| `services/reconciliation.ts` (981 linhas) | `test/statements.test.ts` |
| `services/series.ts`, `series-core.ts`, `line-settle.ts`, `card-charges.ts` | `test/contracts.test.ts`, `test/statements.test.ts` |
| `agents/runner.ts`, `tools-runtime.ts`, `prompt.ts` | `test/agents.test.ts`, `test/agent-prompts.test.ts` |
| `agents/tool-handlers-operation.ts` (1.322), `tool-handlers-admin.ts` (1.201) | `test/agent-tools.test.ts`, `test/agent-tools-admin.test.ts` |
| `services/tx.ts`, `authz/access.ts`, `auth/session.ts` | `test/permissions.test.ts`, `test/auth.test.ts` |
| `services/backup/import.ts`, `export.ts`, `dump.ts` | `test/backup.test.ts` |
| `services/message-worker.ts`, `telegram-inbound.ts`, `agent-tasks.ts` | `test/vision.test.ts`, `test/autonomous.test.ts` |

Quando nada casa, o passo vira `skip` (`verify.mjs:174-175`) e `summary` só falha se algum passo deu `false` (`verify.mjs:77`): pulado conta como sucesso.

Outros buracos concretos:
1. **Mudança no `packages/shared`** roda só `vitest related` do shared (`verify.mjs:137-149`); os testes de integração que dependem da regra (por exemplo `shared/src/reconcile.ts` → `test/statements.test.ts` e `test/contracts.test.ts`) não rodam.
2. **Migration sem pgTAP alterado** é só "pulado" (`verify.mjs:181-182`) e não dispara nenhum teste de integração, embora o modelo local seja refeito por hash (`apps/server/test/local-db.ts:25-39`).
3. **Arquivo apagado** some da lista por causa do `existsSync` (`verify.mjs:99`): uma mudança que só apaga `services/x.ts` dá "Nada a verificar" e nem o typecheck roda, mesmo com importadores quebrados.
4. **`biome.json` alterado** não está em `ROOT_CONFIG` (`verify.mjs:36`): só o próprio `biome.json` é verificado, e uma regra nova não é aplicada ao resto do repositório.
5. **Ajudantes de teste** (`apps/server/test/helpers.ts`, `test/fakes/fake-mcp.ts`, `e2e/fakes/fake-llm.ts`, usados pela integração) não mapeiam para nenhum teste.

Não há hook de pre-commit no repositório (nenhum husky/lefthook; `.git/hooks` só com `.sample`), então a verificação é só a que o agente lembra de rodar.

### Verificação (tentativa de refutação)
- `AGENTS.md:21` admite a heurística e manda passar o teste depois de `--`; `.claude/agents/app.md:16` repete. Mas a saída do script diz apenas "pulado: nenhum test/*.test.ts alterado…" no meio do resumo e devolve código 0, então nada força o agente a fazer isso.
- `vitest related` no servidor não resolveria: todo teste importa `helpers.ts` → `buildApp` → todas as rotas e serviços, e o grafo marcaria a suíte inteira. Por isso a heurística por nome existe; o problema é ela ser silenciosa.

### Impacto
Agentes fecham tarefas com "verify:quick passou" depois de mexer em conciliação, séries ou agentes sem rodar o teste da área. O erro só aparece no CI (ou no `verify:full`, que só roda quando pedido), longe da mudança.

## Como reproduzir
1. Num branch, altere uma linha de `apps/server/src/services/reconciliation.ts`.
2. `pnpm verify:quick` → lint e typecheck rodam; "Testes de integração (pulado: …)"; código de saída 0.
3. Apague `apps/server/src/services/planned-account.ts` (sem mexer nos importadores) → "Nada a verificar."

## Solução proposta
1. Um mapa explícito e versionado `apps/server/test/related.json` (arquivo ou pasta de `src` → testes), mantido junto com o `AGENTS.md`, consultado antes do fallback por nome. Exemplo: `"services/reconciliation.ts": ["test/statements.test.ts"]`, `"services/series*.ts": ["test/contracts.test.ts", "test/statements.test.ts"]`, `"agents/tool-handlers-*.ts": ["test/agent-tools.test.ts", "test/agent-tools-admin.test.ts"]`.
2. Se ainda assim um arquivo de `apps/server/src` ou `packages/shared/src` mudou e nenhum teste de integração foi escolhido, **falhar** (código 2) com a lista dos arquivos sem teste, a menos que `--sem-integracao` seja passado de propósito.
3. Incluir no mapa os arquivos do shared consumidos pela integração (`reconcile.ts`, `supersede.ts`, `contracts.ts`, `recurrence.ts`, `messages.ts`).
4. Considerar os apagados: usar `git diff --name-only --diff-filter=D` para marcar o pacote como tocado (typecheck dos dependentes).
5. `biome.json` no `ROOT_CONFIG` do lint (lint completo quando ele muda).
6. Opcional: hook de pre-commit (lefthook) com `biome check --staged`.

### Diff/patch proposto — NÃO APLICADO
```js
// scripts/verify.mjs
const deleted = git('diff', '--name-only', '--diff-filter=D', base).split('\n').filter(Boolean);
const touched = [...new Set([...files, ...deleted].map(packageOf).filter(Boolean))];
...
if (serverArgs.length === 0 && files.some((f) => /^(apps\/server|packages\/shared)\/src\//.test(f)) && !flag('--sem-integracao')) {
  results.push({ label: 'Testes de integração', ok: false, secs: '0' });
  console.error('Nenhum teste escolhido para:', files.filter(...).join(', '), '→ passe-os depois de `--` ou atualize test/related.json');
}
```

## Critérios de aceite
- [ ] Alterar `services/reconciliation.ts` roda `test/statements.test.ts` sem argumento extra.
- [ ] Alterar um arquivo de `src` sem teste mapeado faz o `verify:quick` falhar com a lista, não passar.
- [ ] Apagar um arquivo de `src` roda o typecheck do pacote e dos dependentes.
- [ ] Mudar `biome.json` roda o lint do repositório inteiro.

## Testes recomendados
Um teste do próprio script (`scripts/verify.test.mjs` com `node --test`) chamando a função de seleção com listas de arquivos fictícias: `services/reconciliation.ts`, `packages/shared/src/reconcile.ts`, um arquivo apagado e `biome.json`.

## Limitações e suposições
Não executei o `verify:quick` (rodaria testes contra o Postgres local, fora do permitido nesta revisão); a análise é da leitura do script e da contagem de arquivos. Os testes apontados no mapa de exemplo foram achados por `grep` e podem não ser os únicos.

## Análise (triagem)

## Resolução (executor)
