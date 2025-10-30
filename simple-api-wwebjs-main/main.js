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

const hasSession =
  (await mongoose.connection.db
    .collection("sessions")
    .countDocuments()) > 0;

// 🧠 هذا أهم تعديل: لا تشغّل Puppeteer إن كان فيه جلسة محفوظة
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
        "--single-process"
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
