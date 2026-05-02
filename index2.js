import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import https from "https";
import Reminder from "./models/remainder.js";

const app = express();
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI);
mongoose.connection.on("connected", () => {
  console.log("MongoDB Connected");
});

app.use(cors());
app.use(express.json());

let latestAlert = null;
let medicineReminder = null;

// =====================================================
// 🔔 ALERT NOTIFICATION SYSTEM
// =====================================================

// Cooldown: only send alert once every 5 minutes per alert type
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
let lastAlertSentTime = 0;
let lastAlertReason = "";

// Guardian contact info from .env
const GUARDIAN_PHONE  = process.env.GUARDIAN_PHONE  || "";   // e.g. +917701XXXXXX
const GUARDIAN_EMAIL  = process.env.GUARDIAN_EMAIL  || "";   // e.g. guardian@gmail.com
const SENDER_EMAIL    = process.env.ALERT_EMAIL_USER || "";  // your Gmail
const SENDER_PASSWORD = process.env.ALERT_EMAIL_PASS || "";  // Gmail App Password

// Build a human-readable alert reason
function buildAlertReason({ fall, dehydrated, heartRate, temperature }) {
  const reasons = [];
  if (fall)                          reasons.push("🚨 Fall Detected");
  if (dehydrated)                    reasons.push("💧 Low Skin Hydration");
  if (heartRate > 120)               reasons.push(`❤️ High Heart Rate (${heartRate} bpm)`);
  if (heartRate < 50)                reasons.push(`❤️ Low Heart Rate (${heartRate} bpm)`);
  if (temperature > 38)              reasons.push(`🌡️ High Temperature (${temperature}°C)`);
  return reasons.join(", ") || "Risk Detected";
}

// ── 1. Email via Gmail (FREE, unlimited) ──────────────────────────────────────
async function sendEmailAlert(alertData, reason) {
  if (!SENDER_EMAIL || !SENDER_PASSWORD || !GUARDIAN_EMAIL) {
    console.log("📧 [EMAIL SIMULATION] SMS would be sent:");
    console.log(`   To     : ${GUARDIAN_EMAIL || "guardian@example.com"}`);
    console.log(`   Subject: 🚨 ELDER HEALTH ALERT`);
    console.log(`   Reason : ${reason}`);
    console.log(`   Data   : Temp=${alertData.temperature}°C | HR=${alertData.heartRate}bpm | Hydration=${alertData.hydration}%`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: SENDER_EMAIL, pass: SENDER_PASSWORD },
  });

  const mailOptions = {
    from: `"Elder Care Alert" <${SENDER_EMAIL}>`,
    to: GUARDIAN_EMAIL,
    subject: "🚨 ELDER HEALTH ALERT — Immediate Attention Required",
    html: `
      <div style="font-family:Arial;border:2px solid red;padding:20px;border-radius:8px;">
        <h2 style="color:red;">🚨 Health Alert Triggered</h2>
        <p><strong>Reason:</strong> ${reason}</p>
        <hr/>
        <table>
          <tr><td><strong>Temperature</strong></td><td>${alertData.temperature}°C</td></tr>
          <tr><td><strong>Heart Rate</strong></td><td>${alertData.heartRate} bpm</td></tr>
          <tr><td><strong>Hydration</strong></td><td>${alertData.hydration ?? "N/A"}%</td></tr>
          <tr><td><strong>Fall Detected</strong></td><td>${alertData.fall ? "YES ⚠️" : "No"}</td></tr>
          <tr><td><strong>Time</strong></td><td>${alertData.time}</td></tr>
        </table>
        <p style="color:red;margin-top:15px;"><strong>Please check on the elder immediately.</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 Email alert sent to ${GUARDIAN_EMAIL}`);
  } catch (err) {
    console.error("📧 Email send failed:", err.message);
  }
}

// ── 2. Push Notification via ntfy.sh (FREE, works in India, no account needed) ──
const ELDER_LAT  = process.env.ELDER_LAT  || "17.542159";
const ELDER_LNG  = process.env.ELDER_LNG  || "78.386764";
const MAPS_LINK  = `https://maps.google.com/?q=${ELDER_LAT},${ELDER_LNG}`;
const NTFY_TOPIC = process.env.NTFY_TOPIC || "elder-care-anti-iot";

function sendPushNotification(alertData, reason) {
  const message =
    `Reason: ${reason}\n` +
    `Temp: ${alertData.temperature}C | Heart: ${alertData.heartRate} bpm | Hydration: ${alertData.hydration ?? "?"}%\n` +
    `Location: ${MAPS_LINK}`;

  const body = Buffer.from(message);

  const options = {
    hostname: "ntfy.sh",
    path: `/${NTFY_TOPIC}`,
    method: "POST",
    headers: {
      "Title":          "ELDER HIGH ALERT",
      "Priority":       "urgent",
      "Tags":           "rotating_light,sos,warning",
      "Content-Length": body.length,
    },
  };

  const req = https.request(options, (res) => {
    console.log(`🔔 ntfy.sh push sent → topic: ${NTFY_TOPIC} | HTTP: ${res.statusCode}`);
  });

  req.on("error", (e) => console.error("🔔 ntfy push error:", e.message));
  req.write(body);
  req.end();
}

// ── 3. Voice Call via Twilio (FREE trial — sign up at twilio.com, no card needed) ──
const TWILIO_SID   = process.env.TWILIO_SID   || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN  || "";
const TWILIO_FROM  = process.env.TWILIO_FROM   || "";  // your Twilio number e.g. +12025551234

function makeAlertCall(reason) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !GUARDIAN_PHONE) {
    console.log("📞 [CALL SIMULATION] Voice call would be made to:", GUARDIAN_PHONE || "not set");
    console.log(`   Message: "Elder alert! ${reason}. Please check immediately."`);
    console.log("   → Set TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM in .env for real calls.");
    return;
  }

  const twiml =
    `<Response>` +
      `<Say voice="alice" language="en-IN">` +
        `This is an elder care alert. ${reason.replace(/[^\w\s,.]/g, "")}. ` +
        `Please check on the elder immediately. ` +
        `Repeating: ${reason.replace(/[^\w\s,.]/g, "")}. Please check immediately.` +
      `</Say>` +
    `</Response>`;

  const postData = new URLSearchParams({
    To:    GUARDIAN_PHONE,
    From:  TWILIO_FROM,
    Twiml: twiml,
  }).toString();

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");

  const options = {
    hostname: "api.twilio.com",
    path:     `/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
    method:   "POST",
    headers: {
      "Authorization":  `Basic ${auth}`,
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sid) {
          console.log(`📞 Voice call initiated → ${GUARDIAN_PHONE} | SID: ${parsed.sid}`);
        } else {
          console.error("📞 Call failed:", parsed.message || data);
        }
      } catch {
        console.error("📞 Call response parse error:", data);
      }
    });
  });

  req.on("error", (e) => console.error("📞 Call request error:", e.message));
  req.write(postData);
  req.end();
}

function sendSMSAlert(alertData, reason) {
  const smsBody =
    `🚨 HIGH ALERT — Elder needs help!\n` +
    `Reason  : ${reason}\n` +
    `Temp    : ${alertData.temperature}°C\n` +
    `Heart   : ${alertData.heartRate} bpm\n` +
    `Hydration: ${alertData.hydration ?? "?"}%\n` +
    `Location: ${MAPS_LINK}`;

  if (!GUARDIAN_PHONE || GUARDIAN_PHONE === "+91XXXXXXXXXX") {
    console.log("📱 [SMS SIMULATION] Would send:");
    console.log(smsBody);
    return;
  }

  const postData = `phone=${encodeURIComponent(GUARDIAN_PHONE)}&message=${encodeURIComponent(smsBody)}&key=textbelt`;

  const options = {
    hostname: "textbelt.com",
    path: "/text",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      const parsed = JSON.parse(data);
      if (parsed.success) {
        console.log(`📱 SMS sent to ${GUARDIAN_PHONE} — quota left: ${parsed.quotaRemaining}`);
      } else {
        console.log(`📱 SMS failed: ${parsed.error} (free tier = 1/day)`);
      }
    });
  });

  req.on("error", (e) => console.error("📱 SMS request error:", e.message));
  req.write(postData);
  req.end();
}

// ── Master trigger: called when risk = HIGH ───────────────────────────────────
async function triggerAlertNotification(alertData) {
  const now = Date.now();
  const reason = buildAlertReason(alertData);

  // Cooldown check — don't spam for same reason within 5 minutes
  if (now - lastAlertSentTime < ALERT_COOLDOWN_MS && reason === lastAlertReason) {
    console.log(`⏳ Alert cooldown active — next alert in ${Math.ceil((ALERT_COOLDOWN_MS - (now - lastAlertSentTime)) / 1000)}s`);
    return;
  }

  lastAlertSentTime = now;
  lastAlertReason = reason;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚨 RISK HIGH — SENDING ALERT NOTIFICATIONS");
  console.log(`   Reason : ${reason}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Fire all three: push + email + voice call
  await sendEmailAlert(alertData, reason);
  sendPushNotification(alertData, reason);
  makeAlertCall(reason);
}

/* =====================================================
   1️⃣ ESP32 HEALTH DATA
===================================================== */

app.post("/alert", async (req, res) => {
  const { temperature, heartRate, risk, fall, hydration, dehydrated } = req.body;

  if (
    temperature === undefined ||
    heartRate === undefined ||
    risk === undefined ||
    fall === undefined
  ) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  latestAlert = {
    temperature,
    heartRate,
    risk,
    fall,
    hydration: hydration !== undefined ? hydration : null,
    dehydrated: dehydrated !== undefined ? dehydrated : false,
    time: new Date().toISOString(),
  };

  console.log("========== ESP32 DATA ==========");
  console.log(latestAlert);

  // Trigger notification if risk is HIGH
  if (risk === "HIGH") {
    await triggerAlertNotification(latestAlert);
  }

  res.json({ success: true });
});

/* =====================================================
   🧪 TEST — hit this once to fire a test push notification
===================================================== */
app.get("/test-sms", (req, res) => {
  const fakeAlert = {
    temperature: 38.5,
    heartRate: 130,
    hydration: 28,
    fall: false,
    dehydrated: true,
    time: new Date().toISOString(),
  };

  const reason = buildAlertReason(fakeAlert);

  console.log("🧪 TEST PUSH + CALL triggered manually");
  sendPushNotification(fakeAlert, reason);
  makeAlertCall(reason);

  res.json({
    message: "Test push notification fired!",
    ntfyTopic: NTFY_TOPIC,
    ntfyUrl: `https://ntfy.sh/${NTFY_TOPIC}`,
    mapsLink: MAPS_LINK,
    reason,
  });
});

app.get("/alert", (req, res) => {
  res.json(latestAlert ?? {});
});

/* =====================================================
   2️⃣ MEDICINE REMINDER SYSTEM
===================================================== */

app.post("/set-medicine", async (req, res) => {
  const { medicineName, times } = req.body;

  if (!medicineName || !Array.isArray(times)) {
    return res.status(400).json({ error: "Invalid medicine data" });
  }

  let reminder = await Reminder.findOne();

  if (!reminder) {
    reminder = new Reminder({ medicineName, times });
  } else {
    reminder.medicineName = medicineName;
    reminder.times = times;
    reminder.acknowledged = false;
  }

  await reminder.save();
  res.json({ success: true });
});

app.get("/reminder", async (req, res) => {
  const currentTime = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const reminder = await Reminder.findOne();

  if (!reminder) {
    return res.json({ serverTime: currentTime, medicineName: "", trigger: false });
  }

  if (reminder.times.includes(currentTime) && reminder.acknowledged === false) {
    return res.json({
      serverTime: currentTime,
      medicineName: reminder.medicineName,
      trigger: true,
    });
  }

  res.json({
    serverTime: currentTime,
    medicineName: reminder.medicineName,
    trigger: false,
  });
});

/* =====================================================
   3️⃣ ACKNOWLEDGE FROM WATCH
===================================================== */

app.post("/acknowledge", async (req, res) => {
  const reminder = await Reminder.findOne();
  if (!reminder) {
    return res.status(400).json({ error: "No reminder set" });
  }

  reminder.acknowledged = true;
  await reminder.save();

  console.log("✅ Medicine Acknowledged by Watch");
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Guardian phone : ${GUARDIAN_PHONE  || "⚠️  Not set (GUARDIAN_PHONE in .env)"}`);
  console.log(`Guardian email : ${GUARDIAN_EMAIL  || "⚠️  Not set (GUARDIAN_EMAIL in .env)"}`);
  console.log(`Sender email   : ${SENDER_EMAIL    || "⚠️  Not set (ALERT_EMAIL_USER in .env)"}`);
});