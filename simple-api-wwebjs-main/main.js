// main.js — quick fix: start express immediately, init client async
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

let client = null;
let qrValue = null;
let clientReady = false;
let initializing = false;

// quick chromium check (logs version if present)
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
        console.log(`ℹ️ chromium found at ${p}:`, out.stdout?.trim() || out.stderr?.trim());
        process.env.PUPPETEER_EXECUTABLE_PATH = p;
        return;
      }
    } catch (e) { /* ignore */ }
  }
  console.log("⚠️ no chromium binary found in expected paths; init may fail.");
}

// ---- Mongo connect + backup helpers (same as previous approach) ----
async function backupSessions() {
  try {
    const sessions = await mongoose.connection.db.collection("sessions").find({}).toArray();
    await mongoose.connection.db.collection("sessions_backup").updateOne(
      { _id: "latest" },
      { $set: { data: sessions, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("💾 sessions backed up");
  } catch (err) { console.warn("backupSessions failed:", err.message); }
}

async function restoreSessionsIfMissing() {
  try {
    const count = await mongoose.connection.db.collection("sessions").countDocuments();
    if (count > 0) return false;
    const backup = await mongoose.connection.db.collection("sessions_backup").findOne({ _id: "latest" });
    if (!backup?.data?.length) return false;
    const coll = mongoose.connection.db.collection("sessions");
    for (const doc of backup.data) {
      try { await coll.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true }); } catch (e) {}
    }
    console.log("♻️ restored sessions from backup");
    return true;
  } catch (e) { console.warn("restoreSessionsIfMissing failed:", e.message); return false; }
}

async function connectMongo() {
  await mongoose.connect(process.env.MONGO_URL, { dbName: "whatsapp-bot", useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected to MongoDB Atlas");
  const count = await mongoose.connection.db.collection("sessions").countDocuments();
  if (count === 0) {
    const restored = await restoreSessionsIfMissing();
    if (restored) console.log("✅ sessions restored");
    else console.log("ℹ️ no sessions in DB (first-time login)");
  } else {
    console.log(`ℹ️ sessions collection has ${count} doc(s)`);
  }
}

// ---- initWhatsApp but non-blocking from server start ----
async function initClient() {
  if (initializing) return;
  initializing = true;
  logChromiumInfo();

  const store = new MongoStore({ mongoose, collectionName: "sessions" });
  let hasSession = false;
  try { hasSession = (await mongoose.connection.db.collection("sessions").countDocuments()) > 0; } catch (e) {}
  const forceP = String(process.env.FORCE_PUPPETEER || "").toLowerCase() === "true";
  const puppeteerOptions = {
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
  "--disable-background-timer-throttling",
  "--disable-client-side-phishing-detection",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
  "--disable-renderer-backgrounding"
],
};


  if (client) {
    try { await client.destroy(); } catch(e) {}
    client = null; clientReady = false;
  }

  client = new Client({
    authStrategy: new RemoteAuth({ clientId: "render-stable-client", store, backupSyncIntervalMs: 300000 }),
    puppeteer: puppeteerOptions,
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    webVersionCache: { type: "none" },
  });

  client.on("qr", q => { qrValue = q; console.log("📱 QR generated"); });
  client.on("ready", async () => { clientReady = true; qrValue = null; console.log("🤖 Bot ready"); await backupSessions(); });
  client.on("auth_failure", (m) => { console.error("auth_failure:", m); clientReady = false; });
  client.on("disconnected", async (r) => { console.warn("disconnected:", r); clientReady = false; try { await client.destroy(); } catch{} setTimeout(initClient, 15000); });

  // try initialize with retry/backoff but do not block server start
  let attempt=0;
  const maxAttempts = 6;
  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`ℹ️ initializing client attempt ${attempt}`);
      await client.initialize();
      console.log("✅ client.initialize succeeded");
      initializing = false;
      return;
    } catch (err) {
      console.warn(`⚠️ init failed (attempt ${attempt}):`, err.message || err);
      const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
      console.log(`⏳ will retry init in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  console.error("❌ client failed to initialize after retries — will keep background retries");
  initializing = false;
  // keep a background retry loop every 30s
  setInterval(() => { if (!initializing && !clientReady) initClient(); }, 30000);
}

// ---- express routes unchanged ----
app.get("/", (req, res) => res.send("✅ WhatsApp bot (stable)"));
app.get("/whatsapp/login", (req, res) => {
  if (clientReady) return res.send("✅ Already logged in");
  if (!qrValue) return res.send("⏳ No QR (init or already logged in)");
  qr2.toDataURL(qrValue, (err, src) => err ? res.status(500).send("QR error") : res.render("qr", { img: src }));
});
app.get("/status", (req, res) => res.json({ clientReady, hasQR: Boolean(qrValue) }));
app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD) return res.status(401).json({ ok:false, error:"Invalid password" });
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ ok:false, error:"phone & message required" });
    if (!clientReady) return res.status(503).json({ ok:false, error:"Client not ready" });
    await client.sendMessage(`${phone}@c.us`, message);
    res.json({ ok:true });
  } catch (e) {
    console.error("sendmessage err:", e);
    res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

// start server immediately (important for Render)
app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
  // start Mongo + client init in background
  (async () => {
    try {
      await connectMongo();
      initClient(); // note: not awaited — runs in background
    } catch (e) {
      console.error("startup error:", e);
    }
  })();
});

// SIGTERM backup then exit
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM — backing up");
  try { await backupSessions(); await mongoose.connection.close(); } catch(e) {}
  process.exit(0);
});
