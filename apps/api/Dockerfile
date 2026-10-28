# TEMPLATE — not built in the authoring environment (no Docker daemon). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t surveyflow-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm ci --workspace @surveyflow/api --workspace @surveyflow/shared --include-workspace-root
RUN npm run build -w @surveyflow/api && npm prune --omit=dev

FROM node:22-bookworm-slim
# Chromium for the PDF export (Puppeteer), openssl for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PORT=4223
WORKDIR /app
COPY --from=build /app /app
EXPOSE 4223
# Run `npx prisma migrate deploy --config apps/api/prisma.config.ts` as the release/pre-deploy command (Prisma 7 reads its settings from that file).
CMD ["node", "apps/api/dist/server.js"]
