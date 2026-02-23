# Minimal Dockerfile for SCP TypeScript SDK
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . ./
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
