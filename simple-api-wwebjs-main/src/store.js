'use strict';

const mongoose = require('mongoose');
const fs       = require('fs');
const fsp      = require('fs').promises;
const path     = require('path');

const SESSION_DIR = '/app/.wwebjs_auth';
const UPDATE_INTERVAL_MS = 30_000; // sync to MongoDB every 30s

// ─── Mongoose schema ──────────────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  session_name: { type: String, required: true, unique: true },
  zip_data:     { type: Buffer, required: true },
  updated_at:   { type: Date,   default: Date.now },
});
const Session = mongoose.models.Session
  || mongoose.model('Session', sessionSchema, 'sessions');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Make sure the auth directory exists */
async function ensureDir() {
  await fsp.mkdir(SESSION_DIR, { recursive: true });
}

/** Is this a valid non-empty zip buffer? */
function isValidZip(buf) {
  // ZIP magic bytes: PK (0x50 0x4B)
  return Buffer.isBuffer(buf) && buf.length > 22
    && buf[0] === 0x50 && buf[1] === 0x4B;
}

// ─── MongoStore ───────────────────────────────────────────────────────────────
class MongoStore {

  constructor() {
    this._autoSaveTimers = {}; // per-session interval handles
  }

  // ── init ────────────────────────────────────────────────────────────────────
  async init() {
    if (mongoose.connection.readyState === 1) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB || 'whatsapp-bot',
    });
    console.log('[MongoDB] Connected ✓');
  }

  // ── sessionExists ────────────────────────────────────────────────────────────
  async sessionExists(options) {
    const name = options.session;
    const doc  = await Session.findOne({ session_name: name }).lean();
    if (!doc) return false;

    // Validate stored zip — if corrupted, remove it so wwebjs asks for a fresh QR
    if (!isValidZip(doc.zip_data)) {
      console.warn(`[MongoDB] Corrupted session detected (${name}) — deleting`);
      await Session.deleteOne({ session_name: name });
      return false;
    }

    console.log(`[MongoDB] Valid session found: ${name}`);
    return true;
  }

  // ── save ─────────────────────────────────────────────────────────────────────
  async save(options) {
    const name    = options.session;
    const zipPath = path.join(SESSION_DIR, `${name}.zip`);

    try {
      await ensureDir();

      if (!fs.existsSync(zipPath)) {
        console.warn(`[MongoDB] save called but zip not found on disk: ${zipPath}`);
        return;
      }

      const buf = await fsp.readFile(zipPath);

      if (!isValidZip(buf)) {
        console.warn(`[MongoDB] save skipped — zip on disk is invalid (${name})`);
        return;
      }

      await Session.findOneAndUpdate(
        { session_name: name },
        { zip_data: buf, updated_at: new Date() },
        { upsert: true, new: true }
      );

      console.log(`[MongoDB] Session saved/updated: ${name}`);

      // Start auto-save loop after first successful save
      this._startAutoSave(name, zipPath);

    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    }
  }

  // ── extract ───────────────────────────────────────────────────────────────────
  async extract(options) {
    const name    = options.session;
    const zipPath = path.join(SESSION_DIR, `${name}.zip`);

    try {
      await ensureDir();

      const doc = await Session.findOne({ session_name: name });

      if (!doc) {
        throw new Error(`No session in MongoDB for: ${name}`);
      }

      if (!isValidZip(doc.zip_data)) {
        console.warn(`[MongoDB] extract — zip in DB is corrupted (${name}) — deleting`);
        await Session.deleteOne({ session_name: name });
        throw new Error(`Corrupted session deleted, fresh QR needed`);
      }

      await fsp.writeFile(zipPath, doc.zip_data);
      console.log(`[MongoDB] Session extracted to disk: ${name}`);

    } catch (err) {
      console.error('[MongoDB] extract error:', err.message);
      throw err;
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────────
  async delete(options) {
    const name    = options.session;
    const zipPath = path.join(SESSION_DIR, `${name}.zip`);

    try {
      this._stopAutoSave(name);
      await Session.deleteOne({ session_name: name });

      if (fs.existsSync(zipPath)) {
        await fsp.unlink(zipPath);
      }

      console.log(`[MongoDB] Session deleted: ${name}`);
    } catch (err) {
      console.error('[MongoDB] delete error:', err.message);
    }
  }

  // ── auto-save every 30s ───────────────────────────────────────────────────────
  _startAutoSave(name, zipPath) {
    if (this._autoSaveTimers[name]) return; // already running

    console.log(`[MongoDB] Auto-save started for ${name} (every ${UPDATE_INTERVAL_MS / 1000}s)`);

    this._autoSaveTimers[name] = setInterval(async () => {
      try {
        if (!fs.existsSync(zipPath)) return;
        const buf = await fsp.readFile(zipPath);
        if (!isValidZip(buf)) return;

        await Session.findOneAndUpdate(
          { session_name: name },
          { zip_data: buf, updated_at: new Date() },
          { upsert: true, new: true }
        );

        console.log(`[MongoDB] Auto-save ✓ ${name} @ ${new Date().toISOString()}`);
      } catch (err) {
        console.warn(`[MongoDB] Auto-save failed (${name}):`, err.message);
      }
    }, UPDATE_INTERVAL_MS);
  }

  _stopAutoSave(name) {
    if (this._autoSaveTimers[name]) {
      clearInterval(this._autoSaveTimers[name]);
      delete this._autoSaveTimers[name];
      console.log(`[MongoDB] Auto-save stopped for ${name}`);
    }
  }
}

module.exports = { MongoStore };
