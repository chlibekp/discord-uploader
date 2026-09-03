# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the allowBuilds settings; without it pnpm refuses
# to run the esbuild postinstall and exits non-zero.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime configuration (set these in Railway, not here):
#   Required: DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN,
#             PUBLIC_URL, REDIS_URL
#   Optional: DATA_DIR         (default /data)
#             MAX_FILE_BYTES   (default 2147483648  – 2 GB per file)
#             MAX_TOTAL_BYTES  (default 4831838208  – whole-volume cap)
#             MAX_USER_BYTES   (default 2147483648  – 2 GB per uploader)
#             PORT             (default 3000, set by Railway)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

# Runs as root because the Railway volume is mounted at /data owned by root.
# Dropping to the node user would need a privileged chown on every boot, which
# costs more than it buys in a single-tenant container.
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "dist/index.js"]
