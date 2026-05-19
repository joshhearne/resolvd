FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Build identity — supplied via docker-compose build.args. Falls back to
# "dev" / "unknown" / build-time clock when unset (local dev builds).
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG BUILT_AT
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
ENV BUILT_AT=$BUILT_AT

EXPOSE 3001

CMD ["node", "server.js"]
