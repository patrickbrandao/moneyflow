---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-07
commit: 9991a6b
---

# A escrita aprovada é executada de novo quando a execução do agente é retomada após uma queda

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** bug
- **Subcategoria:** idempotência / execução duplicada
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:418-428,442,482-514,528`, `apps/server/src/agents/worker.ts:56,66,188-194`, `database/migrations/0026_ai_conversations_and_runs.sql:437-440,626`, `docs/011-agentes-de-ia.md:87`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O usuário aprova "criar o título X". O sistema cria, mas cai antes de anotar que terminou. Na volta, olha a aprovação, vê "aprovado" e cria o título outra vez. O resultado são lançamentos, baixas ou conciliações em dobro.

### Evidência e análise técnica
- `runner.ts:482-485` monta `alreadyStarted` a partir dos eventos `tool_start`, com o comentário "Escritas sem confirmação que já tinham começado antes de uma queda não são repetidas".
- `runner.ts:509-510`: `else if (!confirmation && tool.write && alreadyStarted.has(use.id)) outcome = errorOutcome(...)`. Uma confirmação `approved` não entra nesse ramo e cai no `else` (`:511-514`), que chama `tools.execute` de novo.
- Os resultados só são gravados em `insertToolResults` (`runner.ts:528`), uma vez, depois de **todas** as tools pendentes. Se a queda acontece na 3ª de 10 escritas aprovadas, as 2 já feitas são refeitas.
- `ai_run_claim(1, '2 minutes')` (`worker.ts:56,66`; `0026:437-440`) retoma a execução `running` com reserva vencida, e `resolvePending` (`runner.ts:442`) relê as confirmações aprovadas.

### Verificação (tentativa de refutação)
- O CHECK `ai_tool_confirmations_status_check` (`0026:626`) só aceita `pending`, `approved`, `rejected` e `expired`. Não existe estado "executada", e nada muda a confirmação depois de executar.
- As tools de escrita não são idempotentes.
- O SIGTERM espera as execuções ativas (`worker.ts:188-194`), mas o `docker stop` padrão manda SIGKILL após 10 s, e um lote de aprovações (por exemplo `match_statement_lines`) passa disso com facilidade. OOM e queda do host também servem.
- `docs/011:87` promete não repetir só a escrita **sem** confirmação. Sobre a aprovada não diz nada; parece omissão.

### Impacto
Títulos, baixas, compras, transferências ou mensagens duplicados depois de qualquer queda do worker no meio de escritas aprovadas.

## Como reproduzir
Com o provedor falso: pedir uma escrita em `ask` e aprovar. Simular a queda inserindo o evento `tool_start` e voltando a execução para `running` com `locked_at` antigo. Rodar o claim de novo: o handler executa outra vez.

## Solução proposta
- Tratar como interrompida toda escrita (fora as de segredo, que a API executa) que já tem `tool_start`, com ou sem confirmação.
- Opcional: gravar o `tool_result` de cada tool logo após a execução, em transação curta, para encolher a janela.
- Atualizar `docs/011:87`: "uma escrita (com ou sem confirmação) que já tinha começado…".

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/runner.ts
+++ b/apps/server/src/agents/runner.ts
@@
-  // Escritas sem confirmação que já tinham começado antes de uma queda não são repetidas.
+  // Escritas (aprovadas ou não) que já tinham começado antes de uma queda não são repetidas.
   const started = await db.execute<{ tool_use_id: string }>(sql`
@@
-    } else if (!confirmation && tool.write && alreadyStarted.has(use.id))
+    } else if (tool.write && alreadyStarted.has(use.id))
       outcome = errorOutcome('A execução foi interrompida durante esta ação; confira o resultado antes de repetir.');
```

## Critérios de aceite
- [ ] Com uma confirmação `approved` e um `tool_start` já gravado, a retomada não chama o handler e devolve ao modelo o erro "interrompida".
- [ ] Uma aprovada sem `tool_start` continua sendo executada.
- [ ] `docs/011` atualizada.

## Testes recomendados
Em `apps/server/test/agents.test.ts`, com o provedor falso, o cenário de "Como reproduzir": a contagem de títulos não muda e o `tool_result` vem com `is_error`. Nada disso foi executado nesta auditoria.

## Limitações e suposições
A janela de queda é estreita, mas real. Uma escrita que já tinha terminado fica marcada como "interrompida", e o modelo é orientado a conferir. Duas reservas simultâneas são improváveis: o heartbeat roda a cada 3 s contra os 2 min do claim.

## Análise (triagem)

Confirmado em `apps/server/src/agents/runner.ts` (`resolvePending`): o ramo "interrompida" exigia `!confirmation`, então uma escrita aprovada com `tool_start` já gravado era executada de novo na retomada (no código antigo, o teste novo vê a entidade criada pela retomada: contagem 1 em vez de 0). Executor: app.

## Resolução (executor)

- `apps/server/src/agents/runner.ts`: toda escrita com `tool_start` já gravado vira o erro "A execução foi interrompida durante esta ação; confira o resultado antes de repetir." para o modelo, com ou sem confirmação. As tools de segredo seguem no ramo próprio (antes deste), pelo resultado preparado pela API. Uma aprovada sem `tool_start` continua sendo executada (o teste "escrita com confirmação aprovada" cobre).
- Teste novo em `apps/server/test/agents.test.ts` ("escrita aprovada já começada antes de uma queda não é repetida na retomada"): aprova o `create_entity`, reserva a execução, grava o `tool_start` por `appendEvent`, envelhece a reserva e drena com `10 seconds`: a execução termina, a entidade não é criada, o `tool_result` vem com `is_error` e "interrompida", e a confirmação segue `approved`.
- Spec: `docs/011-agentes-de-ia.md` (retomada). Gravar o resultado de cada tool logo após a execução (opcional) não foi feito.
