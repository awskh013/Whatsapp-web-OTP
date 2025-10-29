# =======================================================
# 🚀 Whisper Light WhatsApp Bot - Render Optimized Build
# =======================================================

FROM node:22-bullseye-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 🧩 Puppeteer dependencies (Chromium minimal)
RUN apt-get update && apt-get install -y \
    chromium \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libnss3 \
    libxss1 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libx11-6 \
    libx11-xcb1 \
    libxi6 \
    libgtk-3-0 \
    ca-certificates \
    fonts-liberation \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# 🧠 بيئة التشغيل
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
