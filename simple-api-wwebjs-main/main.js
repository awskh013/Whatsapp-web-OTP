const express = require("express");
const { MongoStore } = require("wwebjs-mongo");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { Pool } = require("pg");
const qr2 = require("qrcode");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;

// 🧩 إعداد قاعدة البيانات (CockroachDB / PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 🧠 إعداد عميل WhatsApp
let tokenQr = null;
let client;

// 🪄 إنشاء التخزين باستخدام Cockroach كمخزن بيانات
async function createStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_remote_auth (
      id SERIAL PRIMARY KEY,
      session_id TEXT UNIQUE,
      data JSONB
    );
  `);

  // "wwebjs-mongo" عادة يستخدم Mongo، لكن يمكننا تقليده عبر DB JSON.
  // لذا سنخزن الجلسة يدوياً عبر RemoteAuth.
}

// 🧩 تهيئة عميل RemoteAuth
(async () => {
  await createStore();

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "render-free",
      store: {
        // نحاكي التخزين عبر CockroachDB
        save: async (session) => {
          await pool.query(
            `INSERT INTO whatsapp_remote_auth (session_id, data)
             VALUES ('render-free', $1)
             ON CONFLICT (session_id) DO UPDATE SET data = $1`,
            [session]
          );
        },
        load: async () => {
          const result = await pool.query(
            "SELECT data FROM whatsapp_remote_auth WHERE session_id = 'render-free' LIMIT 1"
          );
          return result.rows.length ? result.rows[0].data : null;
        },
        remove: async () => {
          await pool.query("DELETE FROM whatsapp_remote_auth WHERE session_id = 'render-free'");
        },
      },
      backupSyncIntervalMs: 300000, // كل 5 دقائق يزامن DB
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

  client.on("qr", (qr) => {
    tokenQr = qr;
    console.log("📱 QR generated");
  });

  client.on("ready", () => {
    tokenQr = false;
    console.log("🤖 WhatsApp Bot Ready!");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failed:", msg);
  });

  client.on("disconnected", (reason) => {
    console.warn("⚠️ Disconnected:", reason);
    setTimeout(() => {
      client.initialize();
    }, 10000);
  });

  await client.initialize();
})();

// 🧠 مسارات HTTP
app.get("/", (req, res) => {
  res.send("✅ WhatsApp bot is running on Render Free Plan!");
});

app.get("/whatsapp/login", async (req, res) => {
  if (tokenQr === null) return res.send("Please wait...");
  if (tokenQr === false) return res.send("✅ Already logged in!");
  qr2.toDataURL(tokenQr, (err, src) => {
    if (err) return res.status(500).send("Error generating QR");
    return res.render("qr", { img: src });
  });
});

app.post("/whatsapp/sendmessage/", async (req, res) => {
  try {
    if (req.headers["x-password"] != process.env.WHATSAPP_API_PASSWORD)
      throw new Error("Invalid password");
    if (!req.body.message) throw new Error("Message is required");
    if (!req.body.phone) throw new Error("Phone number is required");

    if (!client || !client.info)
      throw new Error("WhatsApp client not ready yet");

    await client.sendMessage(`${req.body.phone}@c.us`, req.body.message);
    res.json({ ok: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🧹 إنهاء نظيف عند SIGTERM
process.on("SIGTERM", async () => {
  console.log("🛑 Graceful shutdown...");
  try {
    await pool.end();
  } catch {}
  process.exit(0);
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
