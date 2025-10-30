// main.js — Robust WhatsApp bot (Render-optimized)
// Requires: MONGO_URL, WHATSAPP_API_PASSWORD
// Optional: RENDER_EXTERNAL_URL, FORCE_PUPPETEER=true

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import qr2 from "qrcode";
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";

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

// ----------------------------
// Utilities: session backup/restore
// ----------------------------
async function backupSessions() {
  try {
    const sessions = await mongoose.connection.db
      .collection("sessions")
      .find({})
      .toArray();
    await mongoose.connection.db
      .collection("sessions_backup")
      .updateOne(
        { _id: "latest" },
        { $set: { data: sessions, updatedAt: new Date() } },
        { upsert: true }
      );
    console.log("💾 sessions backed up to sessions_backup");
  } catch (err) {
    console.warn("⚠️ backupSessions failed:", err.message);
  }
}

async function restoreSessionsIfMissing() {
  try {
    const count = await mongoose.connection.db
      .collection("sessions")
      .countDocuments();
    if (count > 0) return false; // already have sessions

    const backup = await mongoose.connection.db
      .collection("sessions_backup")
      .findOne({ _id: "latest" });
    if (!backup || !Array.isArray(backup.data) || backup.data.length === 0)
      return false;

    // restore documents (avoid duplicates)
    const coll = mongoose.connection.db.collection("sessions");
    for (const doc of backup.data) {
      try {
        const q = {};
        if (doc._id) q._id = doc._id;
        await coll.updateOne(q, { $set: doc }, { upsert: true });
      } catch (e) {
        console.warn("⚠️ restore doc failed:", e.message);
      }
    }
    console.log("♻️ Restored sessions from backup");
    return true;
  } catch (err) {
    console.warn("⚠️ restoreSessionsIfMissing failed:", err.message);
    return false;
  }
}

// ----------------------------
// Connect to Mongo + attempt restore if necessary
// ----------------------------
async function connectMongo() {
  await mongoose.connect(process.env.MONGO_URL, {
    dbName: "whatsapp-bot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");

  // If sessions missing, try restore from backup
  const count = await mongoose.connection.db
    .collection("sessions")
    .countDocuments();
  if (count === 0) {
    const restored = await restoreSessionsIfMissing();
    if (restored) {
      console.log("✅ sessions restored from backup (will reuse existing session)");
    } else {
      console.log("ℹ️ no sessions in DB (first-time login required)");
    }
  } else {
    console.log(`ℹ️ sessions collection has ${count} document(s)`);
  }
}

// ----------------------------
// Init WhatsApp Client (with retry/backoff)
// ----------------------------
async function initClient() {
  if (initializing) return;
  initializing = true;

  const store = new MongoStore({
    mongoose,
    collectionName: "sessions",
  });

  // detect whether session exists in DB
  let hasSession = false;
  try {
    const c = await mongoose.connection.db
      .collection("sessions")
      .countDocuments();
    hasSession = c > 0;
  } catch (e) {
    console.warn("⚠️ cannot access sessions collection:", e.message);
  }

  // if FORCE_PUPPETEER is set to "true", always launch chromium (useful for debugging)
  const forcePuppeteer = String(process.env.FORCE_PUPPETEER || "").toLowerCase() === "true";

  // Puppeteer options: minimal and memory-conscious
  const puppeteerOptions = !hasSession || forcePuppeteer
    ? {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-dev-shm-usage",
          "--no-zygote",
          "--single-process",
          "--window-size=800,600",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
        ],
      }
    : undefined;

  // Graceful destroy existing client if any (but avoid logout!)
  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      // ignore
    }
    client = null;
    clientReady = false;
  }

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "render-stable-client",
      store,
      backupSyncIntervalMs: 300000, // every 5 minutes
    }),
    puppeteer: puppeteerOptions,
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    // reduce caching work (lighter)
    webVersionCache: { type: "none" },
  });

  client.on("qr", (q) => {
    qrValue = q;
    console.log("📱 QR generated — scan to login");
  });

  client.on("ready", async () => {
    qrValue = null;
    clientReady = true;
    console.log("🤖 WhatsApp client ready");
    // immediate backup of sessions on ready
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
    // try re-init after delay
    setTimeout(() => {
      console.log("♻️ Attempting re-init after disconnect");
      initClient();
    }, 15000);
  });

  // initialize with retry/backoff so we don't crash the whole process
  let attempt = 0;
  while (attempt < MAX_INIT_RETRIES) {
    try {
      console.log(`ℹ️ client.initialize() attempt ${attempt + 1}`);
      await client.initialize();
      console.log("✅ client.initialize() succeeded");
      initializing = false;
      return;
    } catch (err) {
      attempt++;
      console.warn(`⚠️ client.init failed (attempt ${attempt}):`, err.message || err);
      // if puppeteer errors and we have a session, try to proceed without launching chromium
      if (!puppeteerOptions && attempt >= MAX_INIT_RETRIES) {
        console.error("❌ max init retries reached (no puppeteer). Giving up for now.");
        break;
      }
      // exponential backoff
      const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt));
      console.log(`⏳ retrying init in ${waitMs}ms`);
      // if puppeteerOptions present and error likely from chromium, wait longer
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  initializing = false;
}

// ----------------------------
// Routes
// ----------------------------
app.get("/", (req, res) => {
  res.send("✅ WhatsApp bot (robust) — visit /whatsapp/login to scan QR if needed");
});

app.get("/whatsapp/login", async (req, res) => {
  if (clientReady) return res.send("✅ Already logged in");
  if (!qrValue) return res.send("⏳ No QR currently (initializing or already logged in). Refresh in a few seconds.");
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
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser"
    }
  });
});

app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ ok: false, error: "phone & message required" });

    if (!clientReady) return res.status(503).json({ ok: false, error: "Client not ready, try again later" });

    await client.sendMessage(`${phone}@c.us`, message);
    return res.json({ ok: true, message: "Sent" });
  } catch (err) {
    console.error("❌ sendmessage error:", err.message || err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ----------------------------
// Keepalive (prevent sleep) — optional
// ----------------------------
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`https://${process.env.RENDER_EXTERNAL_URL}`).catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
}

// ----------------------------
// SIGTERM: backup then exit
// ----------------------------
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — backing up sessions...");
  try {
    await backupSessions();
    await mongoose.connection.close();
  } catch (e) {
    console.warn("⚠️ SIGTERM cleanup failed:", e.message || e);
  } finally {
    process.exit(0);
  }
});

// ----------------------------
// Start
// ----------------------------
(async () => {
  try {
    await connectMongo();
    await initClient();
    app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
    // periodic backup (every 15 minutes) to be extra safe
    setInterval(backupSessions, 15 * 60 * 1000);
  } catch (e) {
    console.error("❌ startup failed:", e);
    process.exit(1);
  }
})();
