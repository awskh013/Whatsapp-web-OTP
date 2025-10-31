// main.js (ESM) — Render-safe WhatsApp bot (session-safe, routes included)

import express from "express";
import mongoose from "mongoose";
import pkg from "whatsapp-web.js";
const { Client, RemoteAuth } = pkg;
import { MongoStore } from "wwebjs-mongo";
import dotenv from "dotenv";
import qr2 from "qrcode";
import fs from "fs";
import { spawnSync } from "child_process";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const CLIENT_ID = "render-stable-client";
const WHATSAPP_API_PASSWORD = process.env.WHATSAPP_API_PASSWORD || "";
const FORCE_PUPPETEER = String(process.env.FORCE_PUPPETEER || "false").toLowerCase() === "true";

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is missing — set environment variable and redeploy.");
  process.exit(1);
}

// small helpers
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let qrValue = null;
let clientReady = false;
let initializing = false;
let lastQrLogAt = 0;
const QR_LOG_COOLDOWN_MS = 10_000; // log QR at most once per 10s

// ensure chromium path if available
function detectChromium() {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const out = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 3000 });
        console.log(`ℹ️ Chromium found at ${p}: ${(out.stdout || out.stderr || "").trim()}`);
        process.env.PUPPETEER_EXECUTABLE_PATH = p;
        return p;
      }
    } catch {}
  }
  return undefined;
}

// ---------------------------
// Mongo connect + session helpers
// ---------------------------
async function connectMongo() {
  console.log("⏳ Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGODB_URI, {
    dbName: "whatsapp-bot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");

  const cols = await mongoose.connection.db.listCollections().toArray();
  const names = cols.map(c => c.name);
  console.log("ℹ️ collections in DB:", names.join(", ") || "(none)");
  return names;
}

async function findRemoteAuthCollections(clientId = CLIENT_ID) {
  const names = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);
  const matches = names.filter(n => n.startsWith(`whatsapp-RemoteAuth-${clientId}`));
  return matches; // may be like ['whatsapp-RemoteAuth-render-stable-client.files', '...chunks']
}

async function backupRemoteAuthCollections() {
  try {
    const db = mongoose.connection.db;
    const collections = (await db.listCollections().toArray()).map(c => c.name);
    const map = {};
    for (const name of collections) {
      if (name.startsWith(`whatsapp-RemoteAuth-${CLIENT_ID}`)) {
        map[name] = await db.collection(name).find({}).toArray();
      }
    }
    await db.collection("sessions_backup").updateOne(
      { _id: "latest" },
      { $set: { data: map, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("💾 sessions backed up (sessions_backup.latest)");
  } catch (err) {
    console.warn("⚠️ backupRemoteAuthCollections failed:", err?.message || err);
  }
}

async function restoreRemoteAuthFromBackup() {
  try {
    const db = mongoose.connection.db;
    const backup = await db.collection("sessions_backup").findOne({ _id: "latest" });
    if (!backup || !backup.data) return false;
    // restore each collection if missing
    for (const [collName, docs] of Object.entries(backup.data)) {
      const exists = await db.listCollections({ name: collName }).hasNext();
      if (!exists) {
        if (docs && docs.length) {
          await db.collection(collName).insertMany(docs);
          console.log(`♻️ restored ${collName} from backup`);
        }
      }
    }
    return true;
  } catch (err) {
    console.warn("⚠️ restoreRemoteAuthFromBackup failed:", err?.message || err);
    return false;
  }
}

// ---------------------------
// WhatsApp client init
// ---------------------------
let client = null;
let store = null;

async function initWhatsAppClient() {
  if (initializing) return;
  initializing = true;

  detectChromium();

  store = new MongoStore({ mongoose, collectionName: "sessions" });

  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-background-timer-throttling"
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  else if (FORCE_PUPPETEER) puppeteerOptions.executablePath = "/usr/bin/chromium";

  client = new Client({
    authStrategy: new RemoteAuth({ clientId: CLIENT_ID, store, backupSyncIntervalMs: 300000 }),
    puppeteer: puppeteerOptions,
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    webVersionCache: { type: "none" },
  });

  client.on("qr", (q) => {
    qrValue = q;
    const now = Date.now();
    if (now - lastQrLogAt > QR_LOG_COOLDOWN_MS) {
      console.log("📱 QR generated — open /whatsapp/login to scan");
      lastQrLogAt = now;
    } else {
      // suppress frequent QR spam
    }
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("remote_session_saved", async () => {
    console.log("💾 Remote session saved to MongoDB");
    await backupRemoteAuthCollections();
  });

  client.on("ready", () => {
    clientReady = true;
    qrValue = null;
    console.log("🤖 WhatsApp client READY");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ auth_failure:", msg);
    clientReady = false;
  });

  client.on("disconnected", async (reason) => {
    console.warn("⚠️ disconnected:", reason);
    clientReady = false;
    try { await client.destroy(); } catch {}
    initializing = false;
    // retry after delay
    setTimeout(() => {
      console.log("♻️ attempting re-init after disconnect...");
      initWhatsAppClient();
    }, 15000);
  });

  try {
    console.log("⚙️ client.initialize() attempt...");
    await client.initialize();
    console.log("✅ client.initialize() succeeded");
  } catch (err) {
    console.error("❌ client.initialize() failed:", err);
  } finally {
    initializing = false;
  }
}

// ---------------------------
// Express routes (preserve old endpoints)
// ---------------------------
app.get("/", (req, res) => res.send("✅ WhatsApp bot (Render optimized). Use /whatsapp/login and /whatsapp/send"));

app.get("/debug/session", async (req, res) => {
  try {
    const cols = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);
    const remoteAuth = cols.filter(n => n.startsWith(`whatsapp-RemoteAuth-${CLIENT_ID}`));
    return res.json({ ok: true, collections: cols, remoteAuthCollections: remoteAuth });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/whatsapp/login", async (req, res) => {
  if (clientReady) return res.send("✅ Already logged in");
  if (!qrValue) return res.send("⏳ No QR currently (initializing or already logged in)");
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.send(`<img src="${src}" alt="QR" />`);
  });
});

app.get("/whatsapp/status", (req, res) => {
  res.json({ ok: true, clientReady, hasQR: !!qrValue });
});

app.post("/whatsapp/send", async (req, res) => {
  try {
    if (WHATSAPP_API_PASSWORD && req.headers["x-password"] !== WHATSAPP_API_PASSWORD) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ ok: false, error: "phone & message required" });
    if (!clientReady) return res.status(503).json({ ok: false, error: "Client not ready" });
    await client.sendMessage(`${phone}@c.us`, message);
    return res.json({ ok: true, message: "Message sent" });
  } catch (err) {
    console.error("❌ send error:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------------------------
// Start server IMMEDIATELY to satisfy Render health checks
// (so Render won't send SIGTERM due to "no open ports")
// ---------------------------
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);

  // Ensure mongo connected and try to restore if needed
  try {
    const cols = await connectMongo();
    const remoteAuth = await findRemoteAuthCollections();
    if (!remoteAuth.length) {
      // attempt restore from backup (if exists)
      const restored = await restoreRemoteAuthFromBackup();
      if (restored) {
        console.log("✅ Restored RemoteAuth from sessions_backup — continuing");
      } else {
        console.log("ℹ️ No RemoteAuth collections found — first login expected");
      }
    } else {
      console.log("✅ RemoteAuth collections present:", remoteAuth.join(", "));
    }
  } catch (err) {
    console.warn("⚠️ Error during initial DB checks:", err?.message || err);
  }

  // init client in background after small delay (allow Render health to settle)
  console.log("⏳ Delaying 3s then initializing WhatsApp client in background...");
  setTimeout(() => initWhatsAppClient(), 3000);
});

// ---------------------------
// SIGTERM (graceful) — backup and close
// ---------------------------
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — attempting graceful shutdown");
  try {
    if (client && clientReady) {
      try { await backupRemoteAuthCollections(); } catch (e) { console.warn("backup failed:", e?.message || e); }
      try { await client.destroy(); } catch (e) {}
    }
    try { await mongoose.connection.close(); } catch (e) {}
  } catch (err) {
    console.warn("⚠️ Error during SIGTERM cleanup:", err?.message || err);
  } finally {
    process.exit(0);
  }
});
