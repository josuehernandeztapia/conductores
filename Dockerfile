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

WORKDIR /app

# Only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server + static frontend
COPY --from=builder /app/dist ./dist

# Port — Express listens on 5000
ENV PORT=5000
ENV NODE_ENV=production
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.cjs"]
