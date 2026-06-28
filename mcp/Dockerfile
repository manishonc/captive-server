FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src

# --include=dev forces devDependencies (typescript) even when NODE_ENV=production
# is injected at build time (Coolify does this), so `tsc` is available for the build.
# The prune step below strips devDependencies back out of the runtime image.
RUN npm install --include=dev && npm run build

RUN npm prune --production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 4001

CMD ["node", "dist/server.js"]
