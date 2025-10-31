import express from "express";
import mongoose from "mongoose";
import pkg from "whatsapp-web.js";
const { Client, RemoteAuth } = pkg;
import { MongoStore } from "wwebjs-mongo";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const CLIENT_ID = "render-stable-client";

if (!MONGODB_URI) {
  console.error("❌ ERROR: Missing MONGODB_URI in environment variables.");
  process.exit(1);
}

// ----------------------------------------------------
// 🧠 Connect to MongoDB
// ----------------------------------------------------
console.log("⏳ Connecting to MongoDB Atlas...");
await mongoose.connect(MONGODB_URI);
console.log("✅ Connected to MongoDB Atlas");

const db = mongoose.connection;
const collections = await db.db.listCollections().toArray();
const collectionNames = collections.map((c) => c.name);
console.log("ℹ️ collections in DB:", collectionNames.join(", "));

// ----------------------------------------------------
// 🔍 Detect existing WhatsApp session
// ----------------------------------------------------
const hasSession = collectionNames.some((n) =>
  n.startsWith(`whatsapp-RemoteAuth-${CLIENT_ID}`)
);

if (hasSession) {
  console.log("✅ Found existing WhatsApp session data");
} else {
  console.log("ℹ️ No existing session found (first-time login expected)");
}

// ----------------------------------------------------
// ⚙️ WhatsApp Client Setup
// ----------------------------------------------------
const store = new MongoStore({ mongoose: mongoose });
const client = new Client({
  authStrategy: new RemoteAuth({
    store,
    backupSyncIntervalMs: 60000, // 1 min backup interval
    clientId: CLIENT_ID,
  }),
  puppeteer: {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--headless",
    ],
  },
});

// ----------------------------------------------------
// 🔁 Client Event Handlers
// ----------------------------------------------------
client.on("qr", (qr) => {
  console.log("📱 QR generated — open your Render logs to scan it!");
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated");
});

client.on("ready", () => {
  console.log("🤖 WhatsApp client READY");
  startServer(); // Start express server only now
});

client.on("disconnected", (reason) => {
  console.log("⚠️ WhatsApp disconnected:", reason);
  console.log("🔁 Reinitializing client in 15s...");
  setTimeout(() => client.initialize(), 15000);
});

client.on("remote_session_saved", () => {
  console.log("💾 Remote session saved to MongoDB");
});

// ----------------------------------------------------
// ⏳ Initialize Client
// ----------------------------------------------------
console.log("⏳ Waiting 10s before initializing client...");
setTimeout(async () => {
  try {
    console.log("⚙️ Initializing WhatsApp client...");
    await client.initialize();
    console.log("✅ client.initialize() succeeded");
  } catch (err) {
    console.error("❌ client.initialize() failed:", err);
  }
}, 10000);

// ----------------------------------------------------
// 💾 Graceful Shutdown for Render (SIGTERM)
// ----------------------------------------------------
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — saving session before shutdown...");
  try {
    await store.save();
    console.log("✅ Session saved successfully. Exiting cleanly.");
  } catch (err) {
    console.error("⚠️ Failed to save session before exit:", err);
  }
  process.exit(0);
});

// ----------------------------------------------------
// 🚀 Express Server (starts only when client READY)
// ----------------------------------------------------
function startServer() {
  if (app.listening) return;
  app.get("/", (req, res) => {
    res.send("✅ WhatsApp Bot is running and connected!");
  });
  app.listen(PORT, () => {
    console.log(`🚀 Server listening on ${PORT}`);
    app.listening = true;
  });
}
