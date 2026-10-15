FROM node:24-alpine

WORKDIR /app
# The named volume mounted at /data inherits this owner on first use.
RUN mkdir -p /data && chown node:node /data

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

USER node
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=96 --disable-warning=ExperimentalWarning" \
    DATA_DIR=/data \
    PORT=3000 \
    TRUST_PROXY=1

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/main.js"]
