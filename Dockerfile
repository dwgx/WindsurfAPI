FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data \
    LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64 \
    LS_PORT=42100

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY install-ls.sh setup.sh .env.example ./

RUN sed -i 's/\r$//' install-ls.sh setup.sh \
    && chmod +x install-ls.sh setup.sh \
    && mkdir -p /data /opt/windsurf/data/db /tmp/windsurf-workspace

EXPOSE 3003

VOLUME ["/data", "/opt/windsurf", "/tmp/windsurf-workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
