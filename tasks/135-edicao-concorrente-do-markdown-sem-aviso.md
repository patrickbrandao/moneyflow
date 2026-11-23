---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: d658050
---

# Markdown do contrato: a última gravação vence sem aviso (edição concorrente e tool aprovada depois)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** concorrência otimista nas versões
- **Arquivos afetados:** `apps/server/src/services/contract-documents.ts:297-310`, `packages/shared/src/schemas/contracts.ts:309`, `apps/server/src/agents/tool-handlers-operation.ts:478-510`, `apps/web/src/components/contracts/DocumentView.tsx:128`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se duas pessoas editam o mesmo documento markdown do contrato, ou se uma pessoa edita enquanto o agente espera aprovação para salvar o texto dele, quem salva por último apaga, na versão atual, o que o outro acabou de escrever, sem nenhum aviso. Nada se perde de vez, porque as versões ficam no histórico, mas ninguém percebe que precisa restaurar e mesclar.

### Evidência e análise técnica
- `contractVersionCreateInput` é só `{ content, note }` (`schemas/contracts.ts:309`), sem a versão em que a edição se baseou.
- `saveVersion` trava o documento e compara o conteúdo novo com o atual só para recusar "sem mudanças" (`contract-documents.ts:304-307`). Depois grava a versão N+1 com o texto recebido, mesmo que a atual já não seja a que o editor abriu.
- Na tool `save_contract_markdown`, a prévia mostra "Versão 3 → 4" e o diff contra o conteúdo do momento da prévia (`tool-handlers-operation.ts:481-491`). A execução, que pode vir minutos depois, na aprovação, chama `saveVersion` com o texto do agente (`tool-handlers-operation.ts:510`). Se um humano salvou a versão 4 nesse intervalo, o agente grava a 5 sem as mudanças dele, e o cartão de aprovação mostrou um diff que já não vale.

### Verificação (tentativa de refutação)
- O banco garante versões imutáveis e numeração sequencial, mas não detecta o conflito.
- A spec 020 ("Documentos") pede versões imutáveis e restaurar, sem falar de concorrência. Por isso o registro é como melhoria, e não como bug.

### Impacto
Edições silenciosamente revertidas na versão atual de cláusulas de contrato. O caso mais provável é o do agente com aprovação, porque o intervalo entre a prévia e a execução é longo.

## Como reproduzir
1. Abrir o editor do documento (versão 3) em duas abas.
2. Salvar na aba A (vira a 4) e depois na aba B (vira a 5, sem as mudanças da A).

## Solução proposta
- Acrescentar `baseVersionId` (opcional, para não quebrar clientes) em `contractVersionCreateInput`. Em `saveVersion`, dentro da trava, se `current_version_id <> baseVersionId`, responder 409 `version_conflict` com a versão atual.
- A tela manda o `currentVersionId` que carregou e, no 409, oferece ver o diff entre a atual e a sua.
- A tool grava o `currentVersionId` da prévia na entrada e, na execução, passa-o como `baseVersionId`. Assim o resultado volta como erro ao agente, que relê.

## Critérios de aceite
- [ ] Salvar com `baseVersionId` diferente da atual devolve 409 e não cria versão.
- [ ] A tool aprovada depois de uma gravação humana falha com conflito em vez de sobrescrever.

## Testes recomendados
`apps/server/test/contracts.test.ts`, no `describe('documentos')`: duas gravações com o mesmo `baseVersionId`, a segunda recebe 409. Em `test/agent-tools.test.ts`: prévia de `save_contract_markdown`, gravação humana, depois a execução, que deve voltar com conflito.

## Limitações e suposições
Nada foi executado. A tela manda só `{ content: draft, note }` (`apps/web/src/components/contracts/DocumentView.tsx:128`), sem detectar a mudança por conta própria.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `contractVersionCreateInput` era só `{ content, note }`, e `saveVersion` gravava a versão N+1 mesmo com a atual diferente da aberta. A tool `save_contract_markdown` executava na aprovação sem conferir o que mudou desde a prévia.

## Resolução (executor)

- `packages/shared/src/schemas/contracts.ts`: `baseVersionId` opcional em `contractVersionCreateInput`.
- `apps/server/src/services/contract-documents.ts`: `saveVersion(ctx, doc, input, { unchangedSince })`, dentro da trava do documento. Responde 409 `version_conflict` (`t.contracts.documents.versionConflict`, com o número da atual) quando a atual não é a `baseVersionId`, ou quando foi gravada depois de `unchangedSince`. Nada é gravado.
- `apps/server/src/agents/tool-handlers-operation.ts`: a prévia de `save_contract_markdown` recusa uma `baseVersionId` que já não é a atual. Na execução, a hora da confirmação (`ai_tool_confirmations.created_at`, a da prévia) vai como `unchangedSince`, e a tool aprovada depois de outra gravação volta ao agente como erro. `packages/shared/src/agents/tools-operation.ts`: `baseVersionId` no schema da tool, para o agente mandar a versão lida.
- `apps/web/src/components/contracts/DocumentView.tsx`: o editor guarda a versão em que a edição começou e a manda ao salvar. No 409, recarrega a atual, mantém o rascunho e mostra o aviso com "Salvar por cima da atual". Textos em `packages/shared/src/i18n/areas/contracts.ts`.
- `docs/020-contratos.md` ("Documentos").
- Testes: `apps/server/test/contracts.test.ts`, no caso de documentos, faz duas gravações com a mesma base (a segunda recebe 409). `apps/server/test/agent-tools.test.ts`, no caso dos contratos, deixa a confirmação pendente, faz uma gravação humana, aprova e confere o erro de conflito. Também confere a `baseVersionId` antiga recusada já na prévia. A tela não tem e2e; o caminho dela foi conferido pelo typecheck.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
