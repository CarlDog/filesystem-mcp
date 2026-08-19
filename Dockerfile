# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS runtime
WORKDIR /app
RUN addgroup -S mcp && adduser -S mcp -G mcp
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --from=build --chown=mcp:mcp /app/package.json ./package.json
USER mcp

# HEALTHCHECK belongs HERE, not only in compose: an image run by anything other
# than that compose file (docker run, a different orchestrator, a k8s manifest)
# otherwise has no health signal at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
