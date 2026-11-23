# syntax=docker/dockerfile:1.7
# Imagem única do MoneyFlow (tmsoftbrasil/moneyflow): a API serve o SPA compilado
# e o mesmo artefato roda como `api` (padrão) ou `worker` — pelo argumento
# (`docker run … worker`) ou pela variável MODE.

# Base fixada por versão e digest (tarefa 184), na versão do .nvmrc (tarefa 187; o CI confere que as duas
# batem). Para atualizar: a tag nova em https://hub.docker.com/_/node, o digest do índice multi-arch dela
# (`docker buildx imagetools inspect node:<versão>-bookworm-slim`) e o .nvmrc no mesmo commit.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node-base

FROM node-base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# O Node 25+ não traz o corepack: o pnpm vem na versão do packageManager do package.json.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")"
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm build

FROM node-base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/web \
    TZ=America/Sao_Paulo
WORKDIR /app
# Cliente do PostgreSQL 18 (pg_dump/pg_restore/psql) para o dump e a restauração do banco
# (Administração → Backup e restauração, spec 019), do repositório oficial (PGDG). A major é a do servidor
# (18, database/docker/Dockerfile); a versão menor acompanha o PGDG, que só mantém a mais nova no repositório.
# A chave do PGDG é conferida pelo sha256 do arquivo (impressão digital B97B 0AFC AA1A 47F0 44F2 44A0 7FCC
# 7D46 ACCC 4CF8, tarefa 184): se o arquivo mudar, o build para e a troca vira deliberada.
ARG PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "${PGDG_KEY_SHA256}  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" | sha256sum -c - \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# A API e o worker vão num único bundle (sem node_modules); o SPA ao lado.
COPY --from=build /app/apps/server/dist/ ./
COPY --from=build /app/apps/web/dist/ ./web/
USER node
EXPOSE 3000
# Saúde pelo modo do processo (argumento ou MODE, tarefa 107): a API pelo /api/health; o worker pelo batimento
# que o laço de mensagens grava a cada passada que chega ao banco (até 3 intervalos, mínimo 90 s).
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["node", "--enable-source-maps", "/app/main.mjs"]
