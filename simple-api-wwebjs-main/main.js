import express from "express";
import mongoose from "mongoose";
import { Client, RemoteAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { MongoStore } from "wwebjs-mongo";
import puppeteer from "puppeteer";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const FORCE_PUPPETEER = process.env.FORCE_PUPPETEER === "true";
const clientId = "render-stable-client"; // اسم ثابت

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

// === Session Backup Helpers ===
async function backupSessionsIfAny() {
  const collections = await mongoose.connection.db
    .listCollections({ name: "sessions" })
    .toArray();
  if (collections.length) {
    const sessions = await mongoose.connection.db
      .collection("sessions")
      .find()
      .toArray();
    if (sessions.length) {
      await mongoose.connection.db.collection("sessions_backup").deleteMany({});
      await mongoose.connection.db
        .collection("sessions_backup")
        .insertMany(sessions);
      console.log("💾 sessions backed up");
    }
  } else {
    console.log("ℹ️ no sessions collection found for backup");
  }
}

async function restoreSessionsIfMissing() {
  const count = await mongoose.connection.db
    .collection("sessions")
    .countDocuments();
  if (count === 0) {
    const backupCount = await mongoose.connection.db
      .collection("sessions_backup")
      .countDocuments();
    if (backupCount > 0) {
      const backupData = await mongoose.connection.db
        .collection("sessions_backup")
        .find()
        .toArray();
      await mongoose.connection.db
        .collection("sessions")
        .insertMany(backupData);
      console.log("♻️ sessions restored from backup");
      return true;
    }
  }
  return false;
}

// === WhatsApp Client Initialization ===
let client;
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
      executablePath: FORCE_PUPPETEER
        ? "/usr/bin/chromium"
        : puppeteer.executablePath(),
    },
  });

  client.on("qr", (qr) => {
    console.log("📱 QR RECEIVED — scan this code:");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("remote_session_saved", async () => {
    console.log("💾 Remote session saved");
    await backupSessionsIfAny();
  });

  client.on("ready", () => {
    console.log("🤖 WhatsApp client READY");
  });

  client.on("disconnected", async (reason) => {
    console.log("⚠️ WhatsApp client disconnected:", reason);
  });

  try {
    console.log("ℹ️ client.initialize() attempt...");
    await client.initialize();
    console.log("✅ client.initialize() succeeded");
  } catch (err) {
    console.error("❌ client.initialize() failed:", err);
  }
}

// === Routes ===

// 🔹 Home Route
app.get("/", (req, res) => {
  res.send("✅ WhatsApp Bot is running. Use /whatsapp/login or /whatsapp/send.");
});

// 🔹 Debug Route
app.get("/debug/session", async (req, res) => {
  const count = await mongoose.connection.db
    .collection("sessions")
    .countDocuments();
  const collections = await mongoose.connection.db.listCollections().toArray();
  res.json({
    sessionsCount: count,
    collections: collections.map((c) => c.name),
  });
});

// 🔹 QR Login Route
app.get("/whatsapp/login", async (req, res) => {
  try {
    if (!client) return res.status(500).send("Client not initialized yet");
    client.once("qr", (qr) => {
      console.log("📲 New QR generated for manual login.");
      res.type("text/plain").send(qr);
    });
    await client.initialize();
  } catch (err) {
    res.status(500).send("Error initializing login: " + err.message);
  }
});

// 🔹 Send Message Route
app.post("/whatsapp/send", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!client) return res.status(500).send("Client not ready");
    if (!phone || !message)
      return res.status(400).send("Missing phone or message");

    const number = phone.includes("@c.us") ? phone : `${phone}@c.us`;
    await client.sendMessage(number, message);
    console.log(`📤 Message sent to ${phone}: ${message}`);
    res.json({ status: "success", to: phone, message });
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).send("Error sending message: " + err.message);
  }
});

// === Graceful Shutdown ===
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — Render is restarting deployment");
  try {
    if (client) {
      console.log("💾 Saving session before shutdown...");
      await client.logout().catch(() => {});
    }
  } catch (e) {
    console.error("Error during SIGTERM cleanup:", e);
  } finally {
    process.exit(0);
  }
});

// === Startup ===
app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);

  (async () => {
    try {
      await connectMongo();

      const sessionsCount = await mongoose.connection.db
        .collection("sessions")
        .countDocuments()
        .catch(() => 0);
      console.log(`ℹ️ sessions in DB: ${sessionsCount}`);

      if (sessionsCount === 0) {
        const restored = await restoreSessionsIfMissing();
        if (restored) console.log("✅ Session restored before init");
        else console.log("ℹ️ no sessions in DB (first-time login)");
      }

      // 🕒 انتظار 10 ثواني حتى يجهز Render قبل init
      console.log("⏳ Waiting 10s before initializing WhatsApp client...");
      await new Promise((r) => setTimeout(r, 10000));

      await initClient();
    } catch (err) {
      console.error("❌ Startup error:", err);
    }
  })();
});
