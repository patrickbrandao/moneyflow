# syntax=docker/dockerfile:1.7
# Imagem única do MoneyFlow (tmsoftbrasil/moneyflow): a API serve o SPA compilado
# e o mesmo artefato roda como `api` (padrão) ou `worker` — pelo argumento
# (`docker run … worker`) ou pela variável MODE.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/web \
    TZ=America/Sao_Paulo
WORKDIR /app
# A API e o worker vão num único bundle (sem node_modules); o SPA ao lado.
COPY --from=build /app/apps/server/dist/ ./
COPY --from=build /app/apps/web/dist/ ./web/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "if (process.env.MODE === 'worker') process.exit(0); fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "--enable-source-maps", "/app/main.mjs"]
