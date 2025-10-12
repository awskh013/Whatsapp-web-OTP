# استخدم Node 22 الرسمي
FROM node:22

# إعداد مجلد العمل داخل الحاوية
WORKDIR /usr/src/app

# نسخ ملفات package.json و package-lock.json (إذا موجود)
COPY package.json package-lock.json* ./

# تثبيت جميع الـ dependencies
RUN npm install

# نسخ باقي ملفات المشروع
COPY . .

# تعيين متغير البيئة PORT
ENV PORT=3000

# البورت اللي رح يستمع له التطبيق
EXPOSE 3000

# أمر تشغيل البوت
CMD ["node", "main.js"]
