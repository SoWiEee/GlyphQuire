# syntax=docker/dockerfile:1.7
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213

WORKDIR /app
COPY --chown=node:node release-alert-runtime.ts release-alert-receiver.ts ./
COPY --chown=node:node release-alert-rules.yml release-alert-router.yml release-alert-evaluator.yml ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "--experimental-strip-types"]
CMD ["release-alert-runtime.ts"]
