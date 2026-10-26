# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca bun install --frozen-lockfile --production; \
    else bun install --frozen-lockfile --production; fi

FROM oven/bun:1.3.14
WORKDIR /app/server
ENV NODE_ENV=production DATA_DIR=/data PORT=3001
COPY --from=dependencies /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/drizzle ./drizzle
COPY shared /app/shared
EXPOSE 3001
CMD ["bun", "src/index.ts"]
