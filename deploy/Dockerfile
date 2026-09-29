FROM node:24-alpine
WORKDIR /app
COPY deploy/package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY --chown=node:node dist-server ./dist-server
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist-server/index.mjs"]
