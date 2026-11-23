---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 84876e4
---

# "Uma operação de backup por vez" usa duas travas diferentes e deixa a restauração correr junto com a importação

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** exclusão mútua entre dump, restauração, importação e exportação
- **Arquivos afetados:** `apps/server/src/services/backup/dump.ts:193-203,215,338`, `apps/server/src/services/backup/import.ts:665-666`, `apps/server/src/services/backup/export.ts:121-218`, `docs/019-backup-e-restauracao.md:38`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A tela promete uma operação de backup por vez. Hoje dá para restaurar o dump enquanto outra aba (ou outro admin) importa um JSON ou gera o JSON completo. A restauração falha depois de 30 s com um erro de trava pouco claro. Ou a importação, que esperava, é aplicada por cima do banco recém-restaurado.

### Evidência e análise técnica
- O dump e a restauração usam uma flag **em memória do processo**, `let busy` (`dump.ts:193-203`), em `createDumpZip` (`:215`) e `restoreDump` (`:338`).
- A importação usa outra trava, no banco: `pg_try_advisory_xact_lock(hashtext('moneyflow:backup'))` (`import.ts:665-666`). Ela não enxerga a flag, e a flag não enxerga a trava.
- `exportFullZip` e `exportResource` não usam nenhuma das duas.
- A flag não vale entre réplicas da API: duas réplicas podem restaurar ao mesmo tempo.

Cenários:
1. **Restaurar durante a importação:** a transação da importação segura locks nas tabelas em que já gravou. Os `DROP` do `psql` esperam o `lock_timeout` de 30 s (`dump.ts:357`) e a restauração falha com "lock timeout", não com `409 backup_busy`.
2. **Importar durante a restauração:** a trava consultiva está livre, então a importação começa. As consultas dela ficam bloqueadas nas tabelas que o `psql` está recriando e, quando a restauração faz COMMIT, continuam e fazem o merge do arquivo no banco restaurado. O catálogo em cache (`catalog.ts:224-229`) já foi lido antes.
3. **Restaurar durante o JSON completo:** o `REPEATABLE READ` da exportação segura `AccessShare` nas tabelas lidas, e a restauração falha depois de 30 s.

### Verificação (tentativa de refutação)
- A spec diz "Uma operação de backup por vez (`409` se já houver outra)" (`docs/019:38`). O código só garante isso dentro de cada par (dump/restauração num processo, importação/importação no banco).
- O `lock_timeout` deixa a restauração segura (nada muda se falhar). Mas o cenário 2 muda dados sem o admin esperar.
- Nenhum teste combina restauração com importação.

### Impacto
Raro (dois admins, ou duas abas, ou duas réplicas). Mas quando acontece, o erro é confuso ou a importação cai num banco diferente do que o admin via.

## Como reproduzir
1. Inicie `POST /api/backup/restore-dump?confirm=RESTAURAR` com um dump grande.
2. Durante a restauração, `POST /api/backup/import/full` com um JSON. A importação não recebe `409`: espera e, depois da restauração, grava.

## Solução proposta
Uma trava só, no banco, para todas as operações:
1. Em `exclusive()`, pegar `pg_try_advisory_lock(hashtext('moneyflow:backup'))` numa conexão dedicada do pool, segurada até o fim e solta no `finally`. Sem a trava, `409`. Isso vale entre réplicas.
2. Não repetir a mesma chave no `psql` da restauração: ele roda noutra sessão e esperaria para sempre a trava que a própria API segura. A trava da API já cobre o processo filho.
3. Usar a mesma trava em `exportFullZip`, ou pelo menos fazer a restauração recusar com `409` enquanto houver exportação.
4. A importação continua com a `pg_try_advisory_xact_lock` dela, que passa a conflitar com a trava de sessão.

## Critérios de aceite
- [ ] Restaurar enquanto uma importação roda devolve `409 backup_busy` imediatamente, e vice-versa.
- [ ] Duas restaurações em réplicas diferentes: a segunda recebe `409`.

## Testes recomendados
`apps/server/test/backup.test.ts`: segurar a trava consultiva numa conexão à parte e conferir que `restore-dump`, `dump`, `full` e `import/full` respondem `409`.

## Limitações e suposições
Não executado. O comportamento de locks entre `DROP` e a transação da importação foi deduzido da semântica do PostgreSQL.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: o dump e a restauração usavam a flag `busy` em memória do processo (`dump.ts`), a importação a trava consultiva de transação no banco, e o JSON completo nenhuma das duas.

## Resolução (executor)

- `apps/server/src/services/backup/lock.ts` (novo): `withBackupLock(db, fn)` pega `pg_try_advisory_lock(hashtext('moneyflow:backup'))` numa conexão própria do pool (o `$client` do Drizzle), segura até o fim e solta no `finally` (sem conseguir soltar, a conexão é descartada); sem a trava, `409 backup_busy`. Vale entre réplicas.
- `dump.ts`: `createDumpZip` e `restoreDump` usam a trava antes de tudo (antes da checagem do pg_dump e da extração do upload), no lugar da flag `busy`, que saiu. `export.ts`: `exportFullZip` também. `import.ts`: a importação continua com `pg_try_advisory_xact_lock` sobre a mesma chave (`BACKUP_LOCK_KEY`), que conflita com a de sessão. O psql da restauração não pega a chave.
- A exportação de um recurso (pequena) segue sem a trava.
- Spec 019 (Operação).
- Teste em `apps/server/test/backup.test.ts`, "uma operação de backup por vez…": com a trava de sessão segura noutra conexão, `GET /api/backup/full`, `GET /api/backup/dump`, `POST /api/backup/import/full` e `POST /api/backup/restore-dump` respondem `409 backup_busy`; com a trava de transação (uma importação em andamento), as quatro também; solta a trava, a importação volta a rodar.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
