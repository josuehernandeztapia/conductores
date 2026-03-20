# === BUILD STAGE ===
FROM node:20-alpine AS builder

WORKDIR /app

# Instalar dependencias
COPY package.json package-lock.json ./
RUN npm ci

# Copiar fuente y compilar
COPY . .
RUN npm run build

# === PRODUCTION STAGE ===
FROM node:20-alpine AS production

WORKDIR /app

# Solo copiar lo necesario para producción
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copiar build output y servidor Fly.io
COPY --from=builder /app/dist ./dist
COPY fly-server.js ./

# Puerto de Fly.io
ENV PORT=3000
ENV DATABASE_URL='postgresql://neondb_owner:npg_hCtzqljdPT25@ep-rough-rain-ae4fggag-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require'
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "fly-server.js"]
