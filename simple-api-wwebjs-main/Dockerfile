FROM node:22-bullseye

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 🧩 تثبيت Chromium الخفيف
RUN apt-get update && apt-get install -y chromium-browser --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
