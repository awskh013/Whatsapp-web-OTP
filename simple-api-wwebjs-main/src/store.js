import archiver from 'archiver';
import { createWriteStream, createReadStream } from 'fs';
import { Extract } from 'unzipper';

class MongoStore {
 constructor() {
 this._client = null;
 this._col = null;
 }
 async init() {
 this._client = new MongoClient(MONGODB_URI, {
 serverSelectionTimeoutMS: 10_000,
 connectTimeoutMS: 10_000,
 });
 await this._client.connect();
 const db = this._client.db('whatsapp_bot');
 this._col = db.collection('sessions');
 await this._col.createIndex({ session_name: 1 }, { unique: true });
 console.log('[MongoDB] Connected — collection: sessions ✓');
 }
 async close() {
 if (this._client) await this._client.close();
 }
 async sessionExists({ session }) {
 try {
 const count = await this._col.countDocuments({ session_name: session });
 const exists = count > 0;
 console.log(`[MongoDB] sessionExists("${session}") → ${exists}`);
 return exists;
 } catch (err) {
 console.error('[MongoDB] sessionExists error:', err.message);
 return false;
 }
 }
 async save({ session: sessionPath }) {
 const sessionKey = path.basename(sessionPath);
 try {
 // Zip the session directory
 const zipBuffer = await this._zipDirectory(sessionPath);
 
 await this._col.updateOne(
 { session_name: sessionKey },
 { $set: { session_name: sessionKey, zip_data: new Binary(zipBuffer), updated_at: new Date() } },
 { upsert: true }
 );
 console.log(`[MongoDB] Session "${sessionKey}" saved ✓ (${zipBuffer.length} bytes)`);
 } catch (err) {
 console.error('[MongoDB] save error:', err.message);
 throw err;
 }
 }
 async extract({ session: sessionName, path: destZipPath }) {
  try {
    const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
    if (!file) throw new Error(`Session "${sessionName}" not found`);

    const destDir = path.dirname(destZipPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const downloadStream = this._bucket.openDownloadStream(file._id);
    const writeStream = fs.createWriteStream(destZipPath);

    // استخدام pipeline لضمان إغلاق الملف بالكامل قبل المتابعة
    await pipeline(downloadStream, writeStream);
    
    console.log(`✅ File written to disk: ${destZipPath}`);
  } catch (err) {
    console.error('[MongoDB] extract error:', err);
    throw err;
  }
}
 async delete({ session: sessionKey }) {
 try {
 await this._col.deleteOne({ session_name: sessionKey });
 console.log(`[MongoDB] Session "${sessionKey}" deleted ✓`);
 } catch (err) {
 console.error('[MongoDB] delete error:', err.message);
 }
 }
 
 // Helper: zip a directory to buffer
 _zipDirectory(dirPath) {
 return new Promise((resolve, reject) => {
 const chunks = [];
 const archive = archiver('zip', { zlib: { level: 6 } });
 
 archive.on('data', (chunk) => chunks.push(chunk));
 archive.on('end', () => resolve(Buffer.concat(chunks)));
 archive.on('error', reject);
 
 archive.directory(dirPath, false);
 archive.finalize();
 });
 }
 
 // Helper: unzip buffer to directory
 _unzipBuffer(buffer, destDir) {
 return new Promise((resolve, reject) => {
 const { Readable } = require('stream');
 const stream = Readable.from(buffer);
 
 stream
 .pipe(Extract({ path: destDir }))
 .on('finish', resolve)
 .on('error', reject);
 });
 }
}
