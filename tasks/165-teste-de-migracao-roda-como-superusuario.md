---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# O teste de migração com dados roda as migrations como superusuário, ao contrário da produção (tarefa 054)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** teste
- **Subcategoria:** fidelidade do teste de migração
- **Arquivos afetados:** `database/scripts/test-migration.sh:13-16,27-37`, `database/Makefile:55-56`, `database/AGENTS.md:69`, `docs/016-banco-de-dados.md:21,31`
- **Depende de / relacionado a:** tarefa 054 (dono do banco sem superusuário)
- **Executor sugerido:** dba
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Existe um teste que aplica uma migration sobre dados parecidos com os de produção, para garantir que nada se perde. Só que esse teste roda com o usuário "todo-poderoso" do banco. Na produção, as migrations rodam com um usuário limitado. Uma migration que só funciona com o todo-poderoso passaria no teste e quebraria no deploy.

### Evidência e análise técnica
- `test-migration.sh:13-16`: `user="${POSTGRES_USER:-moneyflow}"`, o superusuário da imagem, e `sql() { docker compose exec … psql … -U "$user" "$@"; }`.
- `:27`: `CREATE DATABASE $db`, sem `OWNER moneyflow_owner`.
- `:28-37`: as migrations anteriores e a testada (subida, descida e subida) passam por `sql`, ou seja, como superusuário.
- `Makefile:55-56`: `test-migration: up`, sem a dependência `owner` que o `test` e o `migrate` têm.
- A regra da tarefa 054 (`database/AGENTS.md:69`): "Nunca rode migrations como superusuário". O `make test` a segue (dbmate com `moneyflow_owner`); o teste com dados, não.
- Casos que passam como superusuário e falham como dono: `ALTER TABLE … DISABLE TRIGGER ALL` (desliga as constraint triggers de FK, só superusuário), `SET session_replication_role`, `CREATE EXTENSION` não-trusted, mexer em objeto de outro dono. As migrations de dados já desligam triggers por nome (`0049:465-579`, `0052:1283-1291`), então o próximo passo natural (desligar todos) é exatamente o que o teste não pegaria.

### Verificação (tentativa de refutação)
- A 0052 roda certo em produção, porque o `migrate` usa o dono. O problema é de cobertura do teste, não de um defeito já em produção.
- O fixture pode, sim, precisar do superusuário (dados que os triggers recusariam). Só as migrations devem rodar como dono.
- A descrição na `docs/016:21` não diz com que papel o teste roda.

### Impacto
Falso verde no teste das próximas migrations de dados; o erro aparece só no deploy, no meio da janela de manutenção.

## Como reproduzir
1. Crie uma migration de teste com `ALTER TABLE statement_lines DISABLE TRIGGER ALL; … ENABLE TRIGGER ALL;` e um `migration-tests/NNNN_x/` mínimo.
2. `make test-migration M=NNNN` passa.
3. `make migrate` (dbmate como `moneyflow_owner`) falha com "permission denied: … is a system trigger".

## Solução proposta
1. `test-migration.sh`: criar `<db>_mig` com `OWNER moneyflow_owner`, rodar `03-owner-role.sh` com `OWNER_DBS=<db>_mig` (como o `make test`) e aplicar as migrations, anteriores e testada, como `moneyflow_owner` (`psql -U moneyflow_owner` com `PGPASSWORD=$OWNER_DB_PASSWORD`, ou pelo serviço `dbmate`). Fixture e conferências podem continuar como superusuário.
2. `Makefile`: `test-migration: owner`.
3. `docs/016:21` e `database/AGENTS.md`: dizer que o teste roda as migrations como o dono.

## Critérios de aceite
- [ ] As migrations do teste com dados rodam como `moneyflow_owner`.
- [ ] Uma migration com `DISABLE TRIGGER ALL` falha no `make test-migration`.
- [ ] `make test-migration M=0052` continua passando.

## Testes recomendados
- O próprio `make test-migration M=0052`, depois da mudança.
- Um caso negativo temporário (a migration de teste acima), descartado depois de conferir.

## Limitações e suposições
Nada foi executado (sem `make` nesta revisão). Não conferi se o CI roda o teste com dados; pelo `ci.yml`, não roda.

## Análise (triagem)

## Resolução (executor)
