import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import { MongoClient, Binary } from 'mongodb';
import dotenv from 'dotenv';
import qr2 from 'qrcode';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

dotenv.config();

const app = express();
app.use(express.json());

const PORT                  = process.env.PORT || 3000;
const MONGODB_URI           = process.env.MONGODB_URI;
const CLIENT_ID             = 'primary';
const WHATSAPP_API_PASSWORD = process.env.WHATSAPP_API_PASSWORD || '';
const FORCE_PUPPETEER       = String(process.env.FORCE_PUPPETEER || 'false').toLowerCase() === 'true';
const AUTH_DIR              = '.wwebjs_auth';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let qrValue      = null;
let clientReady  = false;
let initializing = false;
let lastQrLogAt  = 0;
const QR_LOG_COOLDOWN_MS = 10_000;
let client = null;
let store  = null;

// ─── MongoStore (inline) ──────────────────────────────────────────────────────
class MongoStore {
  constructor() {
    this._client = null;
    this._col    = null;
  }

  async init() {
    this._client = new MongoClient(MONGODB_URI, {
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
    if (this._client) await this._client.close();
  }

  async sessionExists({ session }) {
    try {
      const count  = await this._col.countDocuments({ session_name: session });
      const exists = count > 0;
      console.log(`[MongoDB] sessionExists("${session}") → ${exists}`);
      return exists;
    } catch (err) {
      console.error('[MongoDB] sessionExists error:', err.message);
      return false;
    }
  }

  async save({ session: sessionPath }) {
    const zipPath    = sessionPath + '.zip';
    const sessionKey = path.basename(sessionPath);
    try {
      if (!fs.existsSync(zipPath)) throw new Error(`Zip not found at: ${zipPath}`);
      const data = fs.readFileSync(zipPath);
      await this._col.updateOne(
        { session_name: sessionKey },
        { $set: { session_name: sessionKey, zip_data: new Binary(data), updated_at: new Date() } },
        { upsert: true }
      );
      console.log(`[MongoDB] Session "${sessionKey}" saved ✓ (${data.length} bytes)`);
    } catch (err) {
      console.error('[MongoDB] save error:', err.message);
      throw err;
    }
  }

  async extract({ session: sessionKey, path: destPath }) {
    try {
      const doc = await this._col.findOne({ session_name: sessionKey });
      if (!doc) throw new Error(`Session "${sessionKey}" not found in MongoDB`);

      const raw = doc.zip_data;
      let buf;
      if (Buffer.isBuffer(raw))                  buf = raw;
      else if (raw && Buffer.isBuffer(raw.buffer)) buf = raw.buffer;
      else if (raw && typeof raw.value === 'function') buf = Buffer.from(raw.value(), 'binary');
      else buf = Buffer.from(raw);

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      fs.writeFileSync(destPath, buf);
      console.log(`[MongoDB] Session "${sessionKey}" extracted → ${destPath} ✓ (${buf.length} bytes)`);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`📁 Created local auth dir: ${AUTH_DIR}`);
  }
}

function detectChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const out = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 3000 });
        console.log(`ℹ️  Chromium at ${p}: ${(out.stdout || out.stderr || '').trim()}`);
        process.env.PUPPETEER_EXECUTABLE_PATH = p;
        return p;
      }
    } catch {}
  }
}

function buildPuppeteerOptions() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-background-timer-throttling',
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH)
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  else if (FORCE_PUPPETEER)
    opts.executablePath = '/usr/bin/chromium';
  return opts;
}

// ─── WhatsApp client ──────────────────────────────────────────────────────────
async function initWhatsAppClient() {
  if (initializing) return;
  initializing = true;

  detectChromium();
  ensureAuthDir();

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             CLIENT_ID,
      store,
      backupSyncIntervalMs: 300_000,
    }),
    puppeteer:          buildPuppeteerOptions(),
    takeoverOnConflict: true,
    restartOnAuthFail:  true,
    webVersionCache:    { type: 'none' },
  });

  client.on('qr', (q) => {
    qrValue = q;
    const now = Date.now();
    if (now - lastQrLogAt > QR_LOG_COOLDOWN_MS) {
      console.log('📱 QR generated — open /whatsapp/login to scan');
      lastQrLogAt = now;
    }
  });

  client.on('authenticated', () => console.log('✅ WhatsApp authenticated'));
  client.on('remote_session_saved', () => console.log('💾 Remote session saved to MongoDB ✓'));

  client.on('ready', () => {
    clientReady  = true;
    qrValue      = null;
    initializing = false;
    console.log('🤖 WhatsApp client READY — no QR needed next deploy');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ auth_failure:', msg);
    clientReady  = false;
    initializing = false;
  });

  client.on('disconnected', async (reason) => {
    console.warn('⚠️  disconnected:', reason);
    clientReady  = false;
    initializing = false;
    try { await client.destroy(); } catch {}
    console.log('♻️  Re-initializing in 15s...');
    setTimeout(() => initWhatsAppClient(), 15_000);
  });

  try {
    console.log('⚙️  client.initialize()...');
    await client.initialize();
  } catch (err) {
    console.error('❌ client.initialize() failed:', err.message);
    initializing = false;
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    store = new MongoStore();
    await store.init();

    const sessionKey = `RemoteAuth-${CLIENT_ID}`;
    const hasSession = await store.sessionExists({ session: sessionKey });

    if (hasSession) {
      console.log('🔄 Session found in MongoDB — restoring automatically, no QR needed');
    } else {
      console.log('🆕 No session found — QR scan required for first login');
    }

    await initWhatsAppClient();
  } catch (err) {
    console.error('❌ boot() failed:', err.message);
    console.log('♻️  Retrying in 20s...');
    setTimeout(() => boot(), 20_000);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('✅ WhatsApp bot running'));

app.get('/debug/session', async (_req, res) => {
  try {
    const sessionKey = `RemoteAuth-${CLIENT_ID}`;
    const exists     = await store.sessionExists({ session: sessionKey });
    return res.json({ ok: true, sessionKey, exists, clientReady, hasQR: !!qrValue });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/whatsapp/login', async (_req, res) => {
  if (clientReady) return res.send('✅ Already logged in');
  if (!qrValue)    return res.send('⏳ No QR yet — initializing or already logged in');
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send('Error generating QR');
    return res.send(`<img src="${src}" alt="Scan QR" style="width:300px" />`);
  });
});

app.get('/whatsapp/status', (_req, res) =>
  res.json({ ok: true, clientReady, hasQR: !!qrValue })
);

app.post('/whatsapp/send', async (req, res) => {
  try {
    if (WHATSAPP_API_PASSWORD && req.headers['x-password'] !== WHATSAPP_API_PASSWORD)
      return res.status(401).json({ ok: false, error: 'Invalid password' });

    const { phone, message } = req.body;
    if (!phone || !message)
      return res.status(400).json({ ok: false, error: 'phone & message required' });
    if (!clientReady)
      return res.status(503).json({ ok: false, error: 'Client not ready' });

    await client.sendMessage(`${phone}@c.us`, message, { sendSeen: false });
    return res.json({ ok: true, message: 'Message sent' });
  } catch (err) {
    console.error('❌ send error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log('⏳ Starting boot sequence in 3s...');
  setTimeout(() => boot(), 3_000);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM — shutting down gracefully');
  try {
    if (client && clientReady) await client.destroy();
    if (store) await store.close();
  } catch {}
  process.exit(0);
});
