# 019 — Backup e restauração

Menu **Administração → Backup e restauração** (só admin), em `/admin/backup`, com uma aba por tela: Categorias, Entidades, Caixas, Provedores de IA, Usuários, Backup e Restauração. Decisões de 2026-10-11.

## Exportar e importar por recurso

- **Exportar** gera um JSON (`moneyflow-<recurso>-AAAAMMDD-HHMM.json`) com todos os objetos do recurso, linha a linha como o banco os guarda (colunas em `snake_case`), mais as **referências** externas (registros apontados pelas FKs e que não fazem parte do recurso, sem segredos), usadas só para casar registros na importação e nunca inseridas.
- Recursos e o que cada um leva:
  - **Categorias**: `categories` (os dois níveis, cor e ícone).
  - **Entidades**: `entities` (com a marca `is_favorite`) com contatos, endereços, dados bancários, chaves PIX, vínculos, o catálogo de tags (`entity_tags`, arquivadas inclusive) e as ligações entidade–tag (`entity_tag_links`).
  - **Caixas**: `caixas` (gerais e cartões) com contas financeiras, membros e categorias ocultas. O titular precisa existir no destino (importe as entidades antes).
  - **Provedores de IA**: `ai_providers` **com a chave de API** e `ai_model_prices`.
  - **Usuários**: `users` **com a senha**, papéis por caixa e os tokens pessoais (**o hash**, então o token continua válido).
- Os segredos (senha, chave de API, cabeçalhos MCP, bot token, hash dos tokens) só saem por este export, lidos pelas funções `admin_*` do banco com o admin da sessão como ator ([016](016-banco-de-dados.md)). Fora dele continuam write-only. A tela avisa que o arquivo traz segredos em texto puro.
- **Importar** aceita o `.json` (ou um `.zip` com o `.json` dentro) e faz **merge**:
  - Os ids do arquivo são preservados.
  - **Já cadastrado** = mesmo id, ou a mesma chave natural: usuário (username ou e-mail), categoria (tipo, pai e nome sem maiúsculas), entidade (documento, normalizado; o CNPJ alfanumérico casa como o numérico), tag de entidade (nome sem maiúsculas), provedor, agente e servidor MCP (nome), destino de mensagem (dono e nome), preço (provedor, modelo e vigência), NF-e (chave de acesso), membro de caixa (usuário e caixa). Fica o cadastrado, sem alteração, e as referências do arquivo passam a apontar para ele (uma subcategoria nova entra sob o pai já cadastrado).
  - **Filhos de um dono já cadastrado não entram** (contatos, endereços, dados bancários, chaves PIX e ligações com tags de uma entidade existente; preços de um provedor existente; tokens de um usuário existente; membros quando usuário e caixa já existiam…): permanece o que está cadastrado.
  - **Nada que gere conflito é gravado**: cada registro entra num savepoint; o que o banco recusar (unicidade, regra de integridade, mês fechado) é desfeito sozinho. Quem depende de um registro que não entrou também não entra; uma referência opcional (FK `ON DELETE SET NULL`, como "criado por") é anulada em vez de barrar o registro.
  - O resultado lista, por recurso, quantos estavam no arquivo, quantos entraram, quantos já estavam cadastrados, quantos foram mantidos e quantos não entraram, e cada item não importado com o **motivo** (exportável em CSV).
- **Simular** roda a importação inteira e desfaz a transação no fim: mostra o mesmo relatório sem gravar nada.

## Backup

- **Dump do PostgreSQL** (`moneyflow-dump-AAAAMMDD-HHMM.zip`): `pg_dump --format=custom` do banco inteiro (estrutura e dados, inclusive segredos) mais um `manifest.json` (versão do schema, quem e quando). É o arquivo da restauração completa.
- **JSON completo** (`moneyflow-completo-AAAAMMDD-HHMM.zip` com `moneyflow.json`): todas as tabelas de negócio, inclusive segredos e anexos (conteúdo em hex), lidas num retrato consistente (`REPEATABLE READ`, somente leitura) e escritas aos pedaços. Ficam de fora o estado operacional ou recalculável: sessões, log de auditoria, fila de mensagens, notificações do sino, execuções dos agentes (`ai_runs`, eventos e confirmações) e embeddings.

## Restauração

- **Restaurar o dump** apaga o banco atual e o recria 100% a partir do arquivo: `pg_restore --clean --if-exists --single-transaction --no-owner`, numa transação única (se falhar, nada muda; `lock_timeout` de 30 s). Exige digitar `RESTAURAR` e confirmar. Só aceita dump da **mesma versão de schema** do banco atual (a última migration de `schema_migrations` dentro do dump é comparada com `app_schema_version()`); com outra versão, restaure com a versão do MoneyFlow que gerou o dump. Usuários e sessões passam a ser os do backup: a tela volta para o login.
- **Importar o JSON completo** faz o merge recurso por recurso com as regras acima, em ordem de dependência por registro. Registros com checagens no COMMIT (título e espelho, baixas e suas pernas, movimentos, transferências, faturas, compras e itens de cartão) entram juntos, e as checagens rodam antes de liberar o savepoint (`SET CONSTRAINTS ALL IMMEDIATE`). Estados que o banco só aceita por transição são reproduzidos: a baixa estornada entra ativa e é estornada, o título cancelado entra aberto e é cancelado depois das baixas, a fatura fechada entra aberta e fecha depois dos itens (o saldo rolado entra depois do fechamento da fatura de origem). Fechamentos de mês entram por último.

## Operação

- Dump e restauração rodam com a **conexão do dono do banco** (`DATABASE_OWNER_URL`), só para `pg_dump`/`pg_restore`, com as credenciais em variáveis de ambiente do processo filho (nunca na linha de comando nem nos logs). A aplicação continua como `moneyflow_app`. Sem a variável, ou sem o cliente do PostgreSQL 18 (`PG_BIN_DIR` ou o `PATH`), as ações de dump ficam desligadas e a tela diz o motivo. A imagem Docker traz o `postgresql-client-18` (PGDG) e o compose da raiz define a variável.
- Uploads de importação e restauração chegam crus (`.json`, `.zip` ou o `.dump`), com limite próprio `BACKUP_MAX_UPLOAD_MB` (padrão 512). Uma operação de backup por vez (`409` se já houver outra).
- Rotas: `GET /api/backup/status`, `GET /api/backup/export/:recurso`, `GET /api/backup/full`, `GET /api/backup/dump`, `POST /api/backup/import/:recurso|full[?dryRun=1]` e `POST /api/backup/restore-dump?confirm=RESTAURAR`. Os logs registram quem exportou, importou ou restaurou, nunca o conteúdo.
