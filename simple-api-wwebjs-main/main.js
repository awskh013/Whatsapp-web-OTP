const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { Pool } = require("pg");
const qr2 = require("qrcode");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;

// اتصال قاعدة البيانات (CockroachDB أو PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let tokenQr = null;
let client;

// تحميل الجلسة من قاعدة البيانات
async function loadSession() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_session (
        id SERIAL PRIMARY KEY,
        data JSONB
      );
    `);
    const result = await pool.query("SELECT data FROM whatsapp_session LIMIT 1");
    if (result.rows.length > 0) {
      console.log("✅ Session loaded from DB");
      return result.rows[0].data;
    } else {
      console.log("ℹ️ No session found in DB");
      return null;
    }
  } catch (err) {
    console.error("❌ Error loading session from DB:", err);
    return null;
  }
}

// حفظ الجلسة في قاعدة البيانات
async function saveSession(session) {
  try {
    await pool.query("DELETE FROM whatsapp_session");
    await pool.query("INSERT INTO whatsapp_session (data) VALUES ($1)", [session]);
    console.log("💾 Session saved to DB");
  } catch (err) {
    console.error("❌ Error saving session to DB:", err);
  }
}

// تهيئة العميل
(async () => {
  const sessionData = await loadSession();

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: "/tmp/wwebjs-auth", // مؤقت لتقليل الحجم
      clientId: "primary",
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

  client.on("authenticated", async (session) => {
    await saveSession(session);
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failed:", msg);
  });

  client.initialize();
})();

// المسارات
app.get("/", (req, res) => {
  res.send("Hello World from WhatsApp Bot!");
});

app.get("/whatsapp/login", async (req, res) => {
  if (tokenQr === null) return res.send("Please try again in a few seconds...");
  if (tokenQr === false) return res.send("Login successful!");
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

    await client.sendMessage(`${req.body.phone}@c.us`, req.body.message);
    res.json({ ok: true, message: "Message sent" });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ ok: false, message: "Message not sent" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
