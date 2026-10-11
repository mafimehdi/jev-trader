FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts/analyze-events.ts scripts/pull-events.ts ./scripts/
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
