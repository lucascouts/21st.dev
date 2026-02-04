# Multi-stage build for smaller image
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy application code
COPY . .

# Build TypeScript
RUN bun run build

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Command will be provided by smithery.yaml
CMD ["bun", "dist/index.js"] 