---
status: aberta
tipo: debito-tecnico
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# `pnpm lint` falha quando há uma pasta solta com `biome.json` (hoje, `tmp/`)

- **Severidade:** baixa
- **Confiança:** confirmado (executado)
- **Categoria:** DX
- **Subcategoria:** escopo do Biome
- **Arquivos afetados:** `biome.json:8-10`, `.gitignore`, `package.json:15-16`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O comando que confere o estilo do código para de funcionar se existir, na raiz do projeto, qualquer pasta de rascunho que traga a sua própria configuração do Biome. Hoje existe uma (`tmp/`), então `pnpm lint` e a verificação completa falham nesta máquina sem que o código tenha erro algum.

### Evidência e análise técnica
`pnpm lint` roda `biome check .` (`package.json:15`). O `biome.json` inclui `**` e só exclui `database`, `dist`, `node_modules`, `playwright-report` e `test-results` (`biome.json:9`). A pasta `tmp/` não está no `.gitignore` (`git status` mostra `?? tmp/`) e contém `tmp/web-interface-admin-with-canva-v2/template/biome.json`. Resultado em 2026-11-21:

```
tmp/web-interface-admin-with-canva-v2/template/biome.json configuration
  × Found a nested root configuration, but there's already a root configuration.
  × Biome exited because the configuration resulted in errors.
 ELIFECYCLE  Command failed with exit code 1.
```

### Verificação (tentativa de refutação)
- As pastas `.claude/worktrees/*` também têm `biome.json`, mas estão em `.git/info/exclude` e o Biome respeita o ignore do git (`vcs.useIgnoreFile`). Por isso só a `tmp/` quebra.
- O CI não é afetado, porque a `tmp/` não é versionada. O `pnpm verify:full` local é.
- O `verify:quick` passa só os arquivos alterados ao Biome, mas um arquivo novo dentro de uma pasta solta entra na lista (arquivos novos contam).

### Impacto
`pnpm lint`, `pnpm format` e `pnpm verify:full` falham na máquina de quem tiver uma pasta assim. `pnpm format` (`biome check --write .`) também reescreveria arquivos de qualquer pasta solta sem `biome.json`.

## Como reproduzir
Com a `tmp/` atual na raiz: `pnpm lint`.

## Solução proposta
- Acrescentar `tmp/` ao `.gitignore` (o Biome passa a ignorá-la pelo `useIgnoreFile`).
- Opcional, mais firme: trocar o `includes` do `biome.json` por uma lista positiva (`apps/**`, `packages/**`, `e2e/**`, `scripts/**` e os arquivos da raiz), para que nenhuma pasta nova entre sem querer.

## Critérios de aceite
- [ ] `pnpm lint` passa com a `tmp/` presente.

## Testes recomendados
Rodar `pnpm lint` com uma pasta `tmp/x/biome.json` criada à mão.

## Limitações e suposições
Não verifiquei o que a `tmp/` guarda além do template da skill do console; se ela não tiver mais uso, apagar resolve nesta máquina, mas não evita a próxima.

## Análise (triagem)

## Resolução (executor)
