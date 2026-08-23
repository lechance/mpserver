FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache su-exec
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/uploads /app/db && chown -R app:app /app/uploads /app/db \
    && chmod +x /app/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
