FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts/analyze-events.ts ./scripts/analyze-events.ts
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
