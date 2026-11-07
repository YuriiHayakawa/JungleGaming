FROM oven/bun:1.4.4

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

ENV NODE_ENV=production

# Sem etapa de build: o Bun executa o TypeScript direto (research R-18).
CMD ["bun", "src/main.ts"]
