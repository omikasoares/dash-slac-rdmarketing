FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app/data
USER app

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
