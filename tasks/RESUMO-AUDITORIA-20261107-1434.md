# Resumo da auditoria — 2026-11-07 14:34

Auditoria estática, somente leitura, feita pela skill `problem-finder` (catálogo Purple Skills). As tarefas seguem o formato do projeto (docs/017): nome em minúsculas, cabeçalho de status e linha em `tasks/INDEX.md`. Esse formato foi escolhido pelo usuário no lugar do `NNN-TITULO.md` da skill. Este arquivo não é uma tarefa.

## 1. Parâmetros, data e commit
- Data: 2026-11-07. Commit: `1ebb073` (v0.1.21).
- Escopo: maior risco, escolhido pelo usuário. Foco: todos. Severidade mínima: baixa. `max-relatorios`: 25. Rede: não.

## 2. Cobertura
Cinco lotes de descoberta em paralelo. Cada candidato foi passado a um verificador independente, encarregado de tentar derrubá-lo.

| Lote | Área |
|---|---|
| A | Entrada, autenticação e autorização: `app.ts`, `config`, `auth/`, `authz/`, todas as rotas, `users`, `api-tokens`, `caixas`, `tx`, `/mcp`, anexos |
| B | Agentes e MCP: `agents/` (runtime, todos os `tool-handlers*`, runner, worker, store, events-hub, mcp-client), `conversations`, `chat-media`, `ai-budgets`, registro de tools do shared |
| C | Integrações e filas: webhook e entrada do Telegram, `integrations/telegram`, `messages`, `message-worker`, notificações, `notes` e lembretes, `agent-tasks`, `lookup` |
| D | Uploads, parsers e backup: `backup/*`, anexos, documentos de contrato, NF-e, import de extrato, `pdf-text`, parsers OFX/CSV/XML |
| E | Fronteira de segurança no banco: GRANT/REVOKE e `SECURITY DEFINER` em todas as migrations 0001–0053, initdb, seeds, compose e `.env.example` |

Cerca de 110 dos 148 arquivos de `apps/server/src` foram lidos, inteiros ou nos trechos relevantes, além das migrations de segurança e das libs `fastify`, `find-my-way`, `proxy-addr` e `rate-limit` instaladas.

## 3. Exclusões
- `node_modules`, `dist` e o schema gerado em `packages/db/src/generated`: dependências, build e código gerado.
- Fixtures de teste e arquivos binários (`.wav`, `.png`, `.pdf`, `.ofx`).

## 4. Áreas não cobertas
- `apps/web` (o SPA), exceto os pontos citados nos achados.
- Lógica de domínio financeiro: títulos, baixas, espelho, cartão e faturas, conciliação (`statements.ts` e `reconciliation.ts` fora dos trechos de acesso), contratos e séries, relatórios e canvas.
- `routes/cards.ts`, `routes/contracts.ts`, `routes/titles.ts` e os serviços deles. As checagens de acesso desses serviços não foram lidas uma a uma.
- `e2e/`, CI (`.github/workflows`), `Dockerfile`, `backup/legacy-contracts.ts`, `parsers/nfe.ts` por inteiro.

## 5. Tarefas criadas

| ID | Título | Severidade | Confiança | Categoria | Esforço | Dependências |
|---|---|---|---|---|---|---|
| 048 | XSS armazenado por anexo aberto inline | alta | confirmado | segurança | P | 065 |
| 049 | Eventos de agente para destinos de caixa que o usuário não lê | alta | confirmado | segurança | P | — |
| 050 | Limite de login contornável por X-Forwarded-For | alta | confirmado | segurança | P | — |
| 051 | Guard de sessão contornável por caminho codificado | média | confirmado | segurança | P | — |
| 052 | Parsers OFX/XML quadráticos (DoS) | média | confirmado | segurança | P | — |
| 053 | Escrita aprovada repetida na retomada | média | provável | bug | P | — |
| 054 | Dono do banco é superusuário (dump/restauração) | baixa | provável | ponto fraco | M | 048 |
| 055 | Zip bomb no backup | baixa | confirmado | ponto fraco | P/M | — |
| 056 | Conversa de fluxo arquivada aceita mensagem | baixa | confirmado | incoerência | P | 057 |
| 057 | Escopo da receita sem as tools de lote | baixa | confirmado | ponto fraco | P | 056 |
| 058 | Prévias de tools sem Access | baixa | confirmado | segurança | P | — |
| 059 | Áudio fora do orçamento | baixa | confirmado | ponto fraco | P | 060 |
| 060 | Limite por minuto sem trava | baixa | confirmado | ponto fraco | M | 059 |
| 061 | Telegram responde depois de desfazer o pareamento | baixa | confirmado | segurança | P | — |
| 062 | Falha transitória do token vira definitiva | baixa | confirmado | bug | P | — |
| 063 | Erro de assinatura engolido sem log | baixa | confirmado | ponto fraco | P | — |
| 064 | Dedup do webhook fora do processamento | baixa | provável | bug | P/M | — |
| 065 | Cabeçalhos de segurança ausentes | baixa | provável | ponto fraco | P/M | 048 |
| 066 | Sessão sem expiração por inatividade | baixa | provável | ponto fraco | P | 067 |
| 067 | Troca da própria senha não revoga sessões | baixa | confirmado | incoerência | P | 066 |
| 068 | Postgres de dev exposto na rede | baixa | confirmado | segurança | P | 054 |
| 069 | Listas de leitores de segredo incompletas | baixa | confirmado | incoerência | P | — |

## 6. Ordem sugerida de correção
1. 048, 049 e 050: as três altas, independentes e pequenas. A 048 junto com a 065, que é a camada extra.
2. 051, 052 e 053.
3. 054 (primeiro o dba, depois o app) e 068.
4. As demais baixas, agrupando por área: agentes (056 e 057, 058, 059 e 060), Telegram e mensagens (061 a 064), sessão (066 e 067) e documentação (069).

## 7. Acima de `max-relatorios`
Nenhum: 22 tarefas, abaixo do limite de 25.

## 8. Hipóteses não confirmadas
- `pg_restore --clean` com um dono sem superusuário pode falhar nas extensões (`vector`, `pg_trgm`, `citext`). É preciso testar antes de fechar a 054.
- A configuração da produção (proxy, `COOKIE_SECURE`, `DATABASE_OWNER_URL`, cabeçalhos), que fica num projeto externo, não foi vista. Ela pode agravar a 050 e a 054, e pode atenuar a 065 e a 066.

## 9. Já registrados ou possivelmente resolvidos
Nenhum achado duplica uma tarefa existente (001–047). A 045, aberta, trata de outro assunto.

## 10. Candidatos refutados
Sete candidatos foram refutados:
- leitores de credencial sem `lock_token` e `admin_*` confiando no ator: decisão documentada, e não protegeria nada;
- confidencialidade do XML da NF-e: cadastro global por desenho;
- download do Telegram lendo o corpo inteiro: a origem é configurada pelo operador;
- força bruta do pareamento do Telegram: espaço de cerca de 8,5e11 em 10 minutos;
- `consolidatedLineId` fora do escopo da receita: inalcançável;
- prévia do título sem Access: já é validada antes;
- "sem a senha atual" na troca de senha do admin: o admin já pode revelar a senha.

Duas partes de achados também foram refutadas: "a URL do dono anula a blindagem" e os documentos de contrato como vetor de XSS.

## 11. Prompt injection no projeto
Nenhum texto do projeto tentou dar instruções aos agentes da auditoria.

## 12. Limitações gerais
Análise só estática, sem executar testes nem reproduzir nada, e sem acesso à rede: as versões das dependências não foram cruzadas com bases de CVE. Comportamentos de bibliotecas foram confirmados lendo o código instalado, não executando. Os diffs das tarefas são ilustrativos e não foram aplicados.
