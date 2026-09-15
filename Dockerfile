# syntax=docker/dockerfile:1

# Single-container image for Dokploy's Dockerfile-based deploy.
# No nginx (Dokploy's own Traefik handles routing/TLS) and no
# docker-compose (this is the only service in the deployment).

FROM node:22-alpine AS base
WORKDIR /app

# ---- deps: full install (incl. devDependencies), needed to build ----
FROM base AS deps
# bcrypt is a native addon; python3/make/g++ let node-gyp build it if no
# prebuilt binary matches this platform.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript and generate the Prisma client ----
FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- prod-deps: production-only node_modules ----
FROM base AS prod-deps
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: lean final image ----
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3020

COPY --from=prod-deps /app/node_modules ./node_modules
# dist/generated/prisma (the compiled Prisma client) comes along with
# dist/ automatically since prisma/schema.prisma's generator output is
# src/generated/prisma, which nest build compiles like any other source.
COPY --from=build /app/dist ./dist
# prisma/ (schema + migrations) and prisma.config.ts are not compiled by
# nest build (see tsconfig.build.json's exclude list) — the Prisma CLI
# reads them directly, so they're copied as-is for `prisma migrate deploy`.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY package.json ./package.json

EXPOSE 3020

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# Applies any pending migrations, then starts the app. DATABASE_URL and
# every other secret come from Dokploy's environment configuration, never
# from this image.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
