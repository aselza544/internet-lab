FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
RUN pnpm deploy --filter @workspace/api-server --prod /out --legacy

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY --from=build /app/artifacts/api-server/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json

EXPOSE 5000
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]