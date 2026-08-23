FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN addgroup app && adduser -G app -S app \
    && mkdir -p /app/uploads /app/db && chown -R app:app /app/uploads /app/db
USER app
EXPOSE 3000
CMD ["node", "server.js"]
