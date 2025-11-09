# syntax=docker/dockerfile:1

# ---- Base builder image ----
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Production runtime image ----
FROM node:22-alpine AS runner

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Copy example accounts file for convenience (not required)
COPY accounts.example.json ./accounts.example.json

ENV NODE_ENV=production \
    ANALYZER_BODY_MAX_CHARS=3000

# Default command: run the watcher
CMD ["node", "dist/emailWatcher.js"]
