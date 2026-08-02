FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/control-plane/.next ./apps/control-plane/.next
COPY --from=builder /app/apps/control-plane/package.json ./apps/control-plane/package.json
EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/control-plane", "-H", "0.0.0.0", "-p", "3000"]
