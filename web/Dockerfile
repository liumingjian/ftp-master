# Build context: the repository root (the contract lives in api/).
# glibc, not alpine: rollup's native parser overflows musl's small thread stack.
FROM node:24-slim AS development
RUN npm install -g pnpm@12.11.2
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY api/ /src/api/
COPY web/ ./

FROM development AS build
# `pnpm build` first checks the generated client types against the contract.
RUN pnpm build

FROM nginx:1.29-alpine
COPY deploy/local/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist /usr/share/nginx/html
