# 016 — Banco de dados e agente DBA

## Responsabilidade

- O banco é gerido por um **subagente independente, o DBA** (definido em `.claude/agents/dba.md`, com regras em `database/AGENTS.md`).
- Tudo o que é do banco vive em `database/`: schema, migrations, testes, seeds, compose e imagem do Postgres. Só o DBA altera essa pasta.
- Os demais agentes (aplicação, frontend) descrevem a necessidade e delegam ao DBA; eles não escrevem migrations.

## Motor e imagem

- PostgreSQL 18 com **pgvector** (imagem `pgvector/pgvector:pg18`) e **pgTAP** para testes.
- `database/docker-compose.yml` sobe o banco isoladamente. O compose da aplicação, quando existir, inclui este arquivo em vez de redefinir o Postgres.
- Extensões habilitadas: `vector` (embeddings para os agentes de IA, F4), `pg_trgm` (busca textual), `citext` (username e email sem distinção de maiúsculas).

## Migrations e testes

- **SQL-first com dbmate**: `database/migrations/NNNN_nome.sql` (4 dígitos sequenciais), cada uma com `migrate:up` e `migrate:down`.
- Uma migration que já está na `main` nunca é editada; mudanças vão numa nova.
- Testes **pgTAP** em `database/tests/` cobrem constraints, triggers, funções e permissões. `make test` recria o banco de testes, aplica as migrations, testa o down da última e roda os testes.
- `database/schema.sql` é o dump da estrutura atual, regenerado a cada mudança e commitado como referência.

## Fronteira com a aplicação

- O banco é a fonte da verdade do schema. O schema Drizzle da aplicação (`packages/db`) é **gerado por introspecção** (`drizzle-kit pull`) a partir do banco migrado e não é editado à mão; a aplicação usa Drizzle só para consultas, nunca para gerar migrations.
- Invariantes de integridade ficam no banco (constraints e triggers: dois níveis de categoria, uma caixa principal por titular, campos obrigatórios por tipo de caixa…). Fluxos de negócio (espelhar título, baixar, fechar fatura) ficam na aplicação, em transações.

## Segurança

- Migrations rodam com o dono do banco. A aplicação conecta como `moneyflow_app`, que só tem DML.
- A senha em texto puro ([002](002-usuarios-e-permissoes.md)) é blindada no próprio banco: `moneyflow_app` não tem SELECT em `users.password` (privilégio por coluna; tem INSERT/UPDATE para criar e trocar senha). A senha só é lida pelas funções `SECURITY DEFINER` `auth_login(login, password)` (devolve o id do usuário ativo ou NULL e atualiza `last_login_at`) e `admin_reveal_password(target_user_id, actor_user_id)` (erro 42501 se o ator não for admin ativo; o ator vem da sessão autenticada na aplicação).
- `EXECUTE` em funções novas não vai para `PUBLIC`, só para `moneyflow_app` (privilégios padrão da migration 0001). O papel `moneyflow_app` é criado `NOLOGIN` pela migration se não existir; login e senha são configurados por quem administra o ambiente (no Docker, por `docker/initdb`).

## Regras de integridade no banco

- **Usuários**: `username` e `email` únicos sem distinção de maiúsculas; `username` não contém `@` nem espaços (o login aceita username ou email, então os dois nunca colidem). Desativar o usuário apaga as sessões dele no mesmo instante (trigger).
- **Documentos**: CPF/CNPJ gravados normalizados (só dígitos/letras maiúsculas). `is_valid_cpf` e `is_valid_cnpj` recebem o valor já normalizado; o CNPJ aceita o formato alfanumérico (12 primeiros `[0-9A-Z]`, valor = ASCII − 48, DVs numéricos). Documento é opcional e único quando presente. Nome fantasia só em empresa; data de nascimento só em pessoa.
- **PIX**: valor normalizado e validado por tipo (cpf/cnpj com DV; email minúsculo ≤ 77; telefone `+55` DDD número; EVP UUID minúsculo). Uma chave PIX é única no sistema inteiro (no DICT ela aponta para uma única conta) e cada entidade tem no máximo uma principal.
- **Vínculos entre entidades**: direcionados (`A partner_of B`), sem auto-vínculo nem duplicata; `spouse_of` é simétrico e só existe em um sentido.
- **Caixas**: `kind` é imutável. No máximo uma principal por titular, e a principal não pode estar arquivada. Os campos do cartão são obrigatórios em `credit_card` e proibidos em `general`; a pagadora padrão é sempre uma caixa `general`. Contas financeiras só existem em caixas `general`; dados bancários só em `checking`/`savings`; cofre não começa negativo.
- **Categorias**: `kind` é imutável; no máximo dois níveis; o filho tem o `kind` do pai; nome único entre irmãos sem distinção de maiúsculas. Cor é um nome da paleta do Tailwind (`violet`, `emerald`…), nunca hex, e o ícone é um nome lucide em kebab-case.

## Convenções

Identificadores em inglês e `snake_case`; PK `uuid` com `uuidv7()`; `created_at`/`updated_at`; arquivamento por `archived_at`; dinheiro em `bigint` `_cents`; domínios com `CHECK` em vez de `ENUM`. Detalhes em `database/AGENTS.md`.
