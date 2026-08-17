FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production

FROM node:20-bookworm-slim AS runner
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 express
COPY --from=deps --chown=express:nodejs /app/node_modules ./node_modules
COPY --chown=express:nodejs . .
USER express
EXPOSE 5000
ENV NODE_ENV=production \
    PORT=5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error http://localhost:5000/api/health > /dev/null || exit 1
CMD ["node", "src/server.js"]
