# packages/shared — tipos, regras puras e textos

Guia da pasta `packages/shared` (`@moneyflow/shared`), usada pela API, pelo worker e pelo console. Nada aqui acessa o banco. As regras gerais estão no [AGENTS.md da raiz](../../AGENTS.md). Testes unitários em `test/` (Vitest): `pnpm --filter @moneyflow/shared exec vitest run test/documents.test.ts`; o `pnpm verify:quick` roda os relacionados ao que mudou. As regras daqui que a integração da API também exercita estão no `apps/server/test/related.json`.

## Domínio

- `money.ts` (BRL em centavos inteiros, `formatAccounting`) e `dates.ts` (datas `YYYY-MM-DD`, "hoje" no fuso de São Paulo). Teste: `money-dates`.
- `period.ts`: o período padrão das listagens (60 dias atrás e 30 à frente) e os atalhos. Teste: `period`.
- `documents.ts`: CPF e CNPJ, o alfanumérico inclusive (o mesmo algoritmo do banco; recebe o valor já normalizado). Teste: `documents`.
- `pix.ts` e `address.ts`: a chave PIX como o banco a grava e o CEP. Teste: `pix-address`.
- `boleto.ts` (linha digitável e código de barras) e `brcode.ts` (PIX copia-e-cola), com a validação igual à do banco. Testes: `boleto`, `brcode`.
- `recurrence.ts`: o calendário de uma série (`occurrenceDueDate`). Teste: `money-dates`.
- `series-terms.ts`: os ajustes de reconhecimento do pagamento da série no formulário (um rascunho, uma leitura dos percentuais e um resumo; tarefa 181). Teste: `contracts`.
- `contracts.ts`: as contas puras dos contratos (specs 020 e 034): calendário pela periodicidade, fim do ciclo e meses da vigência, fim do período da ocorrência, proporcional, reajuste, prazo do aviso. Teste: `contracts`.
- `reconcile.ts`: o casamento assistido (valor, data ±3 dias, descrição) e o pagamento das séries (specs 033 e 034): `splitSettlement`, `seriesMatch`, `cardChargeMatch`, `pickSeriesOccurrences` (que `pickMatch` aplica) e o `autoSettle` do resultado. Teste: `reconcile`.
- `supersede.ts`: `pairSupersedeLines`, o casamento fixo da troca do provisório pelo consolidado (spec 031). Teste: `supersede`.
- `statement-import.ts`: os avisos da importação de extrato, iguais na tela, na prévia da tool e na resposta.
- `parsers/`: OFX 1.x/2.x com várias contas (`ofx.ts`), CSV com o mapeamento (`csv.ts`), NF-e (`nfe.ts`, chave com CNPJ alfanumérico) e o mini parser XML com limites (`xml.ts`). Testes: `ofx`, `csv`, `nfe`, `parser-limits`.
- `reports.ts`: o pivô dos relatórios (grupo → subcategoria por mês, ranking, entidade). Testes: `projection`, `vision`.
- `export.ts`: a `ExportTable` e o CSV no padrão do Excel pt-BR (o PDF é do console). Teste: `vision`.
- `messages.ts`: as mensagens do Telegram em HTML com escape, o agendamento no fuso de São Paulo e o `noteReminderMessage`. Testes: `vision`, `notes`.
- `notes.ts` (spec 035): tipos, escopos, repetições, `REMINDER_SOUNDS`/`DEFAULT_REMINDER_SOUND`, os DTOs, `describeReminder` ("todo dia 10 às 09:00"), `normalizeReminder` e `noteBadge`; as entradas Zod (nota, lembrete, listagem, calendário, disparos e preferências) ficam em `notes-input.ts`, para o Zod não ir ao arquivo principal do console. Teste: `notes`.
- `text-diff.ts`: o diff de linhas (Myers, com o prefixo e o sufixo comuns fora) das versões do markdown e do prompt. Teste: `contracts`.
- `markdown.ts`: a política do markdown seguro do console (sem HTML cru). Teste: `markdown`.
- `backup.ts`: o formato do arquivo de exportação (spec 019).
- `links.ts`: as rotas do console, num lugar só (o front monta os links; a API e o worker gravam caminhos relativos).
- `view-cache.ts`: `createViewCache`, o derivado por item que só muda quando o item muda (o arrasto do canvas; tarefa 176). Teste: `view-cache`.
- `zod-jitless.ts`: desliga o JIT do Zod (o console roda sob CSP sem `unsafe-eval`).
- `types.ts`: os DTOs da API. `schemas/`: as entradas Zod (`index.ts` da F1, `operation.ts` da fase 2, `vision.ts` da fase 3, `contracts.ts` dos contratos e séries, `common.ts`).

## Agentes (`src/agents`)

- `tools.ts`: o registro único `AGENT_TOOLS` (nome, título e descrição em pt-BR, schema Zod → JSON Schema por `json-schema.ts`, tipo, categoria, modo sugerido, `adminOnly`, `secrets`, `producesFile`, `external`) e `kitTools`/`effectiveToolMode` do kit; `mcpExposed` filtra o `/mcp`. Os lotes: `tools-operation.ts` (F13a), `tools-admin.ts` (F13b), `tools-notes.ts` (`NOTE_TOOLS`, categoria `notes`), `tools-supersede.ts` (`SUPERSEDE_TOOLS`), `recipes.ts` (`RECIPE_TOOLS`, com as entradas e DTOs das receitas) e `tools-mcp.ts` (`MCP_ONLY_TOOLS`, fora dos kits e das execuções). Tipos e `define` em `tool-def.ts`. Teste: `agents`.
- `result.ts`: `fitResult`, o resultado da tool cortado por item sem quebrar o JSON (tarefa 101). Teste: `agents`.
- `preview.ts` (a prévia/diff `ToolPreview` do cartão "Aplicar?", nunca com segredos), `blocks.ts` (os blocos neutros das mensagens), `sse.ts` (parser do SSE), `live-buffer.ts` (o texto ao vivo juntado por quadro; tarefa 120), `schemas.ts` e `types.ts` (entradas e DTOs da API dos agentes). Testes: `agents`, `live-buffer`.
- `prompt-vars.ts`: as variáveis `{{…}}` do prompt (spec 022). Teste: `prompt-vars`.
- `inferences.ts` ("Provedor padrão", spec 024), `media.ts` (tipos de arquivo do chat, a duração, o texto falado e a divisão para o texto→áudio; spec 025), `requests.ts` (o cURL sem a chave e a detecção do base64; spec 023), `budgets.ts` (spec 028), `tasks.ts` (a agenda e os DTOs da spec 029) e `telegram.ts` (o markdown da resposta em HTML da Bot API, em partes de 4096). Testes: `media`, `ai-requests`, `budgets`, `autonomous`.

## Textos (`src/i18n`)

- `pt-BR.ts`: o `t`, os textos da interface e da API; cada área em `i18n/areas/` (`agents.ts` e `agents-ui.ts`, `notes.ts` em `t.notes`, `statements.ts`, `contracts.ts`…). `errors.ts`: as mensagens dos erros do banco pelo nome da constraint. Chave nova entra perto das do mesmo assunto.
