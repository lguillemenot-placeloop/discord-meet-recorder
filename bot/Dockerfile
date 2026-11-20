FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && rm -f dist/*.test.js && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Le volume nommé monté sur /data reprend ce propriétaire à sa création.
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "dist/index.js"]
