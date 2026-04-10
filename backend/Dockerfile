# Build stage
FROM node:20-bookworm-slim AS builder

# Build tools for native modules (re2, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM node:20-bookworm-slim

# Install Chromium, its dependencies, and build tools for native modules (re2, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    fonts-liberation \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for Playwright
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy built app and production deps (needs build tools for re2/bcrypt)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

EXPOSE 3000
CMD ["node", "dist/index.js"]
