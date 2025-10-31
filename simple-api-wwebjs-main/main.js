import express from "express";
import mongoose from "mongoose";
import pkg from "whatsapp-web.js";
const { Client, RemoteAuth } = pkg;
import { MongoStore } from "wwebjs-mongo";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const CLIENT_ID = "render-stable-client";

// ============================================================
// 🧠 Connect to MongoDB
// ============================================================
console.log("⏳ Connecting to MongoDB Atlas...");
await mongoose.connect(MONGODB_URI);
console.log("✅ Connected to MongoDB Atlas");

const db = mongoose.connection;
const collections = await db.db.listCollections().toArray();
const collectionNames = collections.map((c) => c.name);
console.log("ℹ️ collections in DB:", collectionNames.join(", "));

const hasSession = collectionNames.some((n) =>
  n.startsWith(`whatsapp-RemoteAuth-${CLIENT_ID}`)
);
console.log(
  hasSession
    ? "✅ Found existing WhatsApp session data"
    : "ℹ️ No existing session found (first login expected)"
);

// ============================================================
// ⚙️ WhatsApp Client Setup
// ============================================================
const store = new MongoStore({ mongoose: mongoose });
const client = new Client({
  authStrategy: new RemoteAuth({
    store,
    backupSyncIntervalMs: 60000,
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

// ============================================================
// 🔁 Client Events
// ============================================================
client.on("qr", () => console.log("📱 QR generated — scan in Render logs!"));
client.on("authenticated", () => console.log("✅ WhatsApp authenticated"));
client.on("ready", () => console.log("🤖 WhatsApp client READY"));
client.on("remote_session_saved", () =>
  console.log("💾 Remote session saved to MongoDB")
);
client.on("disconnected", (reason) => {
  console.log("⚠️ WhatsApp disconnected:", reason);
  console.log("🔁 Reinitializing in 15s...");
  setTimeout(() => client.initialize(), 15000);
});

// ============================================================
// 🚀 Start Express Immediately (so Render sees a live port)
// ============================================================
app.get("/", (_, res) =>
  res.send("✅ WhatsApp bot is running and initializing in background.")
);
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`)
);

// ============================================================
// ⏳ Initialize Client in Background
// ============================================================
setTimeout(async () => {
  try {
    console.log("⚙️ Initializing WhatsApp client...");
    await client.initialize();
    console.log("✅ client.initialize() succeeded");
  } catch (err) {
    console.error("❌ client.initialize() failed:", err);
  }
}, 5000);

// ============================================================
// 💾 Handle SIGTERM (Render graceful shutdown)
// ============================================================
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
