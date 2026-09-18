# ── Stage: production ──────────────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium, tini, and all system libraries Puppeteer needs.
# tini is the fix for zombie processes: without a real init process at PID 1,
# Node never reaps orphaned/defunct chromium child processes inside the
# container, and they pile up as zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libgdk-pixbuf2.0-0 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      lsb-release \
      wget \
      xdg-utils \
      procps \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer/whatsapp-web.js to use the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package file
COPY package.json ./

# Install all dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

EXPOSE 3000

# tini as PID 1: forwards signals correctly (so SIGTERM from Render reaches
# node) AND reaps zombie child processes that chromium leaves behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
