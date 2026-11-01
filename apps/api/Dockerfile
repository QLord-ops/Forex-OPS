FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci --include=dev

COPY apps/api apps/api
RUN npm run build --workspace @ops/api

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@ops/api"]
