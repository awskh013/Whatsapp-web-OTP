import dotenv from 'dotenv';
import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';
import qr2 from 'qrcode';
import fs from 'fs';
import path from 'path';
import { spawnSync, execSync } from 'child_process';

dotenv.config();

const app = express();
app.use(express.json());

const PORT                  = process.env.PORT || 3000;
const MONGODB_URI           = process.env.MONGODB_URI;
const CLIENT_ID             = 'primary';
const WHATSAPP_API_PASSWORD = process.env.WHATSAPP_API_PASSWORD || '';
const FORCE_PUPPETEER       = String(process.env.FORCE_PUPPETEER || 'false').toLowerCase() === 'true';
const AUTH_DIR              = '.wwebjs_auth';
// Save more often than the wwebjs-mongo default (300s) so a crash/redeploy
// loses at most this much recent state instead of up to 5 minutes.
const BACKUP_SYNC_MS        = Number(process.env.BACKUP_SYNC_MS || 60_000);

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
const SEND_DELAY_MS  = 1_000; // gap between sends within the same batch

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`📁 Created local auth dir: ${AUTH_DIR}`);
  }
}

// Kill any chromium processes not attached to our current client, and clear
// stale singleton locks. Safe to call repeatedly — it's a no-op when clean.
function cleanupStaleProcesses() {
  try {
    console.log('🧹 Cleaning up stale browser processes and locks...');
    execSync('pkill -9 -f chrom(e|ium) || true', { stdio: 'ignore' });

    const lockFiles = [
      path.join(process.cwd(), AUTH_DIR, 'SingletonLock'),
      path.join(process.cwd(), AUTH_DIR, 'SingletonCookie'),
      path.join(process.cwd(), AUTH_DIR, 'SingletonSocket'),
    ];
    lockFiles.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  } catch (e) {
    console.warn('⚠️ cleanupStaleProcesses:', e.message);
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
    protocolTimeout: 180_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  else if (FORCE_PUPPETEER) opts.executablePath = '/usr/bin/chromium';
  return opts;
}

// Destroy the client but never hang forever — if browser.close() doesn't
// return in time, SIGKILL the chromium process directly so it can't
// become an orphan/zombie.
async function destroyClientSafely() {
  if (!client) return;
  const browser = client.pupBrowser;
  try {
    await Promise.race([
      client.destroy(),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ]);
  } catch (e) {
    console.warn('⚠️ client.destroy() error:', e.message);
  }
  try {
    const proc = browser?.process?.();
    if (proc && proc.exitCode === null) {
      console.warn('⚠️ Browser process still alive after destroy — killing it');
      proc.kill('SIGKILL');
    }
  } catch {}
}

// ─── WhatsApp client ──────────────────────────────────────────────────────────
async function initWhatsAppClient() {
  if (initializing) return;
  initializing = true;

  ensureAuthDir();
  cleanupStaleProcesses();
  detectChromium();

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: CLIENT_ID,
      store,
      backupSyncIntervalMs: BACKUP_SYNC_MS,
      dataPath: AUTH_DIR,
    }),
    puppeteer: buildPuppeteerOptions(),
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    webVersionCache: { type: 'none' },
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
    await destroyClientSafely();
    cleanupStaleProcesses();
    console.log('♻️  Re-initializing in 15s...');
    setTimeout(() => initWhatsAppClient(), 15_000);
  });

  try {
    console.log('⚙️  client.initialize()...');
    await client.initialize();
  } catch (err) {
    console.error('❌ client.initialize() failed:', err.message);
    initializing = false;
    await destroyClientSafely();
    cleanupStaleProcesses();
  }
}

let isBooting = false;
async function boot() {
  if (isBooting) return;
  isBooting = true;

  try {
    cleanupStaleProcesses();

    // Official wwebjs-mongo store — matches RemoteAuth's internal
    // save/extract/exists calling convention exactly, unlike a hand-rolled
    // GridFS store. It needs a live mongoose connection, not a bare
    // MongoClient.
    await mongoose.connect(MONGODB_URI, { dbName: 'whatsapp_bot' });
    console.log('✅ Connected to MongoDB (mongoose)');
    store = new MongoStore({ mongoose });

    startQueueProcessor();
    await initWhatsAppClient();
  } catch (err) {
    console.error('❌ boot() failed:', err.message);
    console.log('♻️  Retrying in 20s...');
    setTimeout(() => boot(), 20_000);
  } finally {
    isBooting = false;
  }
}

// Periodic safety net: in case something outside our own lifecycle hooks
// (e.g. a Puppeteer crash we didn't catch) leaves an orphaned chromium
// process running with no attached client, sweep for defunct/zombie procs.
// tini (see Dockerfile) reaps zombies at the kernel level; this just makes
// sure we don't also accumulate *live* orphaned chromium processes.
setInterval(() => {
  if (!clientReady) return; // don't kill chromium while a legit launch is in progress
  try {
    const out = execSync('ps -eo pid,stat,comm | grep -i chrom | grep " Z" || true', { encoding: 'utf8' });
    if (out.trim()) console.warn('⚠️ zombie chromium entries seen (should be reaped by tini):', out.trim());
  } catch {}
}, 5 * 60_000);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('✅ WhatsApp bot. Use /whatsapp/login, /whatsapp/status, /whatsapp/send'));

app.get('/whatsapp/login', async (_req, res) => {
  if (clientReady) return res.send('✅ Already logged in');
  if (!qrValue) return res.send('⏳ No QR currently (initializing or already logged in)');
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send('Error generating QR');
    return res.send(`<img src="${src}" alt="QR" />`);
  });
});

app.get('/whatsapp/status', (_req, res) => res.json({ ok: true, clientReady, hasQR: !!qrValue }));

app.get('/debug/session', async (_req, res) => {
  try {
    const sessionKey = `RemoteAuth-${CLIENT_ID}`;
    const exists = store ? await store.sessionExists({ session: sessionKey }) : false;
    return res.json({ ok: true, sessionKey, exists, clientReady, hasQR: !!qrValue });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/whatsapp/send', (req, res) => {
  if (WHATSAPP_API_PASSWORD && req.headers['x-password'] !== WHATSAPP_API_PASSWORD)
    return res.status(401).json({ ok: false, error: 'Invalid password' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'phone & message required' });

  const id       = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const position = messageQueue.length + 1;

  messageQueue.push({ id, phone, message, queuedAt: new Date() });
  console.log(`📨 [Queue] Enqueued id=${id} phone=${phone} position=${position} queueSize=${messageQueue.length}`);

  return res.json({ ok: true, queued: true, id, position, queueSize: messageQueue.length });
});

app.get('/whatsapp/queue/status', (_req, res) => {
  res.json({
    ok: true,
    queueSize: messageQueue.length,
    running: queueRunning,
    items: messageQueue.map(({ id, phone, queuedAt }) => ({ id, phone, queuedAt })),
  });
});

// ─── Queue Processor ─────────────────────────────────────────────────────────
function startQueueProcessor() {
  if (queueRunning) return;
  queueRunning = true;
  console.log(`⏱️  [Queue] Processor started — interval ${QUEUE_INTERVAL / 1000}s`);

  setInterval(async () => {
    if (messageQueue.length === 0) return;
    if (!clientReady) {
      console.warn(`⚠️  [Queue] Client not ready — skipping tick (${messageQueue.length} items waiting)`);
      return;
    }

    const batch = messageQueue.splice(0, messageQueue.length);
    console.log(`📤 [Queue] Processing ${batch.length} message(s)...`);

    for (let i = 0; i < batch.length; i++) {
      const { id, phone, message } = batch[i];
      try {
        await client.sendMessage(`${phone}@c.us`, message, { sendSeen: false });
        console.log(`✅ [Queue] Sent id=${id} → ${phone}`);
      } catch (err) {
        console.error(`❌ [Queue] Failed id=${id} → ${phone}:`, err.message);
        messageQueue.unshift({ id, phone, message, queuedAt: new Date(), retried: true });
        console.warn(`↩️  [Queue] Re-queued id=${id} for retry`);
      }
      // Fixed: was comparing batch.indexOf({...}) against a freshly-built
      // object, which is never found by reference (-1), so the delay never
      // fired correctly. Use the loop index instead.
      if (i < batch.length - 1) await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
  }, QUEUE_INTERVAL);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log('⏳ Starting boot sequence in 3s...');
  setTimeout(() => boot(), 3_000);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM — shutting down gracefully');
  try {
    if (client && clientReady) {
      // Force one last save before we lose the container's local disk.
      try { await store.save({ session: `RemoteAuth-${CLIENT_ID}` }); } catch (e) { console.warn('final save failed:', e.message); }
    }
    await destroyClientSafely();
    await mongoose.connection.close();
  } catch {}
  process.exit(0);
});
