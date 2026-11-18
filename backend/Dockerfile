FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --include-workspace-root

COPY backend backend
RUN npm run prisma:generate -w backend
RUN npm run build -w backend

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --include-workspace-root --omit=dev \
  && npm cache clean --force

COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/prisma backend/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma

# Run as the unprivileged "node" user shipped in the base image (uid 1000)
# instead of root. The backend only needs to write to its storage
# directory (a named volume, initialised with this ownership) and to read
# dist/prisma; ports 3000 and the Prisma deploy step need no privileges.
# COPY preserves the host file modes, and a checkout with restrictive
# modes (e.g. package.json at 660) would leave the app unreadable for
# node, so the whole tree is re-owned to node before dropping privileges.
RUN mkdir -p /app/backend/storage && chown -R node:node /app
USER node

ENV NODE_ENV=production
WORKDIR /app

CMD ["sh", "-c", "npm run prisma:deploy -w backend && node backend/dist/main"]
