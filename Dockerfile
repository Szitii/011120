# The API server for Fly.io (see docs/manual/DEPLOY.md). Runs the TypeScript sources directly.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY contracts contracts
COPY backend/config backend/config
COPY backend/src backend/src

USER node
ENV MOBILE_API_HOST=0.0.0.0 MOBILE_API_PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "backend/src/http/supabase-mobile-server.ts"]
