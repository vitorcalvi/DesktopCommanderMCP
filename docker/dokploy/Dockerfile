FROM node:22-bookworm-slim AS build

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npm rebuild @vscode/ripgrep
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MCP_CLIENT_DOCKER=true \
    HOME=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       openssh-client \
       procps \
       iproute2 \
       util-linux \
       docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global supergateway@4.1.0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild @vscode/ripgrep \
    && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY docker/dokploy/auth-proxy.mjs /opt/desktop-commander/auth-proxy.mjs
COPY docker/dokploy/entrypoint.sh /usr/local/bin/desktop-commander-entrypoint
RUN chmod 0755 /usr/local/bin/desktop-commander-entrypoint /opt/desktop-commander/auth-proxy.mjs \
    && mkdir -p /data /workspace /host-home /dokploy

EXPOSE 8766
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8766/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/desktop-commander-entrypoint"]
