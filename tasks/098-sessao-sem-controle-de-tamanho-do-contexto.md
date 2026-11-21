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

# Uma sessão que passa do limite do provedor falha em toda mensagem nova, sem orientar o usuário

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** janela de contexto e tamanho da requisição
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:217`, `apps/server/src/agents/runner.ts:254-259`, `apps/server/src/agents/runner.ts:332-344`, `apps/server/src/agents/store.ts:113-118`, `apps/server/src/agents/tools-runtime.ts:75,155-158`, `apps/server/src/agents/llm/anthropic.ts:60-86`, `apps/server/src/agents/llm/openai.ts:46-60`, `apps/server/src/agents/run-attachments.ts:54,70-79`, `apps/server/src/agents/llm/request-log.ts:186-195`, `docs/026-sessoes-dos-agentes.md:3`
- **Depende de / relacionado a:** tarefa 096
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Numa conversa longa, ou depois de anexar dois PDFs grandes, o agente passa a responder só "O provedor de IA respondeu com erro: HTTP 400…" a qualquer mensagem. Nada diz ao usuário que basta finalizar a sessão e começar outra, e ele fica achando que o agente quebrou.

### Evidência e análise técnica
- Cada chamada manda a sessão inteira: `loadMessages` sem limite (`store.ts:113-118`, `runner.ts:217`) e `toNeutral` + `balanceToolUses` (`runner.ts:254`). Não há corte, resumo nem estimativa de tamanho antes de chamar.
- Os anexos voltam em toda chamada: o PDF e a imagem em base64 (`anthropic.ts:67-77`, `openai.ts:51-57`) e o texto/CSV/OFX inteiro (`anthropic.ts:78-83`, `openai.ts:58-59`). Um anexo pode ter 20 MB, e a API da Anthropic recusa requisições acima de 32 MB. Dois PDFs de 13 MB (cerca de 35 MB em base64) já impedem qualquer chamada nessa sessão.
- Cada resultado de tool vai até 60 mil caracteres (`tools-runtime.ts:75,155-158`), cerca de 15 a 20 mil tokens. Num modelo compatível com janela pequena (Ollama ou vLLM com 8 a 32 mil tokens), um único `get_statement_import` já estoura.
- Memória no worker. `RunAttachments` (`run-attachments.ts:54,70-79`) guarda os bytes de todos os anexos da sessão durante a execução. A cada volta, o adaptador gera de novo o base64 (`anthropic.ts:70,75`), o SDK serializa o corpo, e `describeBody` (`request-log.ts:186-195`) faz `JSON.parse` do corpo inteiro só para ler `stream`. Com um PDF de 20 MB, cada chamada passa de 100 MB de cópias transitórias, e são até `AGENT_CONCURRENCY` execuções ao mesmo tempo.
- O erro 400/413 não é repetível. A execução termina `failed` com `providerError(error.message)` (`runner.ts:332,342`), e a mensagem seguinte manda o mesmo histórico e falha igual. Essa falha também não cai no laço da tarefa 074.

### Verificação (tentativa de refutação)
- A spec 026 faz da sessão a unidade de contexto (só a ativa vai ao modelo) e deixa memória e resumo "para implementações futuras" (`docs/026:3`). Finalizar a sessão é a saída prevista, mas nem a mensagem de erro nem a tela a indicam.
- Nenhum teste cobre um histórico grande ou o erro de contexto do provedor.
- Confiança "provável": o texto exato e o código HTTP do erro de contexto variam por provedor (Anthropic: `prompt is too long`; OpenAI: `context_length_exceeded`; compatíveis variam). Não foi executado.

### Impacto
Sessões travadas até o usuário descobrir sozinho que precisa finalizar. Isso pesa mais em quem usa modelos locais de janela pequena e em quem anexa PDFs grandes. Até o erro, o custo cresce a cada mensagem (relacionado: tarefa 096).

## Como reproduzir
1. Agente Anthropic com visão direta. Na mesma sessão, anexe dois PDFs de cerca de 13 MB e mande "resuma".
2. A execução falha com 413/400. Mande "oi": falha de novo, com o mesmo erro.
3. Variante: provedor OpenAI-compatível com um modelo de 8 mil tokens e uma tool de leitura grande (`get_statement_import` com `limit` 100).

## Solução proposta
1. Reconhecer o erro de contexto e de tamanho (413; 400 com `prompt is too long`, `context_length`, `maximum context`, `too large`) em `wrap`/`wrapError` como um código próprio (`context_overflow`). A execução termina com uma mensagem em pt-BR que manda finalizar a sessão ou bifurcar de um ponto anterior. Fica em `t.agents.errors` e vai no evento `error` com `code`, para o console mostrar o botão "Finalizar sessão".
2. Antes de chamar, estimar o tamanho da requisição (bytes do corpo e soma dos anexos). Acima de um teto configurável por provedor (por exemplo `default_models`/parâmetro do agente `max_context_tokens`), falhar cedo com a mesma mensagem, sem gastar a chamada.
3. Em `describeBody`, tirar o `JSON.parse`. O adaptador sabe se pediu streaming e pode passar isso no `RequestCall` (`streaming: true`). Assim acaba a cópia extra do corpo.
4. Cortar o que é pesado e velho no histórico enviado, nunca no gravado. Os `tool_result` de voltas antigas (fora das N últimas) e os anexos binários de mensagens antigas (já descritos ou lidos) viram um marcador "[resultado antigo omitido; chame a tool de novo se precisar]". Isso precisa ser determinístico para não quebrar o cache.

## Critérios de aceite
- [ ] Um 400 de contexto do provedor falso termina a execução com o código `context_overflow` e a mensagem que manda finalizar a sessão.
- [ ] Uma requisição acima do teto não chega ao provedor.
- [ ] Com o corte do item 3, uma sessão com 30 voltas de tool envia só os resultados das últimas N por inteiro.

## Testes recomendados
`apps/server/test/agents.test.ts`: `llm.queue = [{ status: 400, body: { error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } } }]` (a opção de corpo do provedor falso, se faltar, entra em `e2e/fakes/fake-llm.ts`). Conferir o `code` no evento `error` e o texto do erro da execução. Um caso com dois anexos grandes e o teto baixo pela configuração.

## Limitações e suposições
Nada foi executado. Os limites (32 MB, janelas de contexto) vêm da documentação dos provedores e podem mudar. O item 3 é uma decisão de produto (quanto do histórico preservar) e deve entrar na spec 026.

## Análise (triagem)

## Resolução (executor)
