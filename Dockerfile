# Multi-stage production Dockerfile for DATA MESH
FROM node:20-alpine AS dependencies
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /usr/src/app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy node_modules from dependencies stage
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY package*.json ./

# Copy backend and frontend assets
COPY src/ ./src/
COPY index.html ./
COPY style.css ./
COPY app.js ./

# Set security context
USER node

EXPOSE 3000

# Docker native health check hitting the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); const port = process.env.PORT || 3000; http.get('http://127.0.0.1:' + port + '/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]

