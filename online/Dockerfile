# MODULUS online — one container serves the client and the relay on one port.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY core.js server.js prod-server.js rating.js store.js verify.js modulus-online.html ./
# The trustless ladder persists here; mount a volume at /data to keep it.
RUN mkdir -p /data
EXPOSE 8080
ENV PORT=8080 REVEAL_TIMEOUT_MS=30000 GRACE_MS=20000 LADDER_FILE=/data/leaderboard.json
VOLUME ["/data"]
CMD ["node", "prod-server.js"]
