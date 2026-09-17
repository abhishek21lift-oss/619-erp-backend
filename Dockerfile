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

# ── Release identity, baked at build time ──────────────────────────────────
#
# A production image contains no .git directory, so anything that shells out to
# `git rev-parse` at runtime returns "unknown" on precisely the machine where
# the answer matters. The sha has to arrive as a build argument.
#
# Defaulting to the literal string keeps a plain `docker build` working: it
# produces sha "unknown", which lib/release.js reports honestly rather than
# inventing a value that would sit next to the real ones looking authoritative.
ARG GIT_SHA=unknown
ARG BUILD_TIME=""
ENV NODE_ENV=production \
    PORT=5000 \
    GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error http://localhost:5000/api/health > /dev/null || exit 1
CMD ["node", "src/server.js"]
