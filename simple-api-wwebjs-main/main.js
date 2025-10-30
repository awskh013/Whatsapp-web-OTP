// main.js — Render-optimized WhatsApp bot (fixed & enhanced for session restore)

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import qr2 from "qrcode";
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import { spawnSync } from "child_process";
import fs from "fs";

const { Client, RemoteAuth } = pkg;
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;
const MAX_INIT_RETRIES = 6;

let client = null;
let qrValue = null;
let clientReady = false;
let initializing = false;

// --- check chromium availability
function logChromiumInfo() {
  const paths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const out = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 3000 });
        console.log(`ℹ️ chromium found at ${p}:`, (out.stdout || out.stderr || "").trim());
        process.env.PUPPETEER_EXECUTABLE_PATH = p;
        return;
      }
    } catch (e) {}
  }
  console.log("⚠️ no chromium binary found; Puppeteer init may fail.");
}

// ----------------------------
// session backup/restore helpers
// ----------------------------
async function backupSessions() {
  try {
    const sessions = await mongoose.connection.db.collection("sessions").find({}).toArray();
    await mongoose.connection.db.collection("sessions_backup").updateOne(
      { _id: "latest" },
      { $set: { data: sessions, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("💾 sessions backed up (sessions_backup.latest)");
  } catch (err) {
    console.warn("⚠️ backupSessions failed:", err?.message || err);
  }
}

async function restoreSessionsIfMissing() {
  try {
    const count = await mongoose.connection.db.collection("sessions").countDocuments();
    if (count > 0) return false;
    const backup = await mongoose.connection.db.collection("sessions_backup").findOne({ _id: "latest" });
    if (!backup?.data?.length) return false;
    const coll = mongoose.connection.db.collection("sessions");
    for (const doc of backup.data) {
      await coll.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
    }
    console.log("♻️ sessions restored from backup");
    return true;
  } catch (err) {
    console.warn("⚠️ restoreSessionsIfMissing failed:", err?.message || err);
    return false;
  }
}

// ----------------------------
// connect to Mongo
// ----------------------------
async function connectMongo() {
  await mongoose.connect(process.env.MONGO_URL, {
    dbName: "whatsapp-bot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");

  const cols = await mongoose.connection.db.listCollections().toArray();
  console.log("ℹ️ collections in DB:", cols.map(c => c.name).join(", "));

  const count = await mongoose.connection.db.collection("sessions").countDocuments();
  if (count === 0) {
    const restored = await restoreSessionsIfMissing();
    if (restored) console.log("✅ sessions restored");
    else console.log("ℹ️ no sessions in DB (first-time login)");
  } else {
    console.log(`ℹ️ sessions collection has ${count} doc(s)`);
  }
}

// ----------------------------
// init WhatsApp client
// ----------------------------
async function initClient() {
  if (initializing) return;
  initializing = true;
  logChromiumInfo();

  const store = new MongoStore({ mongoose, collectionName: "sessions" });

  const c = await mongoose.connection.db.collection("sessions").countDocuments();
  const hasSession = c > 0;
  const forceP = String(process.env.FORCE_PUPPETEER || "").toLowerCase() === "true";

  const puppeteerOptions = (!hasSession || forceP) ? {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
      "--disable-renderer-backgrounding",
      "--renderer-process-limit=1",
    ],
  } : undefined;

  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    clientReady = false;
  }

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "render-stable-client", // ⚠️ لا تغيّره إذا بدك نفس الجلسة
      store,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: puppeteerOptions,
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    webVersionCache: { type: "none" },
  });

  // ----- event listeners -----
  client.on("qr", (q) => {
    qrValue = q;
    console.log("📱 QR generated — scan to login");
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("remote_session_saved", () => {
    console.log("💾 Remote session saved");
  });

  client.on("ready", async () => {
    clientReady = true;
    qrValue = null;
    console.log("🤖 WhatsApp client READY");
    await backupSessions();
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ auth_failure:", msg);
    clientReady = false;
  });

  client.on("disconnected", async (reason) => {
    console.warn("⚠️ disconnected:", reason);
    clientReady = false;
    try { await client.destroy(); } catch {}
    setTimeout(() => {
      console.log("♻️ Reinitializing client after disconnect...");
      initClient();
    }, 15000);
  });

  // ----- initialize with retries -----
  let attempt = 0;
  while (attempt < MAX_INIT_RETRIES) {
    try {
      attempt++;
      console.log(`ℹ️ client.initialize() attempt ${attempt}`);
      await client.initialize();
      console.log("✅ client.initialize() succeeded");
      initializing = false;
      return;
    } catch (err) {
      console.warn(`⚠️ client.initialize failed (attempt ${attempt}):`, err?.message || err);
      const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt));
      console.log(`⏳ retrying init in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  console.error("❌ client failed to initialize after retries");
  initializing = false;
}

// ----------------------------
// Express routes
// ----------------------------
app.get("/", (req, res) => res.send("✅ WhatsApp bot (Render-optimized)"));

app.get("/whatsapp/login", (req, res) => {
  if (clientReady) return res.send("✅ Already logged in");
  if (!qrValue) return res.send("⏳ No QR currently (initializing or already logged in)");
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.render("qr", { img: src });
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    clientReady,
    hasQR: Boolean(qrValue),
    env: {
      FORCE_PUPPETEER: process.env.FORCE_PUPPETEER === "true",
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    },
  });
});

// 🔍 debug endpoint
app.get("/debug/session", async (req, res) => {
  const count = await mongoose.connection.db.collection("sessions").countDocuments();
  const cols = await mongoose.connection.db.listCollections().toArray();
  res.json({
    sessionsCount: count,
    collections: cols.map(c => c.name),
  });
});

app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD)
      return res.status(401).json({ ok: false, error: "Invalid password" });

    const { phone, message } = req.body;
    if (!phone || !message)
      return res.status(400).json({ ok: false, error: "phone & message required" });

    if (!clientReady)
      return res.status(503).json({ ok: false, error: "Client not ready" });

    await client.sendMessage(`${phone}@c.us`, message);
    return res.json({ ok: true, message: "Message sent" });
  } catch (err) {
    console.error("❌ sendmessage error:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ----------------------------
// keepalive for Render
// ----------------------------
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    try {
      fetch(`https://${process.env.RENDER_EXTERNAL_URL}`).catch(() => {});
    } catch {}
  }, 10 * 60 * 1000);
}

// ----------------------------
// startup
// ----------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
  (async () => {
    try {
      await connectMongo();
      const restored = await restoreSessionsIfMissing();
      if (restored) console.log("✅ Session restored from backup before init");

      // delay for Mongo readiness
      await new Promise(r => setTimeout(r, 3000));

      await initClient();
    } catch (e) {
      console.error("❌ startup error:", e);
    }
  })();
});

// ----------------------------
// SIGTERM: graceful shutdown
// ----------------------------
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — backing up sessions");
  try {
    await backupSessions();
    await mongoose.connection.close();
  } catch (e) {
    console.warn("⚠️ SIGTERM cleanup failed:", e?.message || e);
  } finally {
    process.exit(0);
  }
});
