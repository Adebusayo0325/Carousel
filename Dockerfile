# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Install build tools for native addons (argon2, etc.)
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json* ./
COPY packages/core/package.json      ./packages/core/
COPY packages/api/package.json       ./packages/api/
COPY packages/worker/package.json    ./packages/worker/
COPY packages/cli/package.json       ./packages/cli/

RUN npm ci --ignore-scripts

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules    ./packages/core/node_modules
COPY --from=deps /app/packages/api/node_modules     ./packages/api/node_modules
COPY --from=deps /app/packages/worker/node_modules  ./packages/worker/node_modules

COPY . .

# Generate Prisma client
RUN npx prisma generate --schema=prisma/schema.prisma

# Build all packages
RUN npm run build

# ── Stage 3: Production API ───────────────────────────────────────────────────
FROM node:20-alpine AS api
WORKDIR /app

ENV NODE_ENV=production

# Security: run as non-root
RUN addgroup -g 1001 -S apex && adduser -S apex -u 1001

# Only copy what's needed
COPY --from=builder --chown=apex:apex /app/node_modules            ./node_modules
COPY --from=builder --chown=apex:apex /app/packages/core/dist      ./packages/core/dist
COPY --from=builder --chown=apex:apex /app/packages/api/dist       ./packages/api/dist
COPY --from=builder --chown=apex:apex /app/prisma                  ./prisma

USER apex

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/dist/app.js"]

# ── Stage 4: Production Worker ────────────────────────────────────────────────
FROM node:20-alpine AS worker
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S apex && adduser -S apex -u 1001

COPY --from=builder --chown=apex:apex /app/node_modules            ./node_modules
COPY --from=builder --chown=apex:apex /app/packages/core/dist      ./packages/core/dist
COPY --from=builder --chown=apex:apex /app/packages/api/dist       ./packages/api/dist
COPY --from=builder --chown=apex:apex /app/packages/worker/dist    ./packages/worker/dist
COPY --from=builder --chown=apex:apex /app/prisma                  ./prisma

USER apex

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "packages/worker/dist/worker.js"]
