const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qr2 = require("qrcode");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;

const session = new Client({
  authStrategy: new LocalAuth({
    dataPath: "session",
    clientId: "primary",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu"
    ],
  },
});

let tokenQr = null;

session.on("qr", (qr) => {
  tokenQr = qr;
  console.log("QR generated");
});

session.on("ready", () => {
  tokenQr = false;
  console.log("WhatsApp Bot Ready!");
});

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
    await session.sendMessage(`${req.body.phone}@c.us`, req.body.message);
    res.json({ ok: true, message: "Message sent" });
  } catch (error) {
    console.log("Error:", error);
    res.status(500).json({ ok: false, message: "Message not sent" });
  }
});

session.initialize();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
