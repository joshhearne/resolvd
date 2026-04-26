FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
# Don't copy package-lock.json into the build — npm/cli#4828 means a
# lockfile generated on glibc (CI / local dev) won't include rollup's
# musl optional native dep, and `npm ci` then fails on alpine. The
# host lockfile still drives CI reproducibility; the Docker build
# resolves cleanly per-platform on each rebuild.
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx-frontend.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
