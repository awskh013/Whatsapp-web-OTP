FROM node:22

# تحديث apt وتثبيت libs اللازمة لـ Puppeteer
RUN apt-get update && apt-get install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
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
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# إعداد مجلد العمل
WORKDIR /usr/src/app

# نسخ ملفات package.json و package-lock.json
COPY package.json package-lock.json* ./

# تثبيت dependencies
RUN npm install

# نسخ باقي الملفات
COPY . .

# تعيين البورت
ENV PORT=3000

# فتح البورت
EXPOSE 3000

# أمر تشغيل البوت
CMD ["node", "main.js"]
