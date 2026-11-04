FROM node:20-alpine

WORKDIR /app

# Salin manifest dependensi terlebih dahulu untuk optimasi layer cache Docker
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Salin kode aplikasi
COPY server.js words.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Healthcheck otomatis untuk Docker / VPS orchestrator
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

USER node

CMD ["node", "server.js"]
