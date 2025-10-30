// ==========================
// 🟢 WhatsApp Bot — Render Optimized
// ==========================
import express from "express";
import mongoose from "mongoose";
import { MongoStore } from "wwebjs-mongo";
import { Client, RemoteAuth } from "whatsapp-web.js";
import qr from "qrcode";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", "pages");

const PORT = process.env.PORT || 3000;

let client;
let clientReady = false;
let tokenQr = null;

// ==========================
// 🧠 Connect to MongoDB
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
      mongoose,
      collectionName: "sessions",
    });

    const sessionCount = await mongoose.connection.db
      .collection("sessions")
      .countDocuments();

    const hasSession = sessionCount > 0;
    if (hasSession) {
      console.log("💾 Session found in Mongo — reusing it.");
    } else {
      console.log("🆕 No session found — will generate new QR.");
    }

    // ==========================
    // ⚙️ Setup WhatsApp Client
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
            "--disable-background-networking",
            "--disable-sync",
            "--disable-default-apps",
            "--mute-audio",
          ],
        };

    client = new Client({
      authStrategy: new RemoteAuth({
        clientId: "render-stable-client",
        store,
        backupSyncIntervalMs: 300000, // كل 5 دقائق
      }),
      puppeteer: puppeteerOptions,
      takeoverOnConflict: true,
      restartOnAuthFail: true,
      webVersionCache: { type: "none" },
    });

    // ==========================
    // 🎯 WhatsApp Events
    // ==========================
    client.on("qr", (qrCode) => {
      tokenQr = qrCode;
      c
