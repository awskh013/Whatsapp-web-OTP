'use strict';

const { MongoClient, Binary } = require('mongodb');
const path = require('path');
const fs = require('fs');

class MongoStore {
  constructor() {
    this._client = null;
    this._col    = null;
  }

  /** Initialize MongoDB connection */
  async init() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is not set');

    this._client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    await this._client.connect();

    const db = this._client.db('whatsapp_bot');
    this._col = db.collection('sessions');

    await this._col.createIndex({ session_name: 1 }, { unique: true });

    console.log('[MongoDB] Connected — collection: sessions ✓');
  }

  // ─────────────────────────────────────────────────────────────
  // 🔹 Helper: Restore session on server restart
  // ─────────────────────────────────────────────────────────────
  async restoreIfExists(sessionName, sessionPath) {
    try {
      const exists = await this.sessionExists({ session: sessionName });

      if (!exists) {
        console.log(`[MongoDB] No stored session for "${sessionName}"`);
        return false;
      }

      const zipPath = sessionPath + '.zip';

      // Ensure directory exists
      const dir = path.dirname(zipPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      console.log(`[MongoDB] Restoring session "${sessionName}"...`);

      await this.extract({
        session: sessionName,
        path: zipPath,
      });

      console.log(`[MongoDB] Session "${sessionName}" restored ✓`);
      return true;

    } catch (err) {
      console.error('[MongoDB] restoreIfExists error:', err.message);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 🔹 Store interface (Required by RemoteAuth)
  // ─────────────────────────────────────────────────────────────

  async sessionExists({ session }) {
    try {
      const count = await this._col.countDocuments({
        session_name: session,
      });
      return count > 0;
    } catch (err) {
      console.error('[MongoDB] sessionExists error:', err.message);
      return false;
    }
  }

  /**
   * Save session zip into MongoDB
   */
  async save({ session: sessionPath }) {
    const zipPath    = sessionPath + '.zip';
    const sessionKey = path.basename(sessionPath);

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
            zip_data: new Binary(data),
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );

      console.log(
        `[MongoDB] Session "${sessionKey}" saved ✓ (${data.length} bytes)`
      );

    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    }
  }

  /**
   * Extract session zip from MongoDB to filesystem
   */
  async extract({ session: sessionKey, path: destPath }) {
    try {
      const doc = await this._col.findOne({
        session_name: sessionKey,
      });

      if (!doc) {
        throw new Error(`Session "${sessionKey}" not found in MongoDB`);
      }

      const buf =
        doc.zip_data?.buffer ??
        Buffer.from(doc.zip_data?.value?.() || []);

      if (!buf || buf.length === 0) {
        throw new Error('Stored zip is empty or invalid');
      }

      fs.writeFileSync(destPath, buf);

      console.log(
        `[MongoDB] Session "${sessionKey}" extracted → ${destPath} ✓`
      );

    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
      throw err;
    }
  }

  /**
   * Delete session from MongoDB
   */
  async delete({ session: sessionKey }) {
    try {
      await this._col.deleteOne({
        session_name: sessionKey,
      });

      console.log(`[MongoDB] Session "${sessionKey}" deleted ✓`);

    } catch (err) {
      console.error('[MongoDB] delete error:', err.message);
    }
  }

  /** Optional: Close DB connection cleanly */
  async close() {
    if (this._client) {
      await this._client.close();
      console.log('[MongoDB] Connection closed');
    }
  }
}

module.exports = { MongoStore };
