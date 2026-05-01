'use strict';

import { MongoClient, Binary } from 'mongodb';
import path from 'path';
import fs from 'fs';

export class MongoStore {
  constructor() {
    this._client = null;
    this._col    = null;
  }

  async init() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is not set');

    this._client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS:         10_000,
    });

    await this._client.connect();
    const db  = this._client.db('whatsapp_bot');
    this._col = db.collection('sessions');

    await this._col.createIndex({ session_name: 1 }, { unique: true });
    console.log('[MongoDB] Connected — collection: sessions ✓');
  }

  async close() {
    if (this._client) {
      await this._client.close();
      console.log('[MongoDB] Connection closed ✓');
    }
  }

  // ─── Check if session exists ───────────────────────────────────────────────
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

  // ─── Save zip to MongoDB ───────────────────────────────────────────────────
 // src/store.js
async save({ session: sessionPath }) {
    const sessionKey = path.basename(sessionPath);
    
    // Logic to find the zip whether it's in the root or the auth folder
    const pathsToTry = [
        `${sessionPath}.zip`, 
        path.join('.wwebjs_auth', `${sessionKey}.zip`)
    ];

    const finalPath = pathsToTry.find(p => fs.existsSync(p));

    if (!finalPath) {
        console.error(`❌ Still can't find zip. Checked: ${pathsToTry}`);
        return; // Prevent crash
    }

    const data = fs.readFileSync(finalPath);
    await this._col.updateOne(
        { session_name: sessionKey },
        { $set: { 
            session_name: sessionKey, 
            zip_data: new Binary(data), 
            updated_at: new Date() 
        }},
        { upsert: true }
    );
    console.log(`✅ [MongoDB] Session saved from: ${finalPath}`);
}
  // ─── Extract zip from MongoDB to disk ─────────────────────────────────────
  async extract({ session: sessionKey, path: destPath }) {
    try {
      const doc = await this._col.findOne({ session_name: sessionKey });
      if (!doc) throw new Error(`Session "${sessionKey}" not found in MongoDB`);

      // Safe buffer extraction — works across all MongoDB driver versions
      const raw = doc.zip_data;
      let buf;
      if (Buffer.isBuffer(raw)) {
        buf = raw;
      } else if (raw && Buffer.isBuffer(raw.buffer)) {
        buf = raw.buffer;
      } else if (raw && typeof raw.value === 'function') {
        buf = Buffer.from(raw.value(), 'binary');
      } else {
        buf = Buffer.from(raw);
      }

      // Ensure destination directory exists (critical on fresh Render deploy)
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        console.log(`[MongoDB] Created directory: ${destDir}`);
      }

      fs.writeFileSync(destPath, buf);
      console.log(`[MongoDB] Session "${sessionKey}" extracted → ${destPath} ✓ (${buf.length} bytes)`);
    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
      throw err;
    }
  }

  // ─── Delete session from MongoDB ──────────────────────────────────────────
  async delete({ session: sessionKey }) {
    try {
      await this._col.deleteOne({ session_name: sessionKey });
      console.log(`[MongoDB] Session "${sessionKey}" deleted ✓`);
    } catch (err) {
      console.error('[MongoDB] delete error:', err.message);
    }
  }
}
