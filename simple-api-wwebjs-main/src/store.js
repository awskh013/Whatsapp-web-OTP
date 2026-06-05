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
    console.log(`[MongoDB] save() — archiving directory: "${sessionDir}"`);
    try {
      if (!fs.existsSync(sessionDir)) {
        const alt = path.join(AUTH_DIR, sessionName);
        if (fs.existsSync(alt)) sessionDir = alt;
        else throw new Error(`Session directory not found: "${sessionDir}"`);
      }

      // حذف الجلسة القديمة قبل رفع الجديدة
      try {
        const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
        if (oldFile) await this._bucket.delete(oldFile._id);
      } catch {}

      // الربط المباشر (Pipe) لتجنب امتلاء الذاكرة وتلف الملف
      await new Promise((resolve, reject) => {
        const uploadStream = this._bucket.openUploadStream(sessionName);
        const archive = archiver('zip', { zlib: { level: 6 } });

        uploadStream.on('error', reject);
        uploadStream.on('finish', resolve); // يتم استدعاؤها فقط بعد إغلاق الملف بأمان في الداتابيز
        archive.on('error', reject);

        archive.pipe(uploadStream); // تمرير البيانات مباشرة إلى MongoDB

        // استخدام directory لجلب جميع الملفات بما فيها المخفية، واستثناء الأقفال
        archive.directory(sessionDir, false, (data) => {
          const file = data.name;
          if (
            file.includes('SingletonLock') ||
            file.includes('SingletonCookie') ||
            file.includes('SingletonSocket')
          ) {
            return false; // تجاهل ملفات القفل
          }
          return data;
        });

        archive.finalize();
      });

      console.log(`✅ [MongoDB] Session "${sessionName}" saved to GridFS successfully`);
    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
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

      // pipeline يضمن عدم استكمال الكود إلا بعد اكتمال كتابة الملف على القرص
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
