'use strict';

const { MongoClient, Binary } = require('mongodb');
const path = require('path');
const fs = require('fs');

/**
 * MongoDB store for whatsapp-web.js RemoteAuth.
 *
 * RemoteAuth calls these methods with these exact signatures:
 *
 *  sessionExists({ session })
 *    → session = sessionName  e.g. "RemoteAuth-primary"
 *    → return Boolean
 *
 *  save({ session })
 *    → session = full path WITHOUT .zip  e.g. ".wwebjs_auth/RemoteAuth-primary"
 *    → zip lives at  session + ".zip"
 *    → read that zip → store in DB keyed by path.basename(session)
 *
 *  extract({ session, path })
 *    → session = sessionName  e.g. "RemoteAuth-primary"
 *    → path   = full destination path  e.g. ".wwebjs_auth/RemoteAuth-primary.zip"
 *    → read from DB → write to path
 *
 *  delete({ session })
 *    → session = sessionName  e.g. "RemoteAuth-primary"
 */
class MongoStore {
  constructor() {
    this._client = null;
    this._col    = null;
  }

  /** Call once before using. Connects and ensures index. */
  async init() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is not set');

    this._client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS:         10_000,
    });

    await this._client.connect();
    const db    = this._client.db('whatsapp_bot');
    this._col   = db.collection('sessions');

    await this._col.createIndex({ session_name: 1 }, { unique: true });
    console.log('[MongoDB] Connected — collection: sessions ✓');
  }

  // ─── Store interface ────────────────────────────────────────────────────────

  async sessionExists({ session }) {
    try {
      const count = await this._col.countDocuments({ session_name: session });
      return count > 0;
    } catch (err) {
      console.error('[MongoDB] sessionExists error:', err.message);
      return false;
    }
  }

  /**
   * RemoteAuth passes the FULL PATH (no .zip).
   * We read path + ".zip", store binary in DB, keyed by basename.
   */
  async save({ session: sessionPath }) {
    const zipPath    = sessionPath + '.zip';
    const sessionKey = path.basename(sessionPath); // e.g. "RemoteAuth-primary"

    try {
      if (!fs.existsSync(zipPath)) {
        throw new Error(`Zip not found at: ${zipPath}`);
      }
      const data = fs.readFileSync(zipPath);

      await this._col.updateOne(
        { session_name: sessionKey },
        {
          $set: {
            session_name: sessionKey,
            zip_data:     new Binary(data),
            updated_at:   new Date(),
          },
        },
        { upsert: true }
      );

      console.log(`[MongoDB] Session "${sessionKey}" saved ✓ (${data.length} bytes)`);
    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    }
  }

  /**
   * RemoteAuth passes sessionName + destination path (full path including .zip).
   * We read from DB and write the zip to destPath.
   */
  async extract({ session: sessionKey, path: destPath }) {
    try {
      const doc = await this._col.findOne({ session_name: sessionKey });
      if (!doc) throw new Error(`Session "${sessionKey}" not found in MongoDB`);

      const buf = doc.zip_data.buffer ?? Buffer.from(doc.zip_data.value());
      fs.writeFileSync(destPath, buf);

      console.log(`[MongoDB] Session "${sessionKey}" extracted → ${destPath} ✓`);
    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
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
}

module.exports = { MongoStore };
