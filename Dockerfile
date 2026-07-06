# M3 阶段2 Task 8 e2e: content-backend dockerize（fastify Node service + pnpm ESM）
# 非 production-hardened——e2e 本地用；生产部署后续加固（secret/healthcheck/非 root 等）。
# 老 Lin 决策：content-backend 加 Dockerfile dockerize（2026-07-06）。
# FROM 用 host cached node image（docker mirror 1panel.live 403，绕 mirror 用 cn 变体 cache）。
FROM node:24-bookworm-slim-cn
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@latest --activate
WORKDIR /app
# 依赖层（cache 友好：先 copy lockfile + install，再 copy 源码）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# 源码 + migrations + audio fixtures（seed 用）+ tsconfig
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY test/fixtures/audio/ test/fixtures/audio/
COPY schemas/ schemas/
# 默认配置（docker-compose env 覆盖）
ENV PORT=3001 \
    NODE_ENV=production
EXPOSE 3001
# e2e: tsx 运行（不 tsc emit，避免 ESM dist 配置；production 后续可改 node dist/）
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
