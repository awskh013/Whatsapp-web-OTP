// ==========================
// 🤖 WhatsApp Bot — Whisper Light Edition
// For Render Free Plan (Optimized <300MB)
// ==========================

const express = require("express");
const { MongoStore } = require("wwebjs-mongo");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const qr2 = require("qrcode");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;

let client = null;
let tokenQr = null;
let clientReady = false;

// ==========================
// 🧠 MongoDB Connection
// ==========================
(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL, {
      dbName: "whatsapp-bot",
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB Atlas");

    // إنشاء store للجلسات
    const store = new MongoStore({
      mongoose: mongoose,
      collectionName: "sessions",
    });

    // تحقق من وجود جلسة محفوظة مسبقًا
    const hasSession =
      (await mongoose.connection.db
        .collection("sessions")
        .countDocuments()) > 0;

    // ==========================
    // ⚙️ إعداد WhatsApp Client
    // ==========================
    client = new Client({
      authStrategy: new RemoteAuth({
        clientId: "render-stable-client",
        store,
        backupSyncIntervalMs: 300000, // كل 5 دقائق
      }),
      puppeteer: hasSession
        ? undefined // 🚀 لا نشغل Puppeteer إن كانت الجلسة محفوظة
        : {
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-extensions",
              "--disable-gpu",
              "--no-zygote",
              "--single-process",
            ],
          },
      takeoverOnConflict: true,
      restartOnAuthFail: true,
      webVersionCache: { type: "none" },
    });

    // ==========================
    // 🎯 Events
    // ==========================
    client.on("qr", (qr) => {
      tokenQr = qr;
      console.log("📱 QR generated — Scan it to login.");
    });

    client.on("ready", () => {
      tokenQr = false;
      clientReady = true;
      console.log("🤖 WhatsApp Bot Ready and Logged In!");
    });

    client.on("auth_failure", (msg) => {
      console.error("❌ Auth failed:", msg);
      tokenQr = null;
      clientReady = false;
    });

    client.on("disconnected", async (reason) => {
      console.warn("⚠️ Disconnected:", reason);
      clientReady = false;
      try {
        await client.destroy();
      } catch {}
      setTimeout(async () => {
        console.log("♻️ Reinitializing WhatsApp client...");
        await client.initialize();
      }, 15000);
    });

    await client.initialize();

    // 🧊 نسخ احتياطي للجلسة كل 6 ساعات
    setInterval(async () => {
      const sessions = await mongoose.connection.db
        .collection("sessions")
        .find({})
        .toArray();
      if (sessions.length > 0)
        await mongoose.connection.db
          .collection("sessions_backup")
          .updateOne(
            { _id: "latest" },
            { $set: { data: sessions, updatedAt: new Date() } },
            { upsert: true }
          );
    }, 21600000);
  } catch (err) {
    console.error("❌ Initialization failed:", err);
  }
})();

// ==========================
// 🧭 Helper: تأكد من جاهزية العميل
// ==========================
async function ensureClientReady(retries = 5) {
  for (let i = 0; i < retries; i++) {
    if (client && client.info && clientReady) return true;
    console.log(`⏳ Waiting for client ready... (${i + 1}/${retries})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Client not ready after waiting");
}

// ==========================
// 🚀 Routes
// ==========================
app.get("/", (req, res) => {
  res.send("✅ WhatsApp Bot is running smoothly on Render Free Plan!");
});

// QR Login page
app.get("/whatsapp/login", async (req, res) => {
  if (tokenQr === null) return res.send("⏳ Initializing client, please wait...");
  if (tokenQr === false) return res.send("✅ Already logged in!");
  qr2.toDataURL(tokenQr, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.render("qr", { img: src });
  });
});

// Send message
app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD)
      throw new Error("Invalid password");
    if (!req.body.phone) throw new Error("Phone number is required");
    if (!req.body.message) throw new Error("Message is required");

    await ensureClientReady();

    await client.sendMessage(`${req.body.phone}@c.us`, req.body.message);
    res.json({ ok: true, message: "✅ Message sent successfully!" });
  } catch (err) {
    console.error("❌ Error sending message:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================
// 🛑 Graceful shutdown
// ==========================
process.on("SIGTERM", async () => {
  console.log("🛑 Graceful shutdown...");
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(0);
});

// ==========================
// 🔹 Start server
// ==========================
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT} — Light Mode Enabled`)
);
