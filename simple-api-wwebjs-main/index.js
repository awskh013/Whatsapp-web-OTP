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
// Each item: { id, phone, message, queuedAt, resolve, reject }
const messageQueue   = [];
let   queueRunning   = false;
const QUEUE_INTERVAL = 5_000;   // process every 5 seconds
const SEND_DELAY_MS  = 5_000;   // 1s gap between sends in the same batch

// ─── MongoStore ───────────────────────────────────────────────────────────────
// ─── MongoStore (with GridFS) ─────────────────────────────────────────────────
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
 console.error('[MongoDB] sessionExists error:', err.message);
 return false;
 }
 }
 async save({ session: sessionDir }) {
 const sessionName = path.basename(sessionDir);
 console.log(`[MongoDB] save() — zipping directory: "${sessionDir}"`);
 try {
 if (!fs.existsSync(sessionDir)) {
 const alt = path.join(AUTH_DIR, sessionName);
 if (fs.existsSync(alt)) {
 console.log(`[MongoDB] Resolved session dir to: "${alt}"`);
 sessionDir = alt;
 } else {
 throw new Error(`Session directory not found: "${sessionDir}" or "${alt}"`);
 }
 }
 const zipBuffer = await this._zipDirectory(sessionDir);
 
 // Delete old file if exists
 try {
 const oldFile = await this._db.collection('fs.files').findOne({ filename: sessionName });
 if (oldFile) {
 await this._bucket.delete(oldFile._id);
 console.log(`[MongoDB] Deleted old session file`);
 }
 } catch {}
 
 // Upload to GridFS
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
 if (!file) throw new Error(`Session "${sessionName}" not found in MongoDB`);
 
 // Download from GridFS
 const chunks = [];
 await new Promise((resolve, reject) => {
 const downloadStream = this._bucket.openDownloadStream(file._id);
 downloadStream.on('error', reject);
 downloadStream.on('data', (chunk) => chunks.push(chunk));
 downloadStream.on('end', resolve);
 });
 
 const buf = Buffer.concat(chunks);
 const destDir = path.dirname(destZipPath);
 if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
 fs.writeFileSync(destZipPath, buf);
 console.log(`✅ [MongoDB] Session "${sessionName}" written to "${destZipPath}" (${buf.length} bytes)`);
 } catch (err) {
 console.error('[MongoDB] extract error:', err.message);
 throw err;
 }
 }
 async delete({ session: sessionName }) {
 try {
 const file = await this._db.collection('fs.files').findOne({ filename: sessionName });
 if (file) {
 await this._bucket.delete(file._id);
 }
 console.log(`[MongoDB] Session "${sessionName}" deleted ✓`);
 } catch (err) {
 console.error('[MongoDB] delete error:', err.message);
 }
 }
 
 // Zip an entire directory into a Buffer
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
      backupSyncIntervalMs: 60_000,   // backup every 60s once connected
      dataPath:             AUTH_DIR,
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    store = new MongoStore();
    await store.init();
    startQueueProcessor();

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
app.get('/', (_req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WhatsApp Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0a0a;--surface:#111;--border:#1e1e1e;
    --green:#00e676;--green-dim:#00e67622;
    --text:#f0f0f0;--muted:#555;--danger:#ff4444;
  }
  body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;overflow:hidden}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:.4;pointer-events:none}
  body::after{content:'';position:fixed;top:-200px;left:50%;transform:translateX(-50%);width:600px;height:600px;background:radial-gradient(circle,#00e67615 0%,transparent 70%);pointer-events:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:48px;max-width:480px;width:100%;position:relative;box-shadow:0 0 0 1px #ffffff08,0 32px 64px #00000080;animation:fadeUp .6s cubic-bezier(.16,1,.3,1) both}
  .card::before{content:'';position:absolute;inset:0;border-radius:20px;background:linear-gradient(135deg,#ffffff06 0%,transparent 60%);pointer-events:none}
  .logo{width:56px;height:56px;background:var(--green-dim);border:1px solid #00e67633;border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:32px}
  .logo svg{width:28px;height:28px;fill:var(--green)}
  h1{font-size:28px;font-weight:800;letter-spacing:-1px;margin-bottom:8px}
  .subtitle{color:var(--muted);font-size:14px;font-family:'DM Mono',monospace;margin-bottom:40px}
  .status-row{display:flex;align-items:center;gap:12px;padding:16px 20px;background:#ffffff05;border:1px solid var(--border);border-radius:12px;margin-bottom:12px}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.green{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.red{background:var(--danger);box-shadow:0 0 8px var(--danger)}
  .dot.yellow{background:#ffd600;box-shadow:0 0 8px #ffd600;animation:pulse 1.5s infinite}
  .status-label{font-size:13px;color:var(--muted);font-family:'DM Mono',monospace;flex:1}
  .status-val{font-size:13px;font-weight:600;font-family:'DM Mono',monospace}
  .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 20px;border-radius:12px;border:none;font-family:'Syne',sans-serif;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;margin-top:8px;transition:all .2s cubic-bezier(.16,1,.3,1)}
  .btn-primary{background:var(--green);color:#000}
  .btn-primary:hover{background:#00ff88;transform:translateY(-2px);box-shadow:0 8px 24px #00e67640}
  .btn-ghost{background:#ffffff08;color:var(--text);border:1px solid var(--border)}
  .btn-ghost:hover{background:#ffffff12;transform:translateY(-2px)}
  .divider{height:1px;background:var(--border);margin:28px 0}
  .endpoints{display:flex;flex-direction:column;gap:8px}
  .ep{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#ffffff04;border-radius:8px;text-decoration:none;transition:background .15s}
  .ep:hover{background:#ffffff08}
  .ep-method{font-size:10px;font-family:'DM Mono',monospace;font-weight:500;padding:2px 6px;border-radius:4px}
  .get{background:#00e67618;color:var(--green)}
  .post{background:#4488ff18;color:#4488ff}
  .ep-path{font-size:13px;font-family:'DM Mono',monospace;color:var(--muted)}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
  </div>
  <h1>WhatsApp Bot</h1>
  <p class="subtitle">// production dashboard</p>
  <div id="status-container">
    <div class="status-row">
      <div class="dot yellow" id="dot-client"></div>
      <span class="status-label">client status</span>
      <span class="status-val" id="val-client">checking...</span>
    </div>
    <div class="status-row">
      <div class="dot yellow" id="dot-qr"></div>
      <span class="status-label">qr code</span>
      <span class="status-val" id="val-qr">checking...</span>
    </div>
  </div>
  <div id="action-btn" style="margin-top:20px"></div>
  <div class="divider"></div>
  <div class="endpoints">
    <a class="ep" href="/whatsapp/status"><span class="ep-method get">GET</span><span class="ep-path">/whatsapp/status</span></a>
    <a class="ep" href="/whatsapp/login"><span class="ep-method get">GET</span><span class="ep-path">/whatsapp/login</span></a>
    <a class="ep" href="/debug/session"><span class="ep-method get">GET</span><span class="ep-path">/debug/session</span></a>
    <span class="ep"><span class="ep-method post">POST</span><span class="ep-path">/whatsapp/send</span></span>
  </div>
</div>
<script>
async function refresh() {
  try {
    const r = await fetch('/whatsapp/status');
    const d = await r.json();
    const dotC = document.getElementById('dot-client');
    const valC = document.getElementById('val-client');
    const dotQ = document.getElementById('dot-qr');
    const valQ = document.getElementById('val-qr');
    const btn  = document.getElementById('action-btn');
    dotC.className = 'dot ' + (d.clientReady ? 'green' : 'red');
    valC.textContent = d.clientReady ? 'READY' : 'NOT READY';
    valC.style.color = d.clientReady ? 'var(--green)' : 'var(--danger)';
    dotQ.className = 'dot ' + (d.hasQR ? 'yellow' : (d.clientReady ? 'green' : 'red'));
    valQ.textContent = d.hasQR ? 'WAITING FOR SCAN' : (d.clientReady ? 'AUTHENTICATED' : 'NOT GENERATED');
    if (d.hasQR) {
      btn.innerHTML = '<a class="btn btn-primary" href="/whatsapp/login">📱 Scan QR Code</a>';
    } else if (d.clientReady) {
      btn.innerHTML = '<div class="btn btn-ghost" style="cursor:default">✅ Connected — No action needed</div>';
    } else {
      btn.innerHTML = '<div class="btn btn-ghost" style="cursor:default;color:var(--muted)">⏳ Initializing...</div>';
    }
  } catch(e) {}
}
refresh();
setInterval(refresh, 4000);
</script>
</body></html>`));

app.get('/whatsapp/login', async (_req, res) => {
  if (clientReady) return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Already Connected</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono&display=swap" rel="stylesheet"/>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Syne',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(#1e1e1e 1px,transparent 1px),linear-gradient(90deg,#1e1e1e 1px,transparent 1px);background-size:40px 40px;opacity:.4}.card{background:#111;border:1px solid #1e1e1e;border-radius:20px;padding:48px;text-align:center;max-width:380px;width:100%;animation:fadeUp .5s both}.icon{font-size:56px;margin-bottom:24px}h1{font-size:24px;font-weight:800;letter-spacing:-1px;color:#00e676;margin-bottom:8px}p{color:#555;font-family:'DM Mono',monospace;font-size:13px;margin-bottom:32px}a{display:inline-block;padding:12px 28px;background:#00e67618;color:#00e676;border:1px solid #00e67633;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;transition:all .2s}a:hover{background:#00e67628;transform:translateY(-2px)}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}</style>
</head><body><div class="card"><div class="icon">✅</div><h1>Already Connected</h1><p>// whatsapp client is ready</p><a href="/">← Back to Dashboard</a></div></body></html>`);

  if (!qrValue) return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Initializing...</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono&display=swap" rel="stylesheet"/>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Syne',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(#1e1e1e 1px,transparent 1px),linear-gradient(90deg,#1e1e1e 1px,transparent 1px);background-size:40px 40px;opacity:.4}.card{background:#111;border:1px solid #1e1e1e;border-radius:20px;padding:48px;text-align:center;max-width:380px;width:100%;animation:fadeUp .5s both}.spinner{width:48px;height:48px;border:2px solid #1e1e1e;border-top-color:#ffd600;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 24px}h1{font-size:22px;font-weight:800;letter-spacing:-1px;color:#ffd600;margin-bottom:8px}p{color:#555;font-family:'DM Mono',monospace;font-size:13px;margin-bottom:32px}a{display:inline-block;padding:12px 28px;background:#ffffff08;color:#f0f0f0;border:1px solid #1e1e1e;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;transition:all .2s}a:hover{background:#ffffff12}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}</style>
<meta http-equiv="refresh" content="5"/></head><body><div class="card"><div class="spinner"></div><h1>Initializing...</h1><p>// waiting for qr code generation</p><a href="/">← Back to Dashboard</a></div></body></html>`);

  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send('Error generating QR');
    return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Scan QR Code</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono&display=swap" rel="stylesheet"/>
<style>*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0a;--surface:#111;--border:#1e1e1e;--green:#00e676;--text:#f0f0f0;--muted:#555}body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:.4;pointer-events:none}.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:40px;max-width:420px;width:100%;text-align:center;animation:fadeUp .6s cubic-bezier(.16,1,.3,1) both}.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#ffd60018;border:1px solid #ffd60033;border-radius:100px;font-size:12px;font-family:'DM Mono',monospace;color:#ffd600;margin-bottom:28px}.badge-dot{width:6px;height:6px;border-radius:50%;background:#ffd600;animation:pulse 1.5s infinite}h1{font-size:26px;font-weight:800;letter-spacing:-1px;margin-bottom:8px}.subtitle{color:var(--muted);font-size:13px;font-family:'DM Mono',monospace;margin-bottom:28px}.qr-wrap{background:#fff;border-radius:16px;padding:20px;display:inline-block;box-shadow:0 0 0 1px #ffffff15,0 0 40px #00e67620;margin-bottom:28px}.qr-wrap img{display:block;width:220px;height:220px;border-radius:4px}.steps{text-align:left;background:#ffffff05;border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px}.step{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}.step:last-child{margin-bottom:0}.step-num{width:22px;height:22px;background:var(--green);color:#000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;margin-top:1px}.step-text{font-size:13px;color:var(--muted);line-height:1.5}.step-text strong{color:var(--text)}.refresh-bar{height:3px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:20px}.refresh-bar-fill{height:100%;background:var(--green);border-radius:2px;animation:shrink 30s linear forwards}a{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;background:#ffffff08;border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--text);font-weight:700;font-size:14px;transition:all .2s}a:hover{background:#ffffff12;transform:translateY(-2px)}@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}@keyframes shrink{from{width:100%}to{width:0%}}</style>
<meta http-equiv="refresh" content="30"/></head><body>
<div class="card">
  <div class="badge"><span class="badge-dot"></span>waiting for scan</div>
  <h1>Scan to Connect</h1>
  <p class="subtitle">// open whatsapp on your phone</p>
  <div class="qr-wrap"><img src="${src}" alt="QR Code"/></div>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Open <strong>WhatsApp</strong> on your phone</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">Go to <strong>Settings → Linked Devices</strong></div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Tap <strong>Link a Device</strong> and scan this QR</div></div>
  </div>
  <div class="refresh-bar"><div class="refresh-bar-fill"></div></div>
  <a href="/">← Back to Dashboard</a>
</div></body></html>`);
  });
});

app.get('/whatsapp/status', (_req, res) =>
  res.json({ ok: true, clientReady, hasQR: !!qrValue })
);

app.get('/debug/session', async (_req, res) => {
  try {
    const sessionKey = `RemoteAuth-${CLIENT_ID}`;
    const exists     = store ? await store.sessionExists({ session: sessionKey }) : false;
    return res.json({ ok: true, sessionKey, exists, clientReady, hasQR: !!qrValue });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Enqueue a message — returns immediately with position + id
app.post('/whatsapp/send', (req, res) => {
  if (WHATSAPP_API_PASSWORD && req.headers['x-password'] !== WHATSAPP_API_PASSWORD)
    return res.status(401).json({ ok: false, error: 'Invalid password' });

  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ ok: false, error: 'phone & message required' });

  const id       = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const position = messageQueue.length + 1;

  messageQueue.push({ id, phone, message, queuedAt: new Date() });
  console.log(`📨 [Queue] Enqueued id=${id} phone=${phone} position=${position} queueSize=${messageQueue.length}`);

  return res.json({ ok: true, queued: true, id, position, queueSize: messageQueue.length });
});

// Queue status endpoint
app.get('/whatsapp/queue/status', (_req, res) => {
  res.json({
    ok:        true,
    queueSize: messageQueue.length,
    running:   queueRunning,
    items:     messageQueue.map(({ id, phone, queuedAt }) => ({ id, phone, queuedAt })),
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

    // Drain the whole queue in this tick, one message per second
    const batch = messageQueue.splice(0, messageQueue.length);
    console.log(`📤 [Queue] Processing ${batch.length} message(s)...`);

    for (const { id, phone, message } of batch) {
      try {
        await client.sendMessage(`${phone}@c.us`, message, { sendSeen: false });
        console.log(`✅ [Queue] Sent id=${id} → ${phone}`);
      } catch (err) {
        console.error(`❌ [Queue] Failed id=${id} → ${phone}:`, err.message);
        // Re-enqueue at front so it retries next tick
        messageQueue.unshift({ id, phone, message, queuedAt: new Date(), retried: true });
        console.warn(`↩️  [Queue] Re-queued id=${id} for retry`);
      }
      // Small delay between sends to avoid WhatsApp rate-limiting
      if (batch.indexOf({ id, phone, message }) < batch.length - 1)
        await new Promise(r => setTimeout(r, SEND_DELAY_MS));
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
    if (client && clientReady) await client.destroy();
    if (store) await store.close();
  } catch {}
  process.exit(0);
});
