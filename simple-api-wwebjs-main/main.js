import express from "express";
import mongoose from "mongoose";
import { Client, RemoteAuth } from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import dotenv from "dotenv";
import qr2 from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const FORCE_PUPPETEER = process.env.FORCE_PUPPETEER === "true";
const clientId = "render-stable-client";

let client;
let qrValue = null;
let clientReady = false;

// === MongoDB Connection ===
async function connectMongo() {
  console.log("⏳ Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 20000,
    socketTimeoutMS: 45000,
  });
  console.log("✅ Connected to MongoDB Atlas");

  const collections = await mongoose.connection.db.listCollections().toArray();
  console.log("ℹ️ collections in DB:", collections.map((c) => c.name).join(", "));
}

// === Backup / Restore Sessions ===
async function backupSessionsIfAny() {
  const coll = mongoose.connection.db.collection("sessions");
  const count = await coll.countDocuments();
  if (count > 0) {
    const sessions = await coll.find().toArray();
    await mongoose.connection.db
      .collection("sessions_backup")
      .updateOne({ _id: "latest" }, { $set: { data: sessions, updatedAt: new Date() } }, { upsert: true });
    console.log("💾 sessions backed up");
  } else {
    console.log("ℹ️ no sessions found for backup");
  }
}

async function restoreSessionsIfMissing() {
  const coll = mongoose.connection.db.collection("sessions");
  const count = await coll.countDocuments();
  if (count === 0) {
    const backup = await mongoose.connection.db.collection("sessions_backup").findOne({ _id: "latest" });
    if (backup?.data?.length) {
      for (const doc of backup.data) {
        await coll.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
      }
      console.log("♻️ sessions restored from backup");
      return true;
    }
  }
  return false;
}

// === WhatsApp Initialization ===
async function initClient() {
  const store = new MongoStore({ mongoose });

  console.log("⚙️ Initializing WhatsApp client...");
  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId,
      backupSyncIntervalMs: 60000,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      executablePath: FORCE_PUPPETEER ? "/usr/bin/chromium" : undefined,
    },
  });

  client.on("qr", (qr) => {
    qrValue = qr;
    console.log("📲 QR generated — open /whatsapp/login to scan");
  });

  client.on("ready", () => {
    clientReady = true;
    qrValue = null;
    console.log("🤖 WhatsApp client READY");
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("remote_session_saved", async () => {
    console.log("💾 Remote session saved");
    await backupSessionsIfAny();
  });

  client.on("disconnected", async (reason) => {
    console.log("⚠️ Client disconnected:", reason);
    clientReady = false;
    setTimeout(initClient, 15000);
  });

  try {
    await client.initialize();
    console.log("✅ client.initialize() succeeded");
  } catch (err) {
    console.error("❌ client.initialize() failed:", err);
  }
}

// === Routes ===
app.get("/", (req, res) => {
  res.send("✅ WhatsApp Bot running. Use /whatsapp/login to connect.");
});

app.get("/whatsapp/login", async (req, res) => {
  if (clientReady) return res.send("✅ Already logged in!");
  if (!qrValue) return res.send("⏳ No QR yet, please wait...");
  qr2.toDataURL(qrValue, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    res.send(`<img src="${src}" alt="QR Code" />`);
  });
});

app.get("/whatsapp/status", (req, res) => {
  res.json({
    ok: true,
    clientReady,
    hasQR: !!qrValue,
  });
});

app.post("/whatsapp/send", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!clientReady) return res.status(503).send("Client not ready");
    if (!phone || !message) return res.status(400).send("Missing phone or message");
    await client.sendMessage(`${phone}@c.us`, message);
    res.json({ ok: true, to: phone, message });
  } catch (err) {
    console.error("❌ send error:", err);
    res.status(500).send("Error sending message");
  }
});

// === SIGTERM Handling ===
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — backing up sessions...");
  await backupSessionsIfAny();
  process.exit(0);
});

// === Startup ===
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  try {
    await connectMongo();
    const restored = await restoreSessionsIfMissing();
    if (restored) console.log("✅ Session restored from backup");
    else console.log("ℹ️ No session found, maybe first login");

    console.log("⏳ Waiting 10s before initializing client...");
    await new Promise((r) => setTimeout(r, 10000));
    await initClient();
  } catch (err) {
    console.error("❌ Startup error:", err);
  }
});
