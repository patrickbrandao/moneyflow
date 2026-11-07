---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba, app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# Postgres de desenvolvimento publicado em todas as interfaces, com o superusuário e a senha padrão

- **Severidade:** baixa
- **Confiança:** confirmado (só ambiente de desenvolvimento e pilha local)
- **Categoria:** segurança
- **Subcategoria:** credenciais padrão / exposição de porta
- **Arquivos afetados:** `database/docker-compose.yml:10-16`, `docker/database.override.yml:7`, `.env.example:4-5`
- **Depende de / relacionado a:** 054
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O banco local fica aberto para toda a rede (por exemplo, um Wi-Fi público), protegido por uma senha que qualquer um conhece.

### Evidência e análise técnica
- `database/docker-compose.yml:10-11` usa `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-moneyflow}`, que é o superusuário da imagem. Em `:15-16`, a porta é publicada com `"${MONEYFLOW_DB_PORT:-5432}:5432"`, sem `127.0.0.1:`.
- `docker/database.override.yml:7` faz o mesmo na pilha completa: `"${STACK_DB_PORT:-5433}:5432"`.
- O `.env.example:4-5` traz o mesmo valor padrão.

### Verificação (tentativa de refutação)
- Não se aplica à produção, que fica num projeto externo (`docs/018:17`).
- Na máquina de desenvolvimento a exposição é real, porque o Docker publica em 0.0.0.0. É conveniência de dev, sem decisão documentada sobre bind ou senha.

### Impacto
Quem estiver na mesma rede lê e altera os dados de desenvolvimento, que podem conter cópias de dados reais, e, como superusuário, executa comandos no container.

## Como reproduzir
Com o banco no ar, a partir de outra máquina da rede: `psql -h <ip do host> -p 5432 -U moneyflow` com a senha padrão.

## Solução proposta
- Publicar só em loopback, com uma variável de bind para quem precisa acessar de fora.
- Opcional: `:?` no lugar do padrão, para exigir a senha no `.env`.
- O `database/docker-compose.yml` é do dba; o `docker/database.override.yml` é do app.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/database/docker-compose.yml
+++ b/database/docker-compose.yml
@@
     ports:
-      - "${MONEYFLOW_DB_PORT:-5432}:5432"
+      - "${MONEYFLOW_DB_BIND:-127.0.0.1}:${MONEYFLOW_DB_PORT:-5432}:5432"
--- a/docker/database.override.yml
+++ b/docker/database.override.yml
@@
     ports: !override
-      - "${STACK_DB_PORT:-5433}:5432"
+      - "${STACK_DB_BIND:-127.0.0.1}:${STACK_DB_PORT:-5433}:5432"
```

## Critérios de aceite
- [ ] `docker compose config` mostra `host_ip: 127.0.0.1`.
- [ ] `make -C database up`, `pnpm test:local` e a pilha completa continuam funcionando a partir do host.

## Testes recomendados
Nenhum automatizado. Verificar à mão que outro host da rede não conecta. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Conferir que os e2e com `host.docker.internal` usam só as portas do app, não as do banco.

## Análise (triagem)

Confirmado (dba, 2026-11-07): o Docker publicava a 5432 em 0.0.0.0 com o superusuário de senha conhecida. Duas partes: `database/docker-compose.yml` (dba, feita) e `docker/database.override.yml` (app, pendente).

## Resolução (executor)

Parte do banco (dba), feita:
- `database/docker-compose.yml`: porta publicada em `"${MONEYFLOW_DB_BIND:-127.0.0.1}:${MONEYFLOW_DB_PORT:-5432}:5432"`; `database/.env.example` documenta `MONEYFLOW_DB_BIND` (0.0.0.0 expõe de propósito); `docs/016` (Motor e imagem) registra a decisão.
- `docker compose config` mostra `host_ip: 127.0.0.1`. O container de desenvolvimento foi recriado pelo `make up` (volume mantido, dados intactos) e está em `127.0.0.1:5432->5432`; `make test` e `make dump` funcionaram a partir do host.

**Falta a parte do app:** `docker/database.override.yml` usa `ports: !override` com `"${STACK_DB_PORT:-5433}:5432"`, que substitui a porta do arquivo do banco e continua em 0.0.0.0 na pilha completa. Trocar por `"${STACK_DB_BIND:-127.0.0.1}:${STACK_DB_PORT:-5433}:5432"` (e, se quiser, documentar `STACK_DB_BIND` no `.env.example` da raiz). Depois conferir `docker compose config` na raiz e que o `pnpm test:local` e os e2e seguem funcionando.

Parte do app (app), feita:
- `docker/database.override.yml`: a porta da pilha completa passou a `"${STACK_DB_BIND:-127.0.0.1}:${STACK_DB_PORT:-5433}:5432"` (o `!override` continua substituindo a porta do arquivo do banco).
- `.env.example` da raiz: `STACK_DB_BIND=127.0.0.1`, com o aviso de que `0.0.0.0` expõe o banco (com o superusuário) na rede de propósito e a referência ao `MONEYFLOW_DB_BIND` do banco de desenvolvimento. `docs/001` (Ambiente local) registra o bind.
- Conferido: `docker compose config` na raiz mostra `host_ip: 127.0.0.1` com `published: "5433"`. Os e2e só usam `host.docker.internal` para as portas dos falsos (18081–18083) e a API (3000), nunca o banco; o `pnpm test:local` usa o banco de desenvolvimento (5432, já em loopback pelo dba) e passou. Sem teste automatizado (configuração do compose), como a própria tarefa recomenda; a verificação a partir de outro host da rede não foi feita.

