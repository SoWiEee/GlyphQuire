# syntax=docker/dockerfile:1.7
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
RUN pnpm --filter @glyphquire/worker... build && pnpm deploy --filter @glyphquire/worker --prod /out

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
USER node
CMD ["node", "dist/index.js"]
