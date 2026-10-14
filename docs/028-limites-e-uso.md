# 028 — Orçamentos, limites e painel de uso (F14)

O uso de IA deixa de ser só medição. Entram orçamentos mensais com aviso e bloqueio, um limite de execuções por minuto e um painel de uso mais rico. Decisões da entrevista de 2026-10-13.

## Orçamentos mensais
- **Escopos**: `user` (um usuário), `agent` (um agente), `flows` (todos os fluxos automáticos: leitura de documento, conciliação, contratos e tarefas agendadas, [029](029-fluxos-autonomos.md)) e `global` (o total do sistema).
- Cada orçamento tem valor mensal, moeda (`USD` ou `BRL`, a do preço), percentual de aviso (padrão 80) e o interruptor ativo.
- O mês segue o fuso de São Paulo.
- **Gasto**: a soma do custo estimado em `ai_usage` no mês, na moeda do orçamento. O uso sem preço não entra (a tela mostra "N chamadas sem preço" ao lado), e o uso noutra moeda também não.
- **Aviso**: ao cruzar o percentual de aviso e ao chegar a 100%, a notificação `ai_budget_alert` vai ao sino de quem o orçamento cobre (o usuário, no escopo `user`) e de todos os admins. Os destinos que assinam o evento também recebem ([013](013-mensagens-telegram.md)). A dedup é por (orçamento, mês, limiar).
- **Bloqueio em 100%**:
  - Criar execução é recusado (`429`, "Orçamento de IA do mês atingido: <escopo>"). O runner também confere antes de cada chamada ao modelo: se o orçamento estoura no meio da execução, ela termina com status `failed` e o código de erro `budget_exceeded`, guardando o que já foi feito.
  - Nos fluxos, a leitura de documento devolve o mesmo erro, e a conciliação e as tarefas agendadas são puladas; o aviso é a própria notificação `ai_budget_alert`.
  - O **admin fica isento** do bloqueio quando é ele quem aciona; continua recebendo o aviso.
- **Vários orçamentos** valem juntos: a execução precisa caber em todos os que se aplicam (usuário, agente, fluxos e global). "Fluxo" é toda execução de conversa com `purpose` ≠ `chat`; o uso dos fluxos conta no orçamento `flows` **e** no do usuário que os acionou.

## Limite de execuções por minuto
- Por usuário, para conter abuso e loops: `AI_RUNS_PER_MINUTE` (padrão 10) para as sessões e `AI_FLOW_RUNS_PER_MINUTE` (padrão 30) para os fluxos.
- Os dois podem ser mudados na tela e gravados em `app_settings` (`ai.runs_per_minute`, `ai.flow_runs_per_minute`); **o banco vence a variável**.
- O excesso é recusado com `429` e `retry-after`.
- Vale também para o admin e para o Telegram ([029](029-fluxos-autonomos.md)).

## Painel de uso (guia Uso, /admin/ai)
- **Filtros**: período (mês, 30 dias ou intervalo), provedor, agente, usuário e finalidade.
- **Gráficos** (seguindo o `dataviz` e os tokens do tema):
  - custo por dia, empilhado por provedor ou agente;
  - tokens por dia (entrada, saída e cache);
  - taxa de acerto do cache (lido ÷ entrada total).
- **Tabelas**:
  - top 20 sessões por custo, com link para a sessão em leitura;
  - por modelo: chamadas, tokens, custo, latência p50/p95 e taxa de erro (de `ai_provider_health`, [023](023-requisicoes-ao-provedor.md));
  - por finalidade.
- **Orçamentos**: barra do gasto em relação ao valor, com o aviso e o bloqueio marcados.
- **Exportar**: CSV de cada tabela (`lib/export.ts`).
- **Para o usuário comum**: em *Minha conta → IA*, o próprio uso do mês e o orçamento que o cobre.

## Banco (dba)
- **`ai_budgets`**:
  - colunas: `id`, `scope` (`user|agent|flows|global`), `user_id`/`agent_id` conforme o escopo (CHECK), `currency`, `monthly_limit_micros` (> 0), `alert_percent` (1–99), `is_active` e os timestamps;
  - no máximo um ativo por (escopo, alvo, moeda), com `NULLS NOT DISTINCT` (alvo nulo em `flows` e `global`);
  - auditada e no backup.
- **`ai_budget_status(mês)`**: gasto, percentual e situação (`ok|alert|blocked`) de cada orçamento ativo. Uma função `ai_budget_check(user, agent, is_flow)` devolve os orçamentos estourados que se aplicam.
- **Visões de uso**: `ai_usage_daily` (dia em São Paulo × provedor × **modelo** × agente × usuário × finalidade × moeda; o modelo serve à tabela "por modelo" num período qualquer, e quem não precisa dele soma) e o ranking de conversas por custo (`ai_usage_top_conversations`, top N por moeda).
- **Notificação e mensagens**:
  - o tipo de notificação `ai_budget_alert`;
  - o evento `ai_budget_alert` em `message_subscriptions`, sem parâmetros.
- **`app_setting_valid`**: aceita as duas chaves novas (inteiro de 1 a 1000).

## Aplicação (app)
Entregue na tarefa 031 (serviço `apps/server/src/services/ai-budgets.ts`).
- **Checagem**: toda execução nova passa por `assertCanStartRun` (limite por minuto, depois `ai_budget_check`) em `sendMessage` — o que cobre o chat, a leitura de documento, as sugestões da conciliação e os fluxos dos contratos; os fluxos checam também antes de abrir a conversa arquivada.
  - Recusa: `429` com o código `budget_exceeded` e "Orçamento de IA do mês atingido: <escopo>" (o escopo da primeira linha: `global`, `fluxos automáticos`, `agente X` ou `usuário @fulano`), sem gravar mensagem nem execução.
  - No runner, antes de cada chamada ao modelo: estourado, a execução termina `failed` (sem status novo em `ai_runs`), com o texto em `error` e o evento `error` com `code: 'budget_exceeded'`.
  - As sugestões da conciliação logo após importar são puladas e o import devolve `aiSuggestion.skippedReason` (a tela mostra o aviso); o botão "Sugerir com IA" devolve o `429`.
  - A isenção do admin é da aplicação: quem aciona com papel `admin` não consulta o orçamento.
- **Limite por minuto**: conta as execuções do usuário em `ai_runs` no último minuto, separando sessões (`purpose = 'chat'`) e fluxos, sem tabela nova; `429 rate_limited` com `retry-after` em segundos (até a mais antiga sair da janela). Variáveis no `.env.example` e no compose.
- **Avisos**: o produtor do `message-worker` lê `ai_budget_status()` e, para cada orçamento em `alert` ou `blocked`, gera o maior limiar alcançado (o percentual de aviso ou 100) com a chave `ai_budget_alert:<orçamento>:<AAAA-MM>:<limiar>`.
  - Sino: o usuário do escopo `user` (link para Minha conta) e todos os admins ativos (link para a guia Uso).
  - Destinos que assinam o evento: o global recebe todos; o pessoal de um admin, todos; o pessoal de outro usuário, só o orçamento `user` dele; o de caixa, nenhum ([013](013-mensagens-telegram.md)).
- **API**: `GET/POST /api/admin/ai/budgets`, `PATCH/DELETE /api/admin/ai/budgets/:id` (o escopo e o alvo não mudam; o valor entra em unidades da moeda e é gravado em micros), `GET /api/admin/ai/usage/panel?from&to&providerId&agentId&userId&purpose` (datas de São Paulo, até 366 dias) e `GET /api/account/ai/usage`. Os limites por minuto usam as rotas de configuração (`/api/admin/settings/ai.runs_per_minute` e `ai.flow_runs_per_minute`).
- **Painel (guia Uso)**: filtros numa linha (este mês, últimos 30 dias ou intervalo; provedor, agente, usuário e finalidade); totais (custo por moeda com "N chamadas sem preço", chamadas, tokens e acerto do cache); gráficos em SVG próprio, sem biblioteca, seguindo o `dataviz` (colunas ≤ 24 px com 2 px de fundo entre segmentos, linha de 2 px, dica no mouse e nas setas do teclado), com as cores `--chart-1…6` e `--chart-other` dos tokens (paleta validada nos dois temas, nada roxo):
  - custo por dia empilhado por provedor ou agente (os 5 maiores e "Outros"; a cor segue a ordem do cadastro, não o ranking), numa moeda por vez;
  - tokens por dia (entrada, saída, cache gravado e lido);
  - acerto do cache por dia (linha, 0–100%).
  - As tabelas (top 20 sessões por moeda com link para a sessão em leitura, por modelo com a saúde de `ai_provider_health` nos dias do período até hoje, e por finalidade) exportam CSV/PDF; a guia termina com a seção Orçamentos (barra com a marca do aviso e do bloqueio, criar, editar, desligar e excluir) e o limite por minuto (banco × variável, "Usar o padrão").
- **Minha conta → IA**: o uso do mês (por moeda) e as barras dos orçamentos que cobrem o usuário (o dele e o global).
- **Tools de agente** (admin, categoria Configuração de IA, [027](027-tools-de-controle-total.md)): `list_ai_budgets` (leitura), `create_ai_budget`, `update_ai_budget` e `delete_ai_budget` (escritas com prévia; a exclusão é destrutiva). `set_app_setting` aceita as duas chaves do limite por minuto.

## Testes
- **Integração**:
  - o aviso em 80% sai uma vez só;
  - em 100%, a execução nova é recusada, e o admin passa;
  - o estouro no meio da execução termina com `budget_exceeded`;
  - o orçamento de fluxos pula a conciliação;
  - o uso sem preço não conta;
  - o limite por minuto devolve 429;
  - o valor do banco vence a variável.
- **e2e**: criar um orçamento baixo, ver o aviso no sino e o bloqueio na conversa.
