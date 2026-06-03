import dotenv from 'dotenv';
import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import { MongoClient } from 'mongodb';
import archiver from 'archiver';
import qr2 from 'qrcode';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { execSync } from 'child_process';

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

// ─── Message Queue ────────────────────────────────────────────────────────────
const messageQueue   = [];
let   queueRunning   = false;
const QUEUE_INTERVAL = 5_000;
const SEND_DELAY_MS  = 5_000;

// ─── MongoStore ───────────────────────────────────────────────────────────────
class MongoStore {
  constructor() {
    this._client = null;
    this._db     = null;
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

    console.log('[MongoDB] Connected ✓');
  }

  async close() {
    if (this._client) await this._client.close();
  }

  async sessionExists({ session }) {
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: session });
      return !!file;
    } catch {
      return false;
    }
  }

  async save({ session: sessionDir }) {
    const sessionName = path.basename(sessionDir);

    try {
      if (!fs.existsSync(sessionDir)) {
        const alt = path.join(AUTH_DIR, sessionName);
        if (fs.existsSync(alt)) sessionDir = alt;
      }

      const zipBuffer = await this._zipDirectory(sessionDir);

      const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (oldFile) await this._bucket.delete(oldFile._id);

      await new Promise((resolve, reject) => {
        const upload = this._bucket.openUploadStream(sessionName);
        upload.on('error', reject);
        upload.on('finish', resolve);
        upload.end(zipBuffer);
      });

      console.log('✅ session saved');
    } catch (err) {
      console.error('Mongo save error:', err.message);
    }
  }

  async extract({ session: sessionName, path: destZipPath }) {
    try {
      const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
      if (!file) throw new Error('Session not found');

      const dir = path.dirname(destZipPath);
      fs.mkdirSync(dir, { recursive: true });

      await new Promise((resolve, reject) => {
        const stream = this._bucket.openDownloadStream(file._id);
        const out = fs.createWriteStream(destZipPath);

        stream.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });

      execSync(`unzip -o "${destZipPath}" -d "${AUTH_DIR}/RemoteAuth-${CLIENT_ID}"`);
    } catch (err) {
      console.error('extract error:', err.message);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
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
        process.env.PUPPETEER_EXECUTABLE_PATH = p;
        return p;
      }
    } catch {}
  }
}

// ✅ FIX: prevent defunct chromium
function killChromium() {
  spawnSync('pkill', ['-9', '-f', 'chromium']);
  spawnSync('pkill', ['-9', '-f', 'chrome']);

  // IMPORTANT: cleanup zombie reaping
  spawnSync('bash', ['-c', 'wait || true']);
}

function removeChromeLocks(profileDir) {
  if (!fs.existsSync(profileDir)) return;

  const lockFiles = [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'lockfile',
    'DevToolsActivePort'
  ];

  for (const file of lockFiles) {
    try {
      const p = path.join(profileDir, file);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    } catch {}
  }
}

function buildPuppeteerOptions() {
  const opts = {
    headless: true,
    protocolTimeout: 180_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH)
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  return opts;
}

// ─── WhatsApp INIT ────────────────────────────────────────────────────────────
async function initWhatsAppClient() {
  if (initializing || clientReady) return;
  initializing = true;

  detectChromium();
  ensureAuthDir();

  const profileDir = path.join(AUTH_DIR, `RemoteAuth-${CLIENT_ID}`);
  const sessionKey = `RemoteAuth-${CLIENT_ID}`;
  const zipPath = path.join(AUTH_DIR, `${sessionKey}.zip`);

  killChromium();
  removeChromeLocks(profileDir);

  if (!fs.existsSync(profileDir) && store) {
    const exists = await store.sessionExists({ session: sessionKey });

    if (exists) {
      await store.extract({ session: sessionKey, path: zipPath });
    }
  }

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: CLIENT_ID,
      store,
      backupSyncIntervalMs: 60000,
      dataPath: AUTH_DIR,
    }),
    puppeteer: buildPuppeteerOptions(),
    takeoverOnConflict: true,
    restartOnAuthFail: true,
  });

  client.on('qr', (q) => {
    qrValue = q;
  });

  client.on('ready', () => {
    clientReady = true;
    initializing = false;
    qrValue = null;
  });

  client.on('auth_failure', () => {
    clientReady = false;
    initializing = false;
  });

  client.on('disconnected', async (reason) => {
    clientReady = false;
    initializing = false;

    try { await client.destroy(); } catch {}

    setTimeout(initWhatsAppClient, 15000);
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('init error:', err.message);
    initializing = false;

    killChromium();
    setTimeout(initWhatsAppClient, 8000);
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  store = new MongoStore();
  await store.init();
  await initWhatsAppClient();
}

// ─── ROUTES (UNCHANGED FULL) ──────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('<h1>WhatsApp Bot Running</h1>');
});

app.get('/whatsapp/login', (_req, res) => {
  if (!qrValue) return res.send('QR not ready');

  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.send('error');

    res.send(`<img src="${src}" />`);
  });
});

app.get('/whatsapp/status', (_req, res) => {
  res.json({ clientReady, hasQR: !!qrValue });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Running on ${PORT}`);
  setTimeout(boot, 3000);
});

// ─── SHUTDOWN SAFE ────────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  try {
    if (client) await client.destroy();
    if (store) await store.close();
  } catch {}
  process.exit(0);
});
