# syntax=docker/dockerfile:1.7
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @glyphquire/web... build

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213
WORKDIR /app
ENV NODE_ENV=production PORT=4173
COPY --from=build /repo/apps/web/dist ./dist
USER node
EXPOSE 4173
CMD ["node", "-e", "require('http').createServer((q,r)=>r.end(require('fs').readFileSync('/app/dist/index.html'))).listen(process.env.PORT)"]
