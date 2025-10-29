# Use a lightweight Node image
FROM node:22-bullseye

WORKDIR /usr/src/app

# Copy and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Install puppeteer dependencies
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
    libxkbcommon0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxi6 \
    libgtk-3-0 \
    libdrm2 \
    ca-certificates \
    fonts-liberation \
    lsb-release \
    xdg-utils \
    wget \
    unzip \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install Chromium manually for puppeteer-core
RUN wget https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/1181136/chrome-linux.zip \
    && unzip chrome-linux.zip \
    && mv chrome-linux /usr/local/chromium \
    && rm chrome-linux.zip

# Set Chromium path for puppeteer-core
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/chromium/chrome
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
