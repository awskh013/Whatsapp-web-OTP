import express from "express";
import qr2 from "qrcode";
import mongoose from "mongoose";
import dotenv from "dotenv";
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

let tokenQr = null;
let client;
let clientReady = false;

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
    // ⚙️ فحص وجود جلسة محفوظة مسبقاً
    // ==========================
    const hasSession =
      (await mongoose.connection.db
        .collection("sessions")
        .countDocuments()) > 0;

    // ==========================
    // 🧠 إعداد WhatsApp Client
    // ==========================
    const puppeteerOptions = hasSession
      ? undefined
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
      console.log("♻️ Reinitializing WhatsApp client...");
      setTimeout(async () => {
        await client.initialize();
      }, 10000);
    });

    await client.initialize();
  } catch (err) {
    console.error("❌ Initialization failed:", err);
  }
})();

// ==========================
// 🚀 Routes
// ==========================
app.get("/", (req, res) => {
  res.send("✅ WhatsApp bot is running on Render Free Plan!");
});

app.get("/whatsapp/login", async (req, res) => {
  if (clientReady) return res.send("✅ Already logged in!");
  if (!tokenQr) return res.send("⏳ Please wait... initializing client...");
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

    if (!clientReady)
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} — Light Mode Enabled`));
