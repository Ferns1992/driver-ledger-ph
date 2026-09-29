FROM node:22-alpine

WORKDIR /app

# Dependencies first so the layer caches across code changes.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js seed.js index.html manifest.json ./
COPY vendor ./vendor
COPY icon-192.png icon-512.png apple-touch-icon.png ./

# The SQLite file lives on a named volume mounted here, so data survives
# container replacement, image rebuilds and reboots. The chown matters: Docker
# seeds a fresh named volume with the uid/gid of this directory, so without it
# the unprivileged `node` user could not write the database.
RUN mkdir -p /data && chown -R node:node /data
ENV DB_PATH=/data/driverledger.db \
    PORT=4090 \
    NODE_ENV=production

EXPOSE 4090

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4090/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
