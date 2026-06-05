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
      const exists = !!files;
      console.log(`[MongoDB] sessionExists("${session}") → ${exists}`);
      return exists;
    } catch (err) {
      return false;
    }
  }

  async save({ session: sessionDir }) {
    const sessionName = path.basename(sessionDir);
    console.log(`[MongoDB] save() — zipping directory: "${sessionDir}"`);
    try {
      if (!fs.existsSync(sessionDir)) {
        const alt = path.join(AUTH_DIR, sessionName);
        if (fs.existsSync(alt)) sessionDir = alt;
        else throw new Error(`Session directory not found: "${sessionDir}"`);
      }
      
      const zipBuffer = await this._zipDirectory(sessionDir);
      
      try {
        const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
        if (oldFile) await this._bucket.delete(oldFile._id);
      } catch {}
      
      await new Promise((resolve, reject) => {
        const uploadStream = this._bucket.openUploadStream(sessionName);
        uploadStream.on('error', reject);
        uploadStream.on('finish', resolve);
        uploadStream.end(zipBuffer);
      });
      console.log(`✅ [MongoDB] Session "${sessionName}" saved (${zipBuffer.length} bytes)`);
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
      
      // استخدام pipeline يضمن إغلاق الملف بنسبة 100% قبل المتابعة
      await pipeline(downloadStream, writeStream);
      
      const stats = fs.statSync(destZipPath);
      console.log(`✅ [MongoDB] Session written successfully (${stats.size} bytes)`);
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
  
  _zipDirectory(dirPath) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('data', (chunk) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
      
      // [الحل السحري هنا] استثناء ملفات القفل لمنع حفظها في الداتابيز
      archive.glob('**/*', {
        cwd: dirPath,
        ignore: [
          'SingletonLock',
          'session/SingletonLock',
          'SingletonCookie',
          'SingletonSocket'
        ]
      });
      archive.finalize();
    });
  }
}
