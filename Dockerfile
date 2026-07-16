# Whale Wars — production image
FROM node:22-alpine

WORKDIR /app

# install only production deps (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# app source
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
