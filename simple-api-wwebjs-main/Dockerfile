# Use lightweight Node image
FROM node:22-bullseye

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Puppeteer dependencies
RUN apt-get update && apt-get install -y \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libnss3 \
    libxss1 \
    libxshmfence1 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libxdamage1 \
    libxfixes3 \
    ca-certificates \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
