# Build context: the repository root (the contract lives in api/).
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.11.2
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY api/ /src/api/
COPY web/ ./
# `pnpm build` first checks the generated client types against the contract.
RUN pnpm build

FROM nginx:1.29-alpine
COPY deploy/local/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist /usr/share/nginx/html
