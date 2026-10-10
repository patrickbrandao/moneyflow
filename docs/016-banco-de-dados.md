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
- Invariantes de integridade ficam no banco (constraints e triggers: dois níveis de categoria, uma caixa principal por titular, campos obrigatórios por tipo de caixa, espelho recíproco, status do título coerente com as baixas, transferência que soma zero…). Fluxos de negócio (espelhar título, baixar, fechar fatura) ficam na aplicação, em transações.

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
- **Categorias**: `kind` é imutável; no máximo dois níveis; o filho tem o `kind` do pai; nome único entre irmãos sem distinção de maiúsculas. A cor é um slot do design system, `color_slot` de 1 a 12, que o front mapeia para o token CSS `--port-N` (nunca hex nem nome de paleta); o ícone é um nome lucide em kebab-case.
- **Recorrência**: a regra (`recurrence_rules`) guarda só o calendário: `weekly|monthly|yearly`, intervalo, dia âncora (dia da semana ISO 1–7 no semanal, dia do mês 1–31 nos demais), início e, no máximo, um fim: data (`ends_on`) ou total de parcelas (`installments_total`, 2–999). Os títulos da série têm `origin = recurrence`, a regra e o número da ocorrência (n de N, nunca acima de N); uma ocorrência por série em cada caixa.
- **Títulos**: valor > 0; `direction` imutável; categoria compatível (`payable` → `expense`, `receivable` → `income`); caixa de cartão só aceita `origin = card_invoice`. `status` é coerente com as baixas: `open`/`partial`/`paid` seguem a soma do principal das baixas ativas (mantido por trigger; mudar o valor recalcula), e `canceled` só sem baixa ativa. O valor nunca fica abaixo do já baixado, e título com baixas não muda de caixa.
- **Espelho**: `counterparty_caixa_id` e `mirror_title_id` andam juntos; a ligação é 1:1 e recíproca; o par tem direção oposta, mesmo valor e vencimento, mesma origem e ocorrência; cada título está na caixa cujo titular é a contraparte do outro; exatamente um lado (o criado na caixa da contraparte) tem `mirror_status` (`pending|accepted|disputed`). Checado no COMMIT, para o par nascer ou mudar na mesma transação.
- **Baixas**: principal > 0, juros/multa/desconto ≥ 0, desconto até principal + juros + multa; a soma do principal ativo nunca passa do valor do título; título cancelado não recebe baixa. Título, data e valores são imutáveis; o estorno (`reversed_at` + motivo) é irreversível e a baixa estornada deixa de contar. A conta é da caixa do título e pode ficar nula ("conta a definir"), sendo preenchida uma única vez enquanto a baixa está ativa. As duas pernas da baixa de um par espelhado ficam ligadas de forma recíproca, nos dois títulos do par, com mesma data e valores, e são estornadas juntas (checado no COMMIT).
- **Movimentos**: valor assinado ≠ 0 (entra +, sai −), nunca antes da abertura da conta; `kind` determina o vínculo (`settlement` → baixa, `transfer` → transferência, `adjustment` → nenhum, categoria opcional compatível com o sinal). Baixa com conta e valor em dinheiro ≠ 0 tem exatamente um movimento na conta e na data dela, de ±(principal + juros + multa − desconto) (`payable` sai, `receivable` entra); estornada, mais um movimento oposto (o histórico não é apagado). Conta com histórico não muda de caixa nem tem a abertura movida para depois de um movimento.
- **Transferências**: contas distintas, valor > 0, exatamente dois movimentos na data (−valor na origem, +valor no destino). Se nasce de uma baixa ("pagar título da caixa B com conta da caixa A"), tem o valor em dinheiro da baixa e a perna na conta da baixa (destino se a pagar, origem se a receber); uma por baixa. Excluir a transferência leva os movimentos.
- **Saldos**: `financial_account_balances` (saldo inicial + todos os movimentos) e `financial_account_balance_at(conta, data)`; `title_balances` dá o principal baixado e o saldo aberto de cada título (0 se cancelado).
- **Checagens no COMMIT**: espelho, pernas da baixa, movimentos de baixa e de transferência são constraint triggers `DEFERRABLE INITIALLY DEFERRED`; a aplicação monta o conjunto inteiro na mesma transação. Toda violação de regra sai como `23514` (check_violation) com o nome da regra em `CONSTRAINT` (ex.: `settlements_overpayment_check`); FKs, `23503`; unicidade, `23505`.

## Convenções

Identificadores em inglês e `snake_case`; PK `uuid` com `uuidv7()`; `created_at`/`updated_at`; arquivamento por `archived_at`; dinheiro em `bigint` `_cents`; domínios com `CHECK` em vez de `ENUM`. Detalhes em `database/AGENTS.md`.
