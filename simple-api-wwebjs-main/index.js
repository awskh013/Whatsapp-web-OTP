import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import { MongoStore } from './store.js';
import dotenv from 'dotenv';
import qr2 from 'qrcode';
import fs from 'fs';
import { spawnSync } from 'child_process';

dotenv.config();

const app = express();
app.use(express.json());

const PORT                  = process.env.PORT || 3000;
const MONGODB_URI           = process.env.MONGODB_URI;
const CLIENT_ID             = 'primary'; // session key in DB = "RemoteAuth-primary"
const WHATSAPP_API_PASSWORD = process.env.WHATSAPP_API_PASSWORD || '';
const FORCE_PUPPETEER       = String(process.env.FORCE_PUPPETEER || 'false').toLowerCase() === 'true';
const AUTH_DIR              = '.wwebjs_auth';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing — set environment variable and redeploy.');
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure local auth dir exists so RemoteAuth's unlink() after save never
 * throws ENOENT on a fresh Render deploy.
 */
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
  return undefined;
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

// ─── Session check ────────────────────────────────────────────────────────────

/**
 * Directly queries the sessions collection to see if a saved session exists.
 * The key stored by store.js is always "RemoteAuth-<clientId>".
 */
async function sessionExistsInMongo() {
  try {
    const sessionKey = `RemoteAuth-${CLIENT_ID}`;
    const exists     = await store.sessionExists({ session: sessionKey });
    console.log(`🔍 Session "${sessionKey}" in MongoDB: ${exists ? '✅ FOUND' : '❌ NOT FOUND'}`);
    return exists;
  } catch (err) {
    console.warn('⚠️  sessionExistsInMongo error:', err.message);
    return false;
  }
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

  client.on('remote_session_saved', () =>
    console.log('💾 Remote session saved to MongoDB ✓')
  );

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
/**
 * Boot sequence:
 *  1. Init MongoStore (connects to MongoDB via MONGODB_URI)
 *  2. Check if "RemoteAuth-primary" session exists
 *     → YES: RemoteAuth will restore it automatically — no QR
 *     → NO:  RemoteAuth will generate a QR for first login
 *  3. Initialize WhatsApp client
 */
async function boot() {
  try {
    // Step 1 — connect to MongoDB via custom store
    store = new MongoStore();
    await store.init();

    // Step 2 — check for existing session
    const hasSession = await sessionExistsInMongo();

    if (hasSession) {
      console.log('🔄 Session found — restoring from MongoDB, no QR needed');
    } else {
      console.log('🆕 No session found — QR scan required for first login');
    }

    // Step 3 — init client (RemoteAuth handles restore or QR internally)
    await initWhatsAppClient();

  } catch (err) {
    console.error('❌ boot() failed:', err.message);
    console.log('♻️  Retrying boot in 20s...');
    setTimeout(() => boot(), 20_000);
  }
}

// ─── Express routes ───────────────────────────────────────────────────────────

app.get('/', (_req, res) =>
  res.send('✅ WhatsApp bot running. Use /whatsapp/login and /whatsapp/send')
);

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

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM — shutting down gracefully');
  try {
    if (client && clientReady) await client.destroy();
    if (store) await store.close();
  } catch {}
  process.exit(0);
});
