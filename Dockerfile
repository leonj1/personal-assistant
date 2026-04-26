FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY prompts ./prompts

# Per-chat workspaces are written here at runtime; mount a volume to persist.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000

USER node

CMD ["node", "dist/index.js"]
