import archiver from 'archiver';
import { createWriteStream, createReadStream } from 'fs';
import { Extract } from 'unzipper';

class MongoStore {
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
    const { GridFSBucket } = await import('mongodb');
    this._bucket = new GridFSBucket(this._db);
    console.log('[MongoDB] Connected — GridFS ready ✓');
  }

  async close() {
    if (this._client) await this._client.close();
  }

  async sessionExists({ session }) {
    try {
      const files = await this._db.collection('fs.files').findOne({ filename: session });
      return !!files;
    } catch (err) {
      return false;
    }
  }

  async save({ session: sessionDir }) {
    const sessionName = path.basename(sessionDir);
    console.log(`[MongoDB] save() — Safely archiving session: "${sessionDir}"`);
    
    // تحديد مسار المجلد المؤقت الآمن للنسخ
    const tempDir = path.join(process.cwd(), AUTH_DIR, `temp_${sessionName}`);
    
    try {
      if (!fs.existsSync(sessionDir)) {
        const alt = path.join(AUTH_DIR, sessionName);
        if (fs.existsSync(alt)) sessionDir = alt;
        else throw new Error(`Session directory not found: "${sessionDir}"`);
      }

      // 1. تنظيف أي بقايا للمجلد المؤقت إن وجدت
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      
      // 2. عمل نسخة طبق الأصل ثابتة (Static Copy) من الجلسة الحية لتجنب تداخل المتصفح
      fs.cpSync(sessionDir, tempDir, { recursive: true, force: true });

      // 3. تنظيف ملفات القفل والكاش من النسخة المؤقتة لضمان سلامة الـ ZIP وتقليل الحجم
      const itemsToDelete = [
        path.join(tempDir, 'SingletonLock'),
        path.join(tempDir, 'SingletonCookie'),
        path.join(tempDir, 'SingletonSocket'),
        path.join(tempDir, 'session', 'SingletonLock'),
        path.join(tempDir, 'Default', 'Cache'),
        path.join(tempDir, 'Default', 'Code Cache')
      ];

      itemsToDelete.forEach(item => {
        if (fs.existsSync(item)) {
          try {
            fs.rmSync(item, { recursive: true, force: true });
          } catch (e) {}
        }
      });

      // 4. حذف الملف القديم التالف من قاعدة البيانات
      try {
        const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
        if (oldFile) await this._bucket.delete(oldFile._id);
      } catch {}

      // 5. الرفع المباشر للمجلد المؤقت المستقر تماماً
      await new Promise((resolve, reject) => {
        const uploadStream = this._bucket.openUploadStream(sessionName);
        const archive = archiver('zip', { zlib: { level: 6 } });

        uploadStream.on('error', reject);
        uploadStream.on('finish', resolve);
        archive.on('error', reject);

        archive.pipe(uploadStream);
        archive.directory(tempDir, false); // ضغط نقي 100% بدون فلاتر برمجية معقدة
        archive.finalize();
      });

      console.log(`✅ [MongoDB] Session "${sessionName}" saved cleanly and successfully to GridFS.`);
    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    } finally {
      // 6. ضمان تنظيف القرص وحذف المجلد المؤقت دائماً حتى لو حدث خطأ
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
      }
    }
  }

  async extract({ session: sessionName, path: destZipPath }) {
    console.log(`[MongoDB] extract() — writing zip to: "${destZipPath}"`);
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (!file) throw new Error(`Session "${sessionName}" not found`);

      const destDir = path.dirname(destZipPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const downloadStream = this._bucket.openDownloadStream(file._id);
      const writeStream = fs.createWriteStream(destZipPath);

      // pipeline تضمن اكتمال الكتابة على القرص وإغلاق الملف تماماً قبل المتابعة
      await pipeline(downloadStream, writeStream);

      const stats = fs.statSync(destZipPath);
      console.log(`✅ [MongoDB] Session "${sessionName}" written to "${destZipPath}" (${stats.size} bytes)`);
    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
      throw err;
    }
  }

  async delete({ session: sessionName }) {
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (file) await this._bucket.delete(file._id);
      console.log(`[MongoDB] Session "${sessionName}" deleted ✓`);
    } catch (err) {}
  }
}
