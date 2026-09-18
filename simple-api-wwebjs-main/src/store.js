import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MongoClient, GridFSBucket } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const AUTH_DIR = '.wwebjs_auth';

export class MongoStore {
  constructor() {
    this._client = null;
    this._db = null;
    this._bucket = null;
  }

  async init() {
    this._client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    });
    await this._client.connect();
    this._db = this._client.db('whatsapp_bot');
    this._bucket = new GridFSBucket(this._db);
    console.log('[MongoDB] Connected — GridFS ready ✓');
  }

  async sessionExists({ session }) {
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: session });
      return !!file;
    } catch (err) {
      return false;
    }
  }

  async save({ session: sessionDir }) {
    const sessionName = path.basename(sessionDir);
    const tempDir = path.join(process.cwd(), AUTH_DIR, `temp_${sessionName}`);

    console.log(`[MongoDB] save() — Archiving session: "${sessionName}"`);

    try {
      // 1. تنظيف ونسخ المجلد (Static Copy)
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      fs.cpSync(sessionDir, tempDir, { recursive: true });

      // 2. حذف الملفات التي تسبب ضخامة الحجم وتعليق المتصفح
      const toDelete = [
        'SingletonLock', 'SingletonCookie', 'SingletonSocket',
        'Default/Cache', 'Default/Code Cache', 'Default/GPUCache'
      ];
      toDelete.forEach(p => {
        const fullPath = path.join(tempDir, p);
        if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true });
      });

      // 3. حذف الملف القديم
      const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (oldFile) await this._bucket.delete(oldFile._id);

      // 4. الرفع باستخدام Stream مباشرة (بدون ملف zip وسيط على الديسك)
      await new Promise((resolve, reject) => {
        const uploadStream = this._bucket.openUploadStream(sessionName);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', reject);
        uploadStream.on('error', reject);
        uploadStream.on('finish', () => {
          console.log(`✅ [MongoDB] Session saved successfully.`);
          resolve();
        });

        archive.pipe(uploadStream);
        archive.directory(tempDir, false);
        archive.finalize();
      });

    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    } finally {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async extract({ session: sessionName, path: destZipPath }) {
    console.log(`[MongoDB] extract() — downloading: "${sessionName}"`);
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (!file) throw new Error('Session not found');

      const destDir = path.dirname(destZipPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const downloadStream = this._bucket.openDownloadStream(file._id);
      const writeStream = fs.createWriteStream(destZipPath);

      await pipeline(downloadStream, writeStream);

      // التأكد من أن نظام التشغيل أغلق الملف تماماً (flush إلى القرص)
      const fd = fs.openSync(destZipPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      // انتظار بسيط لضمان استقرار الملف قبل أن تقرأه مكتبة الواتساب
      await new Promise(r => setTimeout(r, 1000));

      const stats = fs.statSync(destZipPath);
      console.log(`✅ [MongoDB] File extracted: ${stats.size} bytes`);
    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
      throw err;
    }
  }

  async delete({ session: sessionName }) {
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (file) await this._bucket.delete(file._id);
      console.log(`🗑️ [MongoDB] Session deleted: ${sessionName}`);
    } catch (err) {
      console.error('[MongoDB] delete error:', err.message);
    }
  }
}
