---
status: aberta
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit:
---

# Tools de controle total, lote F13b (administração e segredos)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [027](../docs/027-tools-de-controle-total.md), seção "Tools novas por categoria (Configuração de IA, Usuários, Backup, Fechamento e auditoria, Mensagens, Tokens, tags)". O que fazer: Tools de admin (`adminOnly`), campos `secret` mascarados em prévia, `ai_messages`, eventos, auditoria e `ai_requests`; arquivos gerados como anexo da sessão; `/mcp` só com token de admin para essas tools; testes.

Ordem: Depois da 028. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [027](../docs/027-tools-de-controle-total.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria. Pode exigir uma tarefa do dba antes (ponto 1).

**Arquivos afetados**
- O registro e os handlers, como na 028.
- Serviços: `ai-admin.ts`, `api-tokens.ts`, `messages.ts`, `backup/*`, `audit.ts` e o de usuários.
- `routes/mcp.ts` hoje lista todo o `AGENT_TOOLS` (l. 27). Passa a filtrar `adminOnly` pelo papel do dono do token.
- `runner.ts` e `store.ts`, para mascarar os segredos.

**Riscos e observações**
- **Mascarar o `tool_use` "logo depois da execução" é inviável no banco atual**:
  - `ai_messages.content` é imutável (`ai_messages_validate_update`, `schema.sql` l. 659, constraint `ai_messages_immutable_check`);
  - `ai_tool_confirmations.input` também é imutável (`ai_tool_confirmations_validate`, l. 1326) e guarda o segredo enquanto espera a decisão;
  - o evento SSE `message`, gravado em `ai_run_events`, sai com o bloco no INSERT, antes da execução;
  - a 027 diz "Não há tabela nova" e não prevê essa mudança.
- **O segredo já está no texto do usuário**: o valor que o modelo escreve na tool veio do texto do usuário (ou de um anexo). Ele já está em `ai_messages`, nos corpos das Requisições e no provedor, então mascarar o `tool_use` não fecha o vazamento.
- **`restore_dump` como tool**: o `pg_restore --clean --single-transaction` (`backup/dump.ts`, l. 252) troca o banco inteiro, inclusive `ai_runs` e a reserva da própria execução. O runner perde a reserva no meio.
- **`export_backup` como anexo**: os anexos têm limite de 20 MB e ficam em `bytea`. Um dump ou um JSON completo pode passar disso.
- **`close_month` não é só de admin**: `closeMonth` usa `assertWrite(caixaId)` (`services/audit.ts`, l. 158). Só `reopenMonth` é de admin (l. 171).
- **Tags**: as tools de tags entram neste lote (veja a 028, ponto 2).

**Dependências**
- Depende da 028.
- Usa `app_settings` (020), `ai_requests` (020/021), as inferências (022/023) e o kit (017).
- Também os orçamentos (030) e as tarefas agendadas (032), que só chegam na F14/F15. As tools de orçamento e de tarefas agendadas dependem dessas tarefas, e a ordem F13 → F14 → F15 as deixa sem base. Recomendação: entregá-las junto com a 031 e a 033.

**Como verificar**
- Os testes da 027: a tool de admin ausente para quem não é admin, o segredo mascarado (no desenho que for aprovado) e a permissão negada.
- O e2e "crie um kit só de leitura".

**Pontos para a revisão da spec**
1. (027, Segredos) A imutabilidade de `ai_messages` e de `ai_tool_confirmations`, mais o segredo que já está no texto do usuário, inviabilizam o desenho. Recomendação:
   - as tools com campo `secret` não recebem o valor do modelo;
   - o cartão de aprovação (sempre `ask` para elas) tem o campo para o usuário digitar o segredo;
   - o valor vai direto ao serviço, sem passar pelo modelo, por `ai_messages`, pelos eventos ou pelas Requisições.
   - Se a máscara for mantida, abrir uma tarefa do dba para uma troca controlada do bloco.
2. (027, Backup) `restore_dump` por tool. Recomendação: fica fora das tools, só na tela; `import_backup` continua.
3. (027, Arquivos gerados) O limite de 20 MB dos anexos. Recomendação: acima dele, a tool devolve um erro que manda usar a tela.
4. (027, Fechamento) `close_month` não é de admin. Recomendação: `close_month` com `assertWrite`, sem `adminOnly` e sem `destructive`; `reopen_month` fica de admin e destrutiva.
5. (027, Configuração de IA) As tools de orçamentos e de tarefas agendadas vêm antes das tabelas delas (F14/F15). Recomendação: movê-las para a 031 e a 033.

## Resolução (executor)
