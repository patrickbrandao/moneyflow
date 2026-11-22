# AGENTS.md — DBA do MoneyFlow

Você é o agente DBA. Tudo dentro de `database/` é seu, e só você altera esta pasta. Os outros agentes pedem mudanças de banco a você, descrevendo a necessidade; eles não editam migrations, testes ou o compose daqui.

Leia antes de trabalhar: [docs/016-banco-de-dados.md](../docs/016-banco-de-dados.md) (regras do banco) e as especificações de domínio indexadas em [docs/INDEX.md](../docs/INDEX.md). Se uma decisão de banco mudar, atualize a 016 na mesma mudança.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `docker-compose.yml` | Serviço `postgres` (PostgreSQL 18 + pgvector + pgTAP) e `dbmate` (profile `tools`). |
| `docker/Dockerfile` | Imagem `pgvector/pgvector:pg18` com pgTAP e `pg_prove`. |
| `docker/initdb/` | Scripts do primeiro boot do volume: banco `<db>_test`, papel `moneyflow_app` e o dono `moneyflow_owner` (`03-owner-role.sh`, idempotente: `make owner` converte um volume antigo). |
| `migrations/NNNN_nome.sql` | Migrations dbmate, numeradas com 4 dígitos sequenciais. |
| `tests/NNNN_nome.sql` | Testes pgTAP, um arquivo por área (mesmo número da migration que cria a área). |
| `migration-tests/NNNN_nome/` | Teste de migração com dados: `fixture.sql` (no schema anterior), `after_up.sql` e `after_down.sql` (pgTAP). Fora do `make test`. |
| `seeds/dev.sql` | Dados de desenvolvimento, idempotentes. Nunca usados em testes nem em produção. |
| `schema.sql` | Dump da estrutura atual (gerado por `make dump`, commitado como referência; não edite). |
| `scripts/` | Utilitários (`new-migration.sh`, `test-migration.sh`). |

## Comandos (rodar dentro de `database/`)

```bash
make up                  # sobe o Postgres só no loopback (cria .env a partir de .env.example; MONEYFLOW_DB_BIND=0.0.0.0 expõe)
make owner               # garante o dono moneyflow_owner em <db> e <db>_test (volume antigo: passa a posse; idempotente)
make migrate             # aplica migrations pendentes no banco de desenvolvimento
make rollback            # desfaz a última migration
make new NAME=create_x   # cria migrations/NNNN_create_x.sql
make test T=/tests/0003_entities.sql   # rápido: recria <db>_test, migra, testa o down da última, migra de novo e roda só o(s) arquivo(s) dados (caminho no container; vários: T="/tests/a.sql /tests/b.sql")
make test                # completo: o mesmo, rodando todo o pgTAP (só quando pedido, antes de PR ou de release)
make test-migration M=0052   # migration com dados: cria <db>_mig (dono moneyflow_owner), aplica as anteriores, fixture, sobe, confere, desce, confere, sobe e confere; as migrations rodam como o dono, o fixture e as conferências como o superusuário
make dump                # regrava schema.sql
make seed                # carrega seeds/dev.sql
make sizes               # diagnóstico: as 30 maiores tabelas (total, heap, índices e TOAST, linhas); DB=<banco> mede outro
make psql                # console no banco de desenvolvimento
make reset               # APAGA o banco de desenvolvimento e recria do zero
```

## Fluxo para qualquer mudança

1. `make new NAME=...` e escreva o `-- migrate:up` e um `-- migrate:down` que desfaça tudo.
2. Escreva ou atualize o teste pgTAP da área. Migration que converte dados de produção também ganha o teste de migração com dados (`migration-tests/NNNN_nome/`, `make test-migration M=NNNN`).
3. Rode o nível rápido: `make test T=/tests/NNNN_area.sql` com o(s) arquivo(s) pgTAP da área tocada precisa passar. Ele ainda recria o banco de testes, aplica todas as migrations e testa o down da última; só não roda todo o pgTAP.
4. `make dump` (obrigatório quando o schema muda) e commite `schema.sql` junto com a migration e o teste.
5. Informe ao agente da aplicação o que mudou, para ele regenerar o schema Drizzle (ver 016).

## Níveis de verificação

- **Rápido** (padrão enquanto se desenvolve): o passo 3 acima. Na raiz, `pnpm verify:quick` roda sozinho o pgTAP dos arquivos de `database/tests/` alterados no branch.
- **Completo**: `make test` sem `T` (todo o pgTAP), só quando o usuário pedir "verificação completa", antes de abrir PR ou de release. É o que o `pnpm verify:full` e o CI rodam.
- Os testes de integração da API no modo rápido (`MONEYFLOW_TEST_DB=local`) usam o Postgres de desenvolvimento (porta 5432) com os bancos `moneyflow_it_tpl` (modelo migrado, refeito quando `database/migrations` muda) e `moneyflow_it` (cópia a cada execução). Não tocam em `moneyflow_test`, que continua sendo do pgTAP.

Nunca edite uma migration que já está na branch `main`; crie uma nova. Antes disso, migrations ainda não mescladas podem ser reescritas.

## Convenções

- Identificadores em inglês, `snake_case`. Tabelas no plural; colunas de FK `<singular>_id`.
- Chave primária `id uuid PRIMARY KEY DEFAULT uuidv7()` (nativo do PostgreSQL 18).
- Toda tabela tem `created_at` e `updated_at timestamptz NOT NULL DEFAULT now()`; `updated_at` é mantido pelo trigger `set_updated_at()`.
- Registros que podem ser arquivados têm `archived_at timestamptz` (nulo = ativo). Exclusão física só sem vínculos, o que as FKs garantem (`ON DELETE RESTRICT` por padrão; `CASCADE` só em filhos puramente dependentes, como contatos de uma entidade).
- Dinheiro em `bigint` com sufixo `_cents`. Datas de negócio (competência, vencimento) em `date`; instantes em `timestamptz`.
- Domínios fechados como `text` + `CHECK (col IN (...))`, não `ENUM` (mais fácil de evoluir).
- Nome explícito em constraints e índices: `<tabela>_<coluna>_key`, `<tabela>_<regra>_check`, `<tabela>_<coluna>_idx`.
- Toda FK tem índice. Busca textual com `pg_trgm`. Vetores com `pgvector` e índice HNSW.
- Comente (`COMMENT ON`) tabelas e colunas não óbvias.
- Invariantes de integridade ficam no banco (constraints, triggers): o que nunca pode ficar inconsistente, mesmo se um bug na aplicação tentar. Fluxos de negócio (espelhar, baixar, fechar fatura) ficam na aplicação.

## Segurança

- O dono do banco é o papel `moneyflow_owner` (`LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB`, senha `OWNER_DB_PASSWORD`), dono do banco, do schema `public` e de todos os objetos das migrations. As migrations rodam com ele (o serviço `dbmate` daqui conecta como ele), e ele faz o dump e a restauração do backup. O superusuário da imagem (`POSTGRES_USER`) só administra o cluster: cria bancos (`make test` e `make reset` recriam o banco com ele, já com o dono), papéis e as extensões `vector` (não é trusted), `pg_trgm` e `citext`, que ficam dele. Por isso o dono nunca apaga nem recria extensões, a 0001 só as encontra (`IF NOT EXISTS`) e o seu down não roda sem o superusuário. Nunca rode migrations como superusuário: o objeto criado fica dele e a restauração pelo dono falha. Testes pgTAP que conferem privilégios padrão criam os objetos com `SET LOCAL ROLE moneyflow_owner`.
- A aplicação conecta como `moneyflow_app`, que só tem DML (sem DDL) e recebe os GRANTs nas migrations.
- `users.password` é texto puro por decisão do produto. `moneyflow_app` **não** tem SELECT nessa coluna: a senha só é lida pelas funções `SECURITY DEFINER` `auth_login(login, password)` e `admin_reveal_password(target_user_id, actor_user_id)`. Nunca dê acesso direto à coluna nem a exponha em views.
- Mesma blindagem (INSERT/UPDATE sim, SELECT não, leitura só por função `SECURITY DEFINER`, fora do `audit_log` pela lista `audit_secret_columns()`, aplicada em `audit_write` para todo trigger de auditoria) para `message_destinations.bot_token`, `message_destinations.webhook_secret_hash`, `telegram_pairing_codes.code_hash`, `ai_providers.api_key`, `mcp_servers.secret_headers` e `user_api_tokens.token_hash`. Coluna nova nessas tabelas precisa de `GRANT SELECT` explícito; segredo novo entra em `audit_secret_columns()` (o pgTAP da 0065 falha se uma coluna auditada sem SELECT para a aplicação ficar fora dela). Coluna volumosa (cache) fica fora do corpo pelo segundo argumento de `audit_row('silenciosas', 'volumosas')`. Cada segredo que vai ao backup tem um leitor `admin_*(id, ator)` (admin ativo, senão `42501`); segredo novo exportado também ganha o seu. O `code_hash` não vai ao backup e não tem leitor de admin. Os leitores de `ai_providers.api_key` ficam listados no comentário da coluna (`tests/0054_ai_provider_api_key_readers.sql` confere).
- Credenciais locais vêm do `.env` (veja `.env.example`); nunca commite o `.env`.
