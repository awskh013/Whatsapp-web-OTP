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
let tokenQr = null;
let client;

// ==========================
// 🟢 اتصال MongoDB
// ==========================
(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL, {
      dbName: "whatsapp-bot",
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB Atlas");

    const store = new MongoStore({
      mongoose: mongoose,
      collectionName: "sessions",
    });

    // ==========================
    // ⚙️ إعداد WhatsApp Client
    // ==========================
    client = new Client({
      authStrategy: new RemoteAuth({
        clientId: "render-free-stable", // ثابت حتى بين restarts
        store,
        backupSyncIntervalMs: 60000, // كل دقيقة
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--single-process",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
    });

    // ==========================
    // 📱 Events
    // ==========================
    client.on("qr", (qr) => {
      tokenQr = qr;
      console.log("📱 QR generated (scan to login)");
    });

    client.on("ready", () => {
      tokenQr = false;
      console.log("🤖 WhatsApp Bot Ready and Logged In!");
    });

    client.on("auth_failure", (msg) => {
      console.error("❌ Auth failed:", msg);
      tokenQr = null;
    });

    client.on("disconnected", async (reason) => {
      console.warn("⚠️ Disconnected:", reason);
      try {
        await client.destroy();
      } catch (err) {
        console.error("Error destroying client:", err.message);
      }
      setTimeout(async () => {
        console.log("♻️ Reinitializing WhatsApp client...");
        await client.initialize();
      }, 15000);
    });

    await client.initialize();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
})();

// ==========================
// 🚀 Routes
// ==========================
app.get("/", (req, res) => {
  res.send("✅ WhatsApp bot is running on Render Free Plan!");
});

app.get("/whatsapp/login", async (req, res) => {
  if (tokenQr === null && client)
    return res.send("⏳ Client initializing, please refresh in a few seconds...");
  if (tokenQr === false) return res.send("✅ Already logged in!");

  qr2.toDataURL(tokenQr, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.render("qr", { img: src });
  });
});

app.post("/whatsapp/sendmessage/", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD)
      throw new Error("Invalid password");
    if (!req.body.message) throw new Error("Message is required");
    if (!req.body.phone) throw new Error("Phone number is required");

    if (!client || !client.info)
      throw new Error("WhatsApp client not ready yet. Try again in a few seconds.");

    await client.sendMessage(`${req.body.phone}@c.us`, req.body.message);
    res.json({ ok: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("❌ Error sending message:", err);
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
