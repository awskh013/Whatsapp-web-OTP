// main.js — WhatsApp RemoteAuth bot with Render-safe session restore (ESM)

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import qr2 from "qrcode";
import pkg from "whatsapp-web.js";
import fs from "fs";
import { spawnSync } from "child_process";
import { MongoStore } from "wwebjs-mongo";

dotenv.config();
const { Client, RemoteAuth } = pkg;

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) throw new Error("❌ Missing MONGO_URI in environment variables!");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

let client = null;
let qrValue = null;
let clientReady = false;

// -------------------------
// Utility: wait
// -------------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// -------------------------
// Chromium info
// -------------------------
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
  console.log("⚠️ No chromium binary found — Puppeteer may fail.");
}

// -------------------------
// Connect to Mongo
// -------------------------
async function connectMongo() {
  console.log("⏳ Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGO_URI, {
    dbName: "whatsapp-bot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");

  const collections = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);
  console.log("ℹ️ collections in DB:", collections.join(", ") || "(none)");

  const remoteAuthCollections = collections.filter(c => c.startsWith("whatsapp-RemoteAuth"));
  if (remoteAuthCollections.length > 0)
    console.log("✅ Found existing WhatsApp session data");
  else
    console.log("ℹ️ No session found, maybe first login");

  return remoteAuthCollections.length > 0;
}

// -------------------------
// WhatsApp client init
// -------------------------
async function initClient(hasSession) {
  logChromiumInfo();

  const store = new MongoStore({ mongoose, collectionName: "sessions" });

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
    ],
  };

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "render-stable-client",
      store,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: puppeteerOptions,
    takeoverOnConflict: true,
    restartOnAuthFail: true,
    webVersionCache: { type: "none" },
  });

  client.on("qr", (q) => {
    qrValue = q;
    console.log("📱 QR generated — scan to login");
  });

  client.on("ready", async () => {
    clientReady = true;
    qrValue = null;
    console.log("🤖 WhatsApp client READY");
    await backupSessions();
  });

  client.on("authenticated", () => console.log("✅ WhatsApp authenticated"));

  client.on("auth_failure", (msg) => {
    console.error("❌ auth_failure:", msg);
    clientReady = false;
  });

  client.on("disconnected", async (reason) => {
    console.warn("⚠️ disconnected:", reason);
    clientReady = false;
    setTimeout(() => {
      console.log("♻️ Reinitializing client after disconnect...");
      initClient(true);
    }, 15000);
  });

  console.log("⚙️ Initializing WhatsApp client...");
  await client.initialize();
  console.log("✅ client.initialize() succeeded");
}

// -------------------------
// Backup sessions
// -------------------------
async function backupSessions() {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const data = {};

    for (const c of collections) {
      if (c.name.startsWith("whatsapp-RemoteAuth")) {
        data[c.name] = await db.collection(c.name).find({}).toArray();
      }
    }

    await db.collection("sessions_backup").updateOne(
      { _id: "latest" },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("💾 Remote session saved");
  } catch (err) {
    console.warn("⚠️ backupSessions failed:", err.message);
  }
}

// -------------------------
// Express routes
// -------------------------
app.get("/", (req, res) => res.send("✅ WhatsApp bot (Render optimized)"));

app.get("/whatsapp/login", (req, res) => {
  if (clientReady) return res.send("✅ Already logged in");
  if (!qrValue) return res.send("⏳ No QR currently (initializing or already logged in)");
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    res.render("qr", { img: src });
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    ready: clientReady,
    qr: !!qrValue,
  });
});

app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD)
      return res.status(401).json({ ok: false, error: "Invalid password" });

    const { phone, message } = req.body;
    if (!phone || !message)
      return res.status(400).json({ ok: false, error: "Missing phone or message" });

    if (!clientReady)
      return res.status(503).json({ ok: false, error: "Client not ready" });

    await client.sendMessage(`${phone}@c.us`, message);
    res.json({ ok: true, message: "Message sent" });
  } catch (err) {
    console.error("❌ sendmessage error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Keepalive for Render
// -------------------------
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`https://${process.env.RENDER_EXTERNAL_URL}`).catch(() => {});
  }, 10 * 60 * 1000);
}

// -------------------------
// Start server
// -------------------------
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  try {
    const hasSession = await connectMongo();
    console.log("⏳ Waiting 10s before initializing client...");
    await wait(10000);
    await initClient(hasSession);
  } catch (e) {
    console.error("❌ Startup error:", e);
  }
});

// -------------------------
// SIGTERM — backup before exit
// -------------------------
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM — backing up sessions before exit");
  await backupSessions();
  await mongoose.connection.close();
  process.exit(0);
});
