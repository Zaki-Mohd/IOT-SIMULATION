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
// 🧠 ADAPTIVE RISK EVALUATION ENGINE
// =====================================================

/**
 * computeRisk — Backend-driven adaptive risk scoring
 *
 * Inputs  : temperature (°C), heartRate (bpm), hydration (0–100%), fallDetected (bool)
 * Outputs : { riskScore (0–100), riskLevel ('LOW'|'MEDIUM'|'HIGH'|'CRITICAL'), explanation }
 *
 * Scoring components:
 *   1. Temperature deviation from normal (37°C)
 *   2. Heart-rate threshold scoring
 *   3. Hydration threshold scoring
 *   4. Fall bonus
 *   5. Interaction bonuses (fall+dehydration, HR+temperature)
 *   6. Context-aware time weighting (12 PM – 4 PM afternoon peak)
 */
function computeRisk({ temperature, heartRate, hydration, fallDetected }) {
  let score = 0;
  const factors = [];   // explainability log

  // ── 1. Temperature scoring (deviation from 37°C) ──────────────────────────
  const NORMAL_TEMP = 37.0;
  const tempDiff = temperature - NORMAL_TEMP;

  if (tempDiff >= 2.5) {
    score += 30;
    factors.push(`🌡️ Severe fever: ${temperature}°C (+${tempDiff.toFixed(1)} above normal) → +30`);
  } else if (tempDiff >= 1.5) {
    score += 20;
    factors.push(`🌡️ High temperature: ${temperature}°C (+${tempDiff.toFixed(1)}) → +20`);
  } else if (tempDiff >= 0.8) {
    score += 10;
    factors.push(`🌡️ Mild fever: ${temperature}°C (+${tempDiff.toFixed(1)}) → +10`);
  } else if (tempDiff < -1.0) {
    score += 15;
    factors.push(`🌡️ Hypothermia risk: ${temperature}°C (${tempDiff.toFixed(1)} below normal) → +15`);
  } else {
    factors.push(`🌡️ Normal temperature: ${temperature}°C → +0`);
  }

  // ── 2. Heart-rate scoring ──────────────────────────────────────────────────
  if (heartRate > 130) {
    score += 30;
    factors.push(`❤️ Severe tachycardia: ${heartRate} bpm → +30`);
  } else if (heartRate > 120) {
    score += 20;
    factors.push(`❤️ High heart rate: ${heartRate} bpm → +20`);
  } else if (heartRate > 110) {
    score += 10;
    factors.push(`❤️ Elevated heart rate: ${heartRate} bpm → +10`);
  } else if (heartRate < 40) {
    score += 30;
    factors.push(`❤️ Severe bradycardia: ${heartRate} bpm → +30`);
  } else if (heartRate < 50) {
    score += 20;
    factors.push(`❤️ Low heart rate: ${heartRate} bpm → +20`);
  } else {
    factors.push(`❤️ Normal heart rate: ${heartRate} bpm → +0`);
  }

  // ── 3. Hydration scoring ───────────────────────────────────────────────────
  if (hydration < 25) {
    score += 25;
    factors.push(`💧 Severe dehydration: hydration ${hydration}% → +25`);
  } else if (hydration < 35) {
    score += 15;
    factors.push(`💧 Moderate dehydration: hydration ${hydration}% → +15`);
  } else if (hydration < 45) {
    score += 8;
    factors.push(`💧 Mild dehydration: hydration ${hydration}% → +8`);
  } else {
    factors.push(`💧 Adequate hydration: ${hydration}% → +0`);
  }

  // ── 4. Fall detection ──────────────────────────────────────────────────────
  if (fallDetected) {
    score += 25;
    factors.push(`🚨 Fall detected → +25`);
  }

  // ── 5. INTERACTION BONUSES ─────────────────────────────────────────────────

  // 5a. Fall + Dehydration → compounded emergency
  if (fallDetected && hydration < 45) {
    score += 10;
    factors.push(`⚡ Interaction: Fall + Dehydration → extra +10`);
  }

  // 5b. High HR + High Temperature → heat stroke risk
  if (heartRate > 110 && tempDiff >= 1.5) {
    score += 10;
    factors.push(`⚡ Interaction: High HR + Fever (heat-stroke risk) → extra +10`);
  }

  // ── 6. CONTEXT-AWARE: Afternoon heat window (12 PM – 4 PM IST) ────────────
  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const hourIST = nowIST.getHours();
  const isAfternoonPeak = hourIST >= 12 && hourIST < 16;

  if (isAfternoonPeak && hydration < 40) {
    score += 8;
    factors.push(
      `🕛 Context: Afternoon peak (${hourIST}:00 IST) + low hydration (${hydration}%) → +8`
    );
  }

  // ── Cap score at 100 ───────────────────────────────────────────────────────
  score = Math.min(score, 100);

  // ── Map score → risk level ─────────────────────────────────────────────────
  let riskLevel;
  if (score >= 70) {
    riskLevel = "CRITICAL";
  } else if (score >= 50) {
    riskLevel = "HIGH";
  } else if (score >= 25) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  const explanation =
    `Risk Score: ${score}/100 | Level: ${riskLevel}\n` +
    `Factors: ${factors.join(" | ")}`;

  return { riskScore: score, riskLevel, explanation, factors };
}

// =====================================================
// 📊 ADAPTIVE COOLDOWN SYSTEM
// =====================================================

// Per-level cooldown durations (ms)
const COOLDOWN_BY_LEVEL = {
  CRITICAL : 1 * 60 * 1000,   //  1 min
  HIGH     : 3 * 60 * 1000,   //  3 min
  MEDIUM   : 5 * 60 * 1000,   //  5 min
  LOW      : Infinity,          // Never alert for LOW
};

// Track last alert per risk level
const lastAlertTime = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

function isCooldownActive(riskLevel) {
  const elapsed = Date.now() - lastAlertTime[riskLevel];
  const cooldown = COOLDOWN_BY_LEVEL[riskLevel];
  return elapsed < cooldown;
}

function updateCooldown(riskLevel) {
  lastAlertTime[riskLevel] = Date.now();
}

function cooldownRemainingSeconds(riskLevel) {
  const elapsed = Date.now() - lastAlertTime[riskLevel];
  const cooldown = COOLDOWN_BY_LEVEL[riskLevel];
  return Math.ceil((cooldown - elapsed) / 1000);
}

// =====================================================
// 🔧 GUARDIAN CONTACT CONFIG
// =====================================================

const GUARDIAN_PHONE  = process.env.GUARDIAN_PHONE  || "";
const GUARDIAN_EMAIL  = process.env.GUARDIAN_EMAIL  || "";
const SENDER_EMAIL    = process.env.ALERT_EMAIL_USER || "";
const SENDER_PASSWORD = process.env.ALERT_EMAIL_PASS || "";

const ELDER_LAT  = process.env.ELDER_LAT  || "17.542159";
const ELDER_LNG  = process.env.ELDER_LNG  || "78.386764";
const MAPS_LINK  = `https://maps.google.com/?q=${ELDER_LAT},${ELDER_LNG}`;
const NTFY_TOPIC = process.env.NTFY_TOPIC || "elder-care-anti-iot";

// =====================================================
// 📧 EMAIL ALERT
// =====================================================

async function sendEmailAlert(alertData, explanation, riskLevel) {
  const levelColor = riskLevel === "CRITICAL" ? "#8B0000" : "#cc0000";

  if (!SENDER_EMAIL || !SENDER_PASSWORD || !GUARDIAN_EMAIL) {
    console.log("📧 [EMAIL SIMULATION]");
    console.log(`   To      : ${GUARDIAN_EMAIL || "guardian@example.com"}`);
    console.log(`   Level   : ${riskLevel}`);
    console.log(`   Explain : ${explanation}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: SENDER_EMAIL, pass: SENDER_PASSWORD },
  });

  const mailOptions = {
    from: `"Elder Care Alert" <${SENDER_EMAIL}>`,
    to: GUARDIAN_EMAIL,
    subject: `🚨 [${riskLevel}] ELDER HEALTH ALERT — Immediate Attention Required`,
    html: `
      <div style="font-family:Arial;border:2px solid ${levelColor};padding:20px;border-radius:8px;">
        <h2 style="color:${levelColor};">🚨 ${riskLevel} Health Alert</h2>
        <p><strong>Risk Score:</strong> ${alertData.riskScore}/100</p>
        <p><strong>Explanation:</strong></p>
        <pre style="background:#f5f5f5;padding:10px;font-size:12px;">${explanation}</pre>
        <hr/>
        <table>
          <tr><td><strong>Temperature</strong></td><td>${alertData.temperature}°C</td></tr>
          <tr><td><strong>Heart Rate</strong></td><td>${alertData.heartRate} bpm</td></tr>
          <tr><td><strong>Hydration</strong></td><td>${alertData.hydration ?? "N/A"}%</td></tr>
          <tr><td><strong>Fall Detected</strong></td><td>${alertData.fallDetected ? "YES ⚠️" : "No"}</td></tr>
          <tr><td><strong>Time</strong></td><td>${alertData.time}</td></tr>
        </table>
        <p style="color:${levelColor};margin-top:15px;"><strong>Please check on the elder immediately.</strong></p>
        <p><a href="${MAPS_LINK}">📍 View Elder Location on Google Maps</a></p>
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

// =====================================================
// 🔔 PUSH NOTIFICATION (ntfy.sh)
// =====================================================

function sendPushNotification(alertData, explanation, riskLevel) {
  const priorityMap = { CRITICAL: "urgent", HIGH: "high", MEDIUM: "default" };
  const tagsMap = {
    CRITICAL : "rotating_light,sos,warning",
    HIGH     : "warning,sos",
    MEDIUM   : "warning",
  };

  const message =
    `[${riskLevel}] Score: ${alertData.riskScore}/100\n` +
    `Temp: ${alertData.temperature}°C | HR: ${alertData.heartRate} bpm | Hydration: ${alertData.hydration ?? "?"}%\n` +
    `${alertData.fallDetected ? "⚠️ FALL DETECTED\n" : ""}` +
    `Location: ${MAPS_LINK}`;

  const body = Buffer.from(message);

  const options = {
    hostname: "ntfy.sh",
    path: `/${NTFY_TOPIC}`,
    method: "POST",
    headers: {
      "Title"         : `ELDER ${riskLevel} ALERT`,
      "Priority"      : priorityMap[riskLevel] || "default",
      "Tags"          : tagsMap[riskLevel] || "warning",
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

// =====================================================
// 📞 VOICE CALL (Twilio)
// =====================================================

const TWILIO_SID   = process.env.TWILIO_SID   || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN  || "";
const TWILIO_FROM  = process.env.TWILIO_FROM   || "";

function makeAlertCall(explanation, riskLevel) {
  const cleanExplanation = explanation
    .replace(/[^\w\s,.!]/g, "")
    .substring(0, 200);

  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !GUARDIAN_PHONE) {
    console.log("📞 [CALL SIMULATION] Voice call would be made to:", GUARDIAN_PHONE || "not set");
    console.log(`   Level  : ${riskLevel}`);
    console.log(`   Message: "Elder ${riskLevel} alert! ${cleanExplanation}"`);
    console.log("   → Set TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM in .env for real calls.");
    return;
  }

  const twiml =
    `<Response>` +
      `<Say voice="alice" language="en-IN">` +
        `This is an elder care ${riskLevel} alert. ` +
        `${cleanExplanation}. ` +
        `Please check on the elder immediately.` +
      `</Say>` +
    `</Response>`;

  const postData = new URLSearchParams({
    To   : GUARDIAN_PHONE,
    From : TWILIO_FROM,
    Twiml: twiml,
  }).toString();

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");

  const options = {
    hostname: "api.twilio.com",
    path    : `/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
    method  : "POST",
    headers : {
      "Authorization" : `Basic ${auth}`,
      "Content-Type"  : "application/x-www-form-urlencoded",
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

// =====================================================
// 🚦 MULTI-STAGE ALERT ESCALATION
// =====================================================

/**
 * Escalation tiers:
 *   LOW      → No alert (log only)
 *   MEDIUM   → Log only (local console)
 *   HIGH     → Push notification only
 *   CRITICAL → Push + Email + Voice call
 */
async function triggerEscalatedAlert(alertData) {
  const { riskLevel, explanation } = alertData;

  if (riskLevel === "LOW") {
    console.log(`✅ LOW risk (score: ${alertData.riskScore}) — no alert needed.`);
    return;
  }

  if (isCooldownActive(riskLevel)) {
    const remaining = cooldownRemainingSeconds(riskLevel);
    console.log(`⏳ [${riskLevel}] Cooldown active — ${remaining}s remaining`);
    return;
  }

  updateCooldown(riskLevel);

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`🚨 RISK LEVEL: ${riskLevel} | Score: ${alertData.riskScore}/100`);
  console.log(`   ${explanation.replace(/\n/g, "\n   ")}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (riskLevel === "MEDIUM") {
    // MEDIUM → log only, no external notifications
    console.log("📋 MEDIUM level — logged locally. No external notifications.");
    return;
  }

  if (riskLevel === "HIGH") {
    // HIGH → push notification only
    console.log("🔔 HIGH level — sending push notification...");
    sendPushNotification(alertData, explanation, riskLevel);
    return;
  }

  if (riskLevel === "CRITICAL") {
    // CRITICAL → push + email + voice call
    console.log("💥 CRITICAL level — sending push + email + voice call...");
    await sendEmailAlert(alertData, explanation, riskLevel);
    sendPushNotification(alertData, explanation, riskLevel);
    makeAlertCall(explanation, riskLevel);
    return;
  }
}

// =====================================================
// 1️⃣  ESP32 HEALTH DATA → /alert
// =====================================================

app.post("/alert", async (req, res) => {
  // NEW: ESP32 sends only RAW data — no risk boolean
  const { temperature, heartRate, hydration, fallDetected } = req.body;

  // Validate required fields
  if (
    temperature   === undefined ||
    heartRate     === undefined ||
    hydration     === undefined ||
    fallDetected  === undefined
  ) {
    return res.status(400).json({
      error: "Invalid payload. Required: temperature, heartRate, hydration, fallDetected",
    });
  }

  // ── Backend computes risk ──────────────────────────────────────────────────
  const { riskScore, riskLevel, explanation, factors } = computeRisk({
    temperature,
    heartRate,
    hydration,
    fallDetected,
  });

  latestAlert = {
    temperature,
    heartRate,
    hydration,
    fallDetected,
    riskScore,
    riskLevel,
    explanation,
    factors,
    time: new Date().toISOString(),
  };

  console.log("\n========== ESP32 RAW DATA (RECEIVED) ==========");
  console.log(`  Temp       : ${temperature}°C`);
  console.log(`  HeartRate  : ${heartRate} bpm`);
  console.log(`  Hydration  : ${hydration}%`);
  console.log(`  Fall       : ${fallDetected}`);
  console.log("========== BACKEND COMPUTED RISK ================");
  console.log(`  Score      : ${riskScore}/100`);
  console.log(`  Level      : ${riskLevel}`);
  console.log(`  Explanation: ${explanation}`);
  console.log("=================================================\n");

  // ── Trigger escalated alerts ───────────────────────────────────────────────
  await triggerEscalatedAlert(latestAlert);

  res.json({
    success     : true,
    riskScore,
    riskLevel,
    explanation,
  });
});

// =====================================================
// 🔍 GET LATEST ALERT DATA
// =====================================================

app.get("/alert", (req, res) => {
  res.json(latestAlert ?? {});
});

// =====================================================
// 🧪 TEST ENDPOINT
// =====================================================

app.get("/test-alert", async (req, res) => {
  const level = (req.query.level || "CRITICAL").toUpperCase();

  const scenarioMap = {
    LOW      : { temperature: 36.8, heartRate: 75, hydration: 70, fallDetected: false },
    MEDIUM   : { temperature: 37.5, heartRate: 112, hydration: 42, fallDetected: false },
    HIGH     : { temperature: 38.2, heartRate: 118, hydration: 32, fallDetected: false },
    CRITICAL : { temperature: 39.2, heartRate: 135, hydration: 20, fallDetected: true  },
  };

  const scenario = scenarioMap[level] || scenarioMap.CRITICAL;
  const { riskScore, riskLevel, explanation, factors } = computeRisk(scenario);

  const fakeAlert = {
    ...scenario,
    riskScore, riskLevel, explanation, factors,
    time: new Date().toISOString(),
  };

  console.log(`\n🧪 TEST ALERT triggered → level: ${riskLevel}`);
  await triggerEscalatedAlert(fakeAlert);

  res.json({
    message  : `Test alert fired for level: ${riskLevel}`,
    ntfyUrl  : `https://ntfy.sh/${NTFY_TOPIC}`,
    mapsLink : MAPS_LINK,
    riskScore,
    riskLevel,
    explanation,
    factors,
  });
});

// =====================================================
// 2️⃣  MEDICINE REMINDER SYSTEM
// =====================================================

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
    hour    : "2-digit",
    minute  : "2-digit",
    hour12  : true,
  });

  const reminder = await Reminder.findOne();

  if (!reminder) {
    return res.json({ serverTime: currentTime, medicineName: "", trigger: false });
  }

  if (reminder.times.includes(currentTime) && reminder.acknowledged === false) {
    return res.json({
      serverTime  : currentTime,
      medicineName: reminder.medicineName,
      trigger     : true,
    });
  }

  res.json({
    serverTime  : currentTime,
    medicineName: reminder.medicineName,
    trigger     : false,
  });
});

// =====================================================
// 3️⃣  ACKNOWLEDGE FROM WATCH
// =====================================================

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

// =====================================================
// 🚀 START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(`\n🚀 Adaptive Risk Evaluation Backend running on port ${PORT}`);
  console.log(`   Guardian phone : ${GUARDIAN_PHONE  || "⚠️  Not set (GUARDIAN_PHONE in .env)"}`);
  console.log(`   Guardian email : ${GUARDIAN_EMAIL  || "⚠️  Not set (GUARDIAN_EMAIL in .env)"}`);
  console.log(`   Sender email   : ${SENDER_EMAIL    || "⚠️  Not set (ALERT_EMAIL_USER in .env)"}`);
  console.log(`   ntfy topic     : ${NTFY_TOPIC}`);
  console.log(`\n   Risk escalation:`);
  console.log(`     LOW      → no alert`);
  console.log(`     MEDIUM   → log only   (cooldown: 5 min)`);
  console.log(`     HIGH     → push only  (cooldown: 3 min)`);
  console.log(`     CRITICAL → push+email+call (cooldown: 1 min)\n`);
});