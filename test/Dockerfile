FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY kit ./kit
COPY public ./public
COPY test ./test
COPY scripts ./scripts
COPY wrangler.jsonc ./
CMD ["bash", "test/e2e.sh"]
