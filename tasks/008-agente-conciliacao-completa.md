---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-13
commit: b3519ae
---

# Agente concilia um lote inteiro do extrato (espelho, pagadora, desfazer, ignorar, candidatos e lote)

## Descrição
O usuário quer que o agente de IA localize, classifique e publique no extrato oficial (os movimentos da conta) todas as linhas de um lote de conciliação, vinculando recebedor e pagador, inclusive aprovando sozinho (agente com `require_write_confirmation` desligado). As tools de conciliação de hoje (`match_statement_line`, `confirm_statement_lines`, `create_from_statement_line`, `classify_statement_lines`, `apply_classification_suggestions`) não bastam:

1. `create_from_statement_line` no modo `title` cria o título **sem espelho** (`reconciliation.ts` passa `null` a `insertTitlePair`), ao contrário de `create_title` (caixa principal da entidade por padrão, spec 006). No modo `purchase`, o handler fixa `payerCaixaId: null` (sempre a pagadora padrão do cartão), embora o serviço aceite a pagadora.
2. Não há tool para desfazer uma conciliação errada (`rec.unmatchLine`) nem para ignorar/voltar linhas (`rec.setIgnored`).
3. Não há tool de leitura dos candidatos de uma linha (`rec.lineCandidates`), que a tela usa para casar à mão.
4. `match_statement_line` e `create_from_statement_line` são uma linha por chamada: um extrato de centenas de linhas exige centenas de chamadas (e de cartões "Aplicar?").

## Como reproduzir
Importar um OFX numa conta e pedir ao agente para lançar uma linha sem título cuja entidade é titular de uma caixa: o título nasce sem espelho. Pedir para lançar uma linha de fatura de cartão numa caixa pagadora diferente da padrão: não há como. Pedir para desfazer um casamento errado: nenhuma tool.

## Análise (triagem)
Só aplicação: `packages/shared` (schemas e `AGENT_TOOLS`), `apps/server/src/services/reconciliation.ts`, `titles.ts` (reaproveitar `resolveMirror`) e `apps/server/src/agents/tool-handlers.ts`. Specs 009 e 011. Executor: app.

## Resolução (executor)
- `lineCreateInput` (shared) ganhou `mirrorCaixaId` e `mirrorCategoryId` (mesma semântica de `titleCreateInput`: omitido = caixa principal da entidade, `null` = sem espelho). `createFromLine` no modo `title` usa `resolveMirror` (exportado de `titles.ts`) e o título baixado nasce espelhado, com a baixa de duas pernas (a do espelho fica "conta a definir"). Vale também para a tela (`POST /api/statement-lines/:id/create`), conforme a spec 006; o texto de ajuda do modo foi atualizado.
- `create_from_statement_line` aceita `payerCaixaId` (compra) e `mirrorCaixaId`/`mirrorCategoryId` (título); a prévia mostra a caixa pagadora, o espelho e os avisos.
- Tools novas: `list_line_candidates` (leitura, `rec.lineCandidates`), `unmatch_statement_line` (destrutiva; a prévia mostra o alvo atual e avisa que a baixa/movimento criados ficam), `ignore_statement_lines` e `unignore_statement_lines` (lote, `setIgnoredLines`), `match_statement_lines` e `create_from_statement_lines` (lote até 500). As singulares continuam (agentes têm allowlist de tools por nome).
- Serviço: `eachLine` (uma transação, savepoint por linha, checagens deferidas forçadas ao fim de cada linha) passa a servir `confirmLines`, `matchLines`, `createFromLines` e `setIgnoredLines`; falhas voltam em `failed` com o motivo. `applyMatch` agora recusa casamento sem alvo (ou com mais de um) com `t.errors.lineMatchTarget`, em vez de não fazer nada.
- Testes (`apps/server/test/agents.test.ts`, "conciliação pelo agente", agente sem confirmação e provedor falso): lote com título baixado espelhado na caixa B, título sem espelho, movimento avulso e falha isolada; título em aberto casado em lote vira baixa; ignorar/voltar; candidatos da linha; casamento errado desfeito (prévia e aviso) e refeito; compra da fatura na caixa pagadora escolhida; auditoria com ator `agent`.
- Specs: 009 (lançar a partir da linha, desfazer e ignorar) e 011 (lista de tools e lotes).
- Fora do escopo: o agente não tem tool para estornar a baixa criada por um casamento errado (`reverseSettlement`; resolvido na tarefa 010), e a tela de lançar a partir da linha ainda não deixa escolher/dispensar o espelho (resolvido na tarefa 009).
