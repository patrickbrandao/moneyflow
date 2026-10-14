---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-10-14
commit:
---

# Sessão ativa única por usuário e agente no banco (F12)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [026](../docs/026-sessoes-dos-agentes.md), seção "Banco (dba)". O que fazer: Índice único parcial da sessão ativa, migração que arquiva as conversas extras (sem apagar), `ai_conversation_fork` arquivando a ativa, recusa de arquivar com execução ativa, destino de `pinned_at`.

Ordem: Depois da F11; depois vem a 027. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [026](../docs/026-sessoes-dos-agentes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, `database/tests/0026_ai_conversations_and_runs.sql` e `schema.sql`.
- Estado atual:
  - `ai_conversations` tem `pinned_at` e `archived_at` (`schema.sql` l. 5388) e o índice `ai_conversations_chat_user_idx`;
  - `ai_conversation_fork(p_message_id, p_user_id, p_title)` (l. 324) cria a cópia `chat` para `p_user_id`.

**Riscos e observações**
- **Ordem da migração**: primeiro arquivar as extras (a ativa é a de `last_message_at` mais recente; com nulos, vale `created_at`), depois criar o índice único parcial.
- **Fork**: arquiva a ativa de (`p_user_id`, agente) antes do INSERT. Se a ativa tem execução ativa, a recusa 23514 se aplica, então a aplicação precisa parar a execução antes.
- **"Não voltam a ser ativas"**: hoje desarquivar é permitido (`updateConversation` na aplicação), e a spec não pede trava no banco.
- **`pinned_at`**: decisão do dba. Remover exige mudar a aplicação (027) na mesma branch.
- **Backup**: `ai_conversations` entra no JSON completo (não está em `EXCLUDED_TABLES`). Importar sessões ativas de outro arquivo pode bater no índice único (23505). É um ajuste de linha no `import.ts` (aplicação), que o dba documenta na 016.

**Dependências**
- Depois da F11. A 027 vem depois.
- A 032 usa a finalidade `scheduled_task`, que fica fora do índice (`purpose = 'chat'`).

**Como verificar**
- `make -C database test`.
- pgTAP:
  - a segunda ativa é recusada (23505);
  - a migração deixa uma ativa por par e não apaga mensagens;
  - o fork arquiva a ativa;
  - arquivar com execução ativa é recusado (23514).

**Pontos para a revisão da spec**
1. (026, Regras) "Não voltam a ser ativas" não tem trava no banco. Recomendação: um trigger que recusa `archived_at` voltar a NULL em `purpose = 'chat'`.
2. (026, Banco) A importação do backup pode trazer duas ativas para o mesmo par. Recomendação: um ajuste de linha no import que arquiva a importada quando já existe uma ativa, como o ajuste "finalidade das conversas de arquivos antigos".
3. (026, Sem execução ativa) A interação com o "Finalizar" está detalhada na 027, ponto 1.

## Resolução (executor)
