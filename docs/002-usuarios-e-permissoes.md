# 002 — Usuários, autenticação e permissões

- Campos: username, email, password (**texto puro, intencional**), ativo/inativo.
- A senha nunca sai em respostas da API, logs, exports ou tools de agentes; só o admin a vê, via ação "revelar" na tela do usuário. A única exceção é o backup do admin (exportar usuários e o JSON completo), que leva a senha para permitir a restauração ([019](019-backup-e-restauracao.md)).
- Login por username **ou** email. Sessão em cookie httpOnly com tabela de sessões no Postgres; desativar o usuário revoga as sessões na hora.
- Primeiro admin criado no boot a partir de `ADMIN_USERNAME`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` se não houver usuários.
- Papel global: `admin` (todos os poderes, todas as caixas, gerencia usuários) ou `user`.
- Papel por caixa: `editor` (CRUD na caixa) ou `viewer` (somente leitura). Um usuário só enxerga as caixas em que tem papel.
- Quem acessa a caixa pagadora pode ver a caixa do cartão correspondente (ver [007](007-cartao-de-credito.md)).
