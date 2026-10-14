# 026 — Sessões dos agentes (F12)

A conversa com cada agente passa a ser um **fio contínuo por usuário e agente**, dividido em **sessões**. Substitui o modelo de várias conversas soltas da [011](011-agentes-de-ia.md). Decisões da entrevista de 2026-10-13. Como as sessões anteriores serão aproveitadas (memória, resumo, busca pelo agente) fica para implementações futuras.

## Regras
- **Sessão**: cada sessão é uma linha de `ai_conversations` com `purpose = 'chat'` e id UUIDv7. A palavra "conversa" sai da interface e dá lugar a "sessão".
- **Sessão ativa**: cada (usuário, agente) tem **no máximo uma** sessão ativa (não finalizada).
  - A janela do agente sempre abre na sessão ativa.
  - Sem sessão ativa, a próxima mensagem cria uma nova.
- **Finalizar sessão**:
  - o botão no cabeçalho da janela, com confirmação, **arquiva** a sessão ativa;
  - se houver execução em andamento, o "parar" é pedido na mesma operação (`cancel_requested_at`) e a sessão é arquivada na hora; a execução termina sozinha em até alguns segundos, e a próxima mensagem já pode abrir a sessão nova;
  - a próxima mensagem entra numa sessão nova.
- **O modelo recebe só a sessão ativa**: o histórico das finalizadas não vai ao modelo.
- **Sessões finalizadas**:
  - ficam em somente leitura, com o histórico, os anexos, o uso e o id visíveis;
  - não voltam a ser ativas;
  - para continuar a partir de uma delas, **bifurcar**: o fork cria a sessão nova, que vira a ativa, e finaliza a ativa anterior. A cópia segue a regra de corte de [011](011-agentes-de-ia.md).
- **Título**: o título automático e o renomear continuam por sessão. O "fixar" sai, porque a lista agora é por agente.
- **Excluir** uma sessão finalizada continua possível, com a mesma regra de [011](011-agentes-de-ia.md): apaga mensagens, execuções e eventos, e o uso fica. A ativa precisa ser finalizada antes.
- **Busca**: cobre todas as sessões do usuário, e o resultado abre a sessão (ativa ou finalizada).
- **Admin**: lê as sessões de todos, por usuário e agente, em somente leitura.
- **Fora desta regra**:
  - as conversas de fluxo (`purpose` ≠ `chat`) continuam como estão;
  - as tarefas agendadas ([029](029-fluxos-autonomos.md)) criam sessões próprias, fora do fio do chat;
  - o Telegram ([029](029-fluxos-autonomos.md)) usa a mesma sessão ativa do console, porque o fio é um só.

## Interface
- **Ícone Agentes (topbar)**:
  - lista os **agentes**, com a última atividade, o título da sessão ativa e um indicador de execução em andamento;
  - clicar abre a janela do agente na sessão ativa;
  - cada agente tem "Sessões anteriores", com as finalizadas e a busca.
- **Janela e painel lateral**:
  - uma janela por **agente**, não por conversa;
  - o cabeçalho mostra o agente, o título da sessão e os botões "Finalizar sessão", "Sessões anteriores" e o modo áudio ([025](025-chat-multimidia.md));
  - a sessão finalizada aberta pela lista aparece numa janela de leitura com "Bifurcar daqui".
- **Id da sessão**: aparece no menu da janela, com "copiar".
- **localStorage** (`moneyflow:agents-ui`, versão 2): guarda janelas por agente (chave = id do agente) e as de leitura (chave = id da sessão). As janelas antigas, guardadas por conversa, são convertidas na leitura: a sessão ativa do próprio usuário vira a janela do agente (inclusive no painel ancorado), as outras ficam como janelas de leitura e a que não existe mais sai.

## Banco (dba)
- **Sessão ativa única**: índice único parcial em `ai_conversations (user_id, agent_id) WHERE purpose = 'chat' AND archived_at IS NULL`. Criar a segunda devolve `23505`, que a API traduz.
- **Motivo da finalização**: a coluna `ai_conversations.archived_reason` (e não o `screen_context`, que vai ao prompt e é copiado pelo fork) guarda `finished` (o usuário finalizou), `forked` (o fork finalizou a ativa), `migrated_from_multi` (a migração) ou `import_conflict` (a importação do backup); nulo = arquivada antes da F12. Só existe com `archived_at`.
- **Migração** (0043):
  - para cada (usuário, agente) com mais de uma conversa `chat` não arquivada, fica ativa a de `last_message_at` mais recente (nulos por último; empate por `created_at` e id) e as outras são arquivadas com `migrated_from_multi`;
  - nenhuma mensagem é apagada; as execuções ativas das arquivadas são encerradas (na fila ou esperando confirmação, canceladas; rodando, com o parar pedido).
- **Bifurcação**: `ai_conversation_fork` arquiva a sessão ativa do mesmo (usuário, agente) na mesma transação, antes de criar a cópia.
- **Execução ativa**: arquivar uma sessão com execução ativa só é aceito se o cancelamento dela já foi pedido (`cancel_requested_at` preenchido); senão, `23514`.
- **Finalizada não volta**: uma sessão `chat` arquivada não pode ser desarquivada (`23514`).
- **Backup**: a importação que traria uma segunda sessão ativa para o mesmo (usuário, agente) — já no banco ou importada antes na mesma importação — grava a importada finalizada, com `import_conflict` (ajuste de linha no import, como os de [019](019-backup-e-restauracao.md)). Um arquivo anterior à 0043 com várias ativas do mesmo par deixa ativa a de `last_message_at` mais recente, como a migração.
- **`pinned_at`**: saiu (`DROP COLUMN` na 0043). Arquivos de backup antigos com a coluna continuam importáveis (o import filtra as colunas pelo catálogo).

## Aplicação (app)
- **API**:
  - `GET /api/agents/threads` (agentes com a sessão ativa e o resumo: última atividade, quantas finalizadas, se o agente está utilizável; os seus mostram todos os agentes utilizáveis e os que já têm sessões; o admin passa `userId` de outro usuário ou `all`);
  - `GET /api/agents/:agentId/thread` (a janela do agente: o agente, o que ele converte e o detalhe da sessão ativa, ou nenhuma);
  - `GET /api/agents/:agentId/sessions` (finalizadas, da mais recente, paginadas por `limit`/`offset` com `hasMore`; `q` busca nelas; o admin passa `userId`);
  - `POST /api/agents/:agentId/sessions` (a sessão ativa, criada se não houver: o anexo antes da 1ª mensagem);
  - `POST /api/agents/:agentId/messages` (entra na ativa ou cria a sessão; devolve a sessão e se foi criada);
  - `POST /api/conversations/:id/finish` (numa transação: a execução ativa na fila ou esperando confirmação é cancelada, a rodando recebe o parar, e a sessão é arquivada com `finished`; finalizar de novo não muda nada).
  - As rotas atuais por conversa continuam valendo para leitura, renomear (o PATCH só aceita o título), excluir (só a finalizada), bifurcar e o upload. `POST /api/conversations` cria a sessão ativa e responde 409 se já houver uma.
  - Regras só da aplicação: a ativa não se exclui (422) e a finalizada não recebe mensagem nem execução (409 `session_finished`).
  - Erros do banco traduzidos: segunda ativa (`23505 ai_conversations_active_chat_key`, 409; ao criar pela mensagem ou pelo anexo, a API relê a ativa e usa ela), finalizada que voltaria (`23514 ai_conversations_unarchive_check`) e arquivar com execução sem o parar (`23514 ai_conversations_archive_active_run_check`).
  - O serviço da "sessão ativa do par" (`ensureActiveSession`, `sendToAgent` em `services/conversations.ts`) é reutilizável pelo Telegram e pelas tarefas agendadas ([029](029-fluxos-autonomos.md)).
- **Web**: `AgentsMenu`, `AgentWindows`, `AgentsProvider` e `useConversation` reorganizados por agente; `PreviousSessions` (lista com busca e "Carregar mais", na lista do ícone e no modal da janela). A janela do agente sem sessão ativa mostra "Nova sessão"; anexar ou enviar cria a sessão. "Bifurcar daqui" copia a sessão finalizada inteira (até a última mensagem). Os textos trocam "conversa" por "sessão".

## Testes
- **Integração**:
  - a segunda sessão ativa é recusada;
  - mensagem sem sessão ativa cria uma;
  - finalizar com execução rodando para a execução e arquiva;
  - o fork finaliza a ativa e cria a nova;
  - o modelo recebe só a sessão ativa;
  - a migração deixa uma ativa por par.
- **e2e**: conversar, finalizar a sessão, ver a próxima mensagem numa sessão nova, abrir a anterior em leitura e bifurcar; a conversão do `localStorage` antigo.
- **Backup**: importar uma sessão ativa num banco que já tem a ativa do par, e um arquivo antigo com várias ativas do mesmo par.
