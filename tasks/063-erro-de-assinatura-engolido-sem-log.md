---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# `produceMessages` engole o erro de assinatura sem log, e a contagem é sobrescrita

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** observabilidade / erro engolido
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:528-552,841-847`, `apps/server/src/worker.ts:55-57`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Quando um aviso programado (resumo, fatura, contrato) não consegue ser gerado, o sistema não registra nada, e a contagem de falhas ainda é apagada pela do envio. Avisos podem deixar de sair todo dia sem que ninguém perceba.

### Evidência e análise técnica
- `message-worker.ts:545-547`: `} catch { failed += 1; }`, sem log.
- `messageTick` (`:841-847`) monta `{ ...produced, ...notifications, ...reminders, ...consumed }`. O `failed` do `consumeOutbox` sobrescreve o de `produceMessages`, e o `worker.ts:55-57` recebe a contagem errada.

### Verificação (tentativa de refutação)
O chamador não loga o erro, e não há outra observabilidade desse caminho.

### Impacto
Avisos que somem em silêncio e diagnóstico impossível.

## Como reproduzir
`messageTick` com uma assinatura cujo `eventsFor` lança erro: nada aparece no log, e o `failed` final reflete só o consumo.

## Solução proposta
- Renomear o campo para `subscriptionsFailed` e devolver os erros (id da assinatura, tipo, mensagem) para o `worker.ts` logar com `log.warn`.
- Incluir o campo na condição do log.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/message-worker.ts
+++ b/apps/server/src/services/message-worker.ts
@@
-    } catch {
-      failed += 1;
+    } catch (error) {
+      failed += 1;
+      errors.push({ subscriptionId: sub.id, eventKind: sub.event_kind, error: String((error as Error)?.message ?? error) });
     }
   }
-  return { queued, failed };
+  return { queued, subscriptionsFailed: failed, subscriptionErrors: errors };
```
Com `const errors: {...}[] = []` no início e o `log.warn` correspondente em `worker.ts`.

## Critérios de aceite
- [ ] Uma assinatura que falha aparece no log do worker.
- [ ] A falha de produção e a de consumo ficam em campos separados.

## Testes recomendados
Integração chamando `messageTick` com uma assinatura que provoca erro e conferindo `subscriptionsFailed: 1`. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Nenhuma relevante.

## Análise (triagem)
Sem triagem formal: designado ao `app` pela sessão principal. Confirmado: `produceMessages` (`services/message-worker.ts`) fazia `catch { failed += 1 }` sem log, e `messageTick` espalhava `{ ...produced, ..., ...consumed }`, com o `failed` do consumo sobrescrevendo o da produção.

## Resolução (executor)
- `produceMessages` devolve `{ queued, subscriptionsFailed, subscriptionErrors }` (id da assinatura, tipo do evento e a mensagem do erro, até 500 caracteres); `failed` fica só para o consumo da outbox.
- `logMessageTick(log, resultado)` em `services/message-worker.ts`: um `log.warn` por assinatura que falhou e o `log.info` do resumo (sem a lista) quando algum contador é positivo — inclui `subscriptionsFailed`. `apps/server/src/worker.ts` passa a usá-lo.
- Teste novo em `apps/server/test/vision.test.ts`: "assinatura que falha ao gerar é logada e contada à parte das falhas de envio (tarefa 063)" — relógio com data inválida faz a assinatura `due_reminder` lançar; confere o item em `subscriptionErrors`, a ausência de `failed` na produção e, com um logger dublê, o `warn` da assinatura e o `info` com `failed` e `subscriptionsFailed` separados. (Testa `produceMessages` + `logMessageTick` em vez de `messageTick` inteiro: o relógio inválido também derrubaria o sino e os lembretes da mesma passada.)
- Specs: sem mudança de decisão.
- Rodado no Postgres local (`test:local`): o caso com `-t "tarefa 063"` (1/1) e `test/vision.test.ts` inteiro (11/11). Ajuste: o teste cria o próprio cenário (uma caixa legível), porque sem caixa no escopo a assinatura nem consulta os vencimentos e, sozinho, não falhava.
