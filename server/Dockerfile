FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src

RUN npm install && npm run build

RUN npm prune --omit=dev

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 4000

CMD ["node", "dist/server.js"]
