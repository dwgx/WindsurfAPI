FROM node:20-bookworm-slim

ARG BUILD_VERSION=""
ARG BUILD_COMMIT=""
ARG BUILD_COMMIT_MESSAGE=""
ARG BUILD_COMMIT_DATE=""
ARG BUILD_BRANCH=""

ENV NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data \
    LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64 \
    LS_PORT=42100 \
    WINDSURFAPI_BUILD_VERSION=$BUILD_VERSION \
    WINDSURFAPI_BUILD_COMMIT=$BUILD_COMMIT \
    WINDSURFAPI_BUILD_COMMIT_MESSAGE=$BUILD_COMMIT_MESSAGE \
    WINDSURFAPI_BUILD_COMMIT_DATE=$BUILD_COMMIT_DATE \
    WINDSURFAPI_BUILD_BRANCH=$BUILD_BRANCH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY scripts/native-bridge-smoke.mjs ./scripts/native-bridge-smoke.mjs
COPY scripts/special-agent-smoke.mjs ./scripts/special-agent-smoke.mjs
COPY scripts/lsp-capacity-matrix.mjs ./scripts/lsp-capacity-matrix.mjs
COPY scripts/web-search-direct-probe.mjs ./scripts/web-search-direct-probe.mjs
COPY install-ls.sh setup.sh .env.example ./

RUN sed -i 's/\r$//' install-ls.sh setup.sh \
    && chmod +x install-ls.sh setup.sh \
    && mkdir -p /data /opt/windsurf/data/db /tmp/windsurf-workspace

EXPOSE 3003

VOLUME ["/data", "/opt/windsurf", "/tmp/windsurf-workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
