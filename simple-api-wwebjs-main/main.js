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

let client;
let qrCodeValue = null;
let clientReady = false;

// ==========================
// 🟢 MongoDB Connection
// ==========================
async function connectMongo() {
  await mongoose.connect(process.env.MONGO_URL, {
    dbName: "whatsapp-bot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");
}

// ==========================
// 🤖 Initialize WhatsApp Client
// ==========================
async function initClient() {
  const store = new MongoStore({
    mongoose,
    collectionName: "sessions",
  });

  const hasSession =
    (await mongoose.connection.db
      .collection("sessions")
      .countDocuments()) > 0;

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "render-stable-client",
      store,
      backupSyncIntervalMs: 300000, // كل 5 دقائق يحدّث الجلسة
    }),
    puppeteer: {
      headless: true,
      executablePath: "/usr/bin/chromium",
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
  });

  client.on("qr", (qr) => {
    qrCodeValue = qr;
    console.log("📱 QR generated — waiting for scan...");
  });

  client.on("ready", () => {
    clientReady = true;
    qrCodeValue = null;
    console.log("🤖 WhatsApp Bot Ready and Logged In!");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failed:", msg);
    clientReady = false;
  });

  client.on("disconnected", async (reason) => {
    console.warn("⚠️ Disconnected:", reason);
    clientReady = false;
    try {
      await client.destroy();
    } catch {}
    console.log("♻️ Restarting client in 10 seconds...");
    setTimeout(initClient, 10000);
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error("❌ Initialization failed:", err);
  }
}

// ==========================
// 🚀 Express Routes
// ==========================
app.get("/", (req, res) => {
  res.send("✅ WhatsApp bot is running on Render (Free Plan)");
});

app.get("/whatsapp/login", async (req, res) => {
  if (clientReady) return res.send("✅ Already logged in!");
  if (!qrCodeValue) return res.send("⏳ Initializing... please wait");
  qr2.toDataURL(qrCodeValue, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.render("qr", { img: src });
  });
});

app.post("/whatsapp/sendmessage", async (req, res) => {
  try {
    if (req.headers["x-password"] !== process.env.WHATSAPP_API_PASSWORD)
      throw new Error("Invalid password");
    const { phone, message } = req.body;
    if (!phone || !message) throw new Error("Phone and message are required");
    if (!clientReady)
      throw new Error("WhatsApp client not ready. Try again soon.");

    await client.sendMessage(`${phone}@c.us`, message);
    res.json({ ok: true, message: "Message sent successfully ✅" });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================
// 🛑 Graceful Shutdown
// ==========================
process.on("SIGTERM", async () => {
  console.log("🛑 Graceful shutdown...");
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(0);
});

// ==========================
// 🔄 Keep Render Alive
// ==========================
setInterval(() => {
  fetch(`https://${process.env.RENDER_EXTERNAL_URL || ""}`).catch(() => {});
}, 600000); // كل 10 دقائق

// ==========================
// 🚀 Start App
// ==========================
(async () => {
  await connectMongo();
  await initClient();
  app.listen(PORT, () =>
    console.log(`🚀 Server running on port ${PORT} — Stable Mode Enabled`)
  );
})();
