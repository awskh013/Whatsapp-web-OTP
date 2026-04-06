'use strict';

const express  = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode   = require('qrcode');
const { MongoStore } = require('./src/store');
require('dotenv').config();

// ─── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', 'pages');

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
let waClient     = null;
let qrDataURL    = null;   // base64 PNG for the browser
let qrRaw        = null;   // raw string for /qr.png
let isReady      = false;
let isStarting   = false;
let restartTimer = null;

// ─── Middleware ────────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-password'] || req.query.password;
  if (!process.env.WHATSAPP_API_PASSWORD) {
    return res.status(500).json({ ok: false, message: 'WHATSAPP_API_PASSWORD not configured' });
  }
  if (key !== process.env.WHATSAPP_API_PASSWORD) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
}

// ─── WhatsApp bootstrap ────────────────────────────────────────────────────────
async function startWhatsApp(store) {
  if (isStarting) return;
  isStarting = true;
  clearTimeout(restartTimer);

  // Reset state
  qrDataURL = null;
  qrRaw     = null;
  isReady   = false;

  waClient = new Client({
    authStrategy: new RemoteAuth({
      clientId:            'primary',
      store,
      backupSyncIntervalMs: 60_000,   // minimum allowed is 60 000
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
      ],
    },
  });

  // ── Events ──────────────────────────────────────────────────────────────────

  waClient.on('qr', async (qr) => {
    qrRaw  = qr;
    isReady = false;
    try {
      qrDataURL = await QRCode.toDataURL(qr);
      console.log('[WA] QR ready → visit /whatsapp/login');
    } catch (e) {
      console.error('[WA] QR generation failed:', e.message);
    }
  });

  waClient.on('authenticated', () => {
    console.log('[WA] Authenticated ✓');
  });

  waClient.on('ready', () => {
    qrDataURL  = null;
    qrRaw      = null;
    isReady    = true;
    isStarting = false;
    console.log('[WA] Ready ✓');
  });

  waClient.on('remote_session_saved', () => {
    console.log('[WA] Session synced to MongoDB ✓');
  });

  waClient.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure:', msg);
    isReady    = false;
    isStarting = false;
    scheduleRestart(store, 15_000);
  });

  waClient.on('disconnected', (reason) => {
    console.warn('[WA] Disconnected:', reason);
    isReady    = false;
    isStarting = false;
    qrDataURL  = null;
    qrRaw      = null;
    scheduleRestart(store, 8_000);
  });

  // ── Initialize ───────────────────────────────────────────────────────────────
  waClient.initialize().catch((err) => {
    console.error('[WA] initialize() error:', err.message);
    isStarting = false;
    scheduleRestart(store, 15_000);
  });
}

function scheduleRestart(store, delayMs) {
  clearTimeout(restartTimer);
  console.log(`[WA] Restarting in ${delayMs / 1000}s…`);
  restartTimer = setTimeout(async () => {
    if (waClient) {
      await waClient.destroy().catch(() => {});
      waClient = null;
    }
    startWhatsApp(store);
  }, delayMs);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    service:       'WhatsApp Bot',
    status:        isReady ? 'connected' : isStarting ? 'initializing' : 'disconnected',
    qr_available:  !!qrRaw,
  });
});

// Scan QR page
app.get('/whatsapp/login', (_req, res) => {
  if (isReady) {
    return res.send(html(`
      <div class="card">
        <div class="icon">✅</div>
        <h1>WhatsApp متصل</h1>
        <p>البوت يعمل بشكل طبيعي.</p>
      </div>
    `));
  }

  if (!qrDataURL) {
    return res.send(html(`
      <meta http-equiv="refresh" content="4">
      <div class="card">
        <div class="icon spin">⏳</div>
        <h1>جاري التحضير…</h1>
        <p>الصفحة ستتحدث تلقائياً.</p>
      </div>
    `));
  }

  res.render('qr', { img: qrDataURL });
});

// Raw QR PNG — useful for external tools
app.get('/whatsapp/qr.png', async (_req, res) => {
  if (!qrRaw) {
    return res.status(404).json({ ok: false, message: 'No QR available right now' });
  }
  try {
    const buf = await QRCode.toBuffer(qrRaw);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Failed to render QR PNG' });
  }
});

// Status JSON
app.get('/whatsapp/status', (_req, res) => {
  res.json({
    ready:       isReady,
    initializing: isStarting,
    qr_pending:  !!qrRaw,
  });
});

// Send message
app.post('/whatsapp/sendmessage', requireApiKey, async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ ok: false, message: 'WhatsApp not connected yet' });
  }

  const { phone, message } = req.body;

  if (!phone)   return res.status(400).json({ ok: false, message: 'phone is required' });
  if (!message) return res.status(400).json({ ok: false, message: 'message is required' });

  // Strip non-digits, keep only the number
  const chatId = `${phone.replace(/\D/g, '')}@c.us`;

  try {
    await waClient.sendMessage(chatId, message);
    res.json({ ok: true, message: 'Sent', to: chatId });
  } catch (err) {
    console.error('[WA] sendMessage error:', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ─── Inline HTML helper (for simple pages without EJS) ─────────────────────────
function html(body) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Bot</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;
         justify-content:center;background:#f0f2f5;
         font-family:"Segoe UI",Tahoma,sans-serif}
    .card{background:#fff;border-radius:16px;padding:40px 48px;
          text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:360px;width:100%}
    .icon{font-size:48px;margin-bottom:16px}
    h1{font-size:20px;color:#111;margin-bottom:8px}
    p{font-size:14px;color:#666}
    .spin{animation:spin 2s linear infinite;display:inline-block}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const store = new MongoStore();

  try {
    await store.init();
  } catch (err) {
    console.error('[BOOT] MongoDB connection failed:', err.message);
    console.error('[BOOT] Check MONGODB_URI and try again in 10s…');
    setTimeout(() => boot(), 10_000);
    return;
  }

  app.listen(PORT, () => {
    console.log(`[HTTP] Listening on port ${PORT}`);
  });

  startWhatsApp(store);
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[SYS] SIGTERM — shutting down');
  if (waClient) await waClient.destroy().catch(() => {});
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SYS] Unhandled rejection:', reason);
});

boot();
