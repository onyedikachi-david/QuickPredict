# Bun runs the TypeScript entry directly — no build step needed.
# (Repo still uses the pre-Bun-1.2 binary lockfile, hence bun.lockb.)
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY locales ./locales
COPY src ./src

# SQLite lives on a mounted volume in deployment (see fly.toml / docker-compose).
ENV DB_PATH=/data/quick-predict.db
RUN mkdir -p /data

# Only used in webhook mode; harmless under polling.
EXPOSE 3000

CMD ["bun", "src/index.ts"]
