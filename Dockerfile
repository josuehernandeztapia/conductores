# === BUILD STAGE ===
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies (including dev for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# === PRODUCTION STAGE ===
FROM node:20-slim AS production

# Install poppler-utils (PDF-to-image) + LibreOffice (DOCX-to-PDF)
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils libreoffice-nogui && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server + static frontend + templates + public assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/templates ./server/templates
COPY --from=builder /app/public ./public

# Port — Express listens on 5000
ENV PORT=5000
ENV NODE_ENV=production
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.cjs"]
