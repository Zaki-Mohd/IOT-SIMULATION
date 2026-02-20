import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let latestAlert = null;
let medicineReminder = null;

/* =====================================================
   1️⃣ ESP32 HEALTH DATA
===================================================== */

// ESP32 → POST continuously
app.post("/alert", (req, res) => {
  const { temperature, heartRate, risk, fall } = req.body;

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
    time: new Date().toISOString(),
  };

  console.log("========== ESP32 DATA ==========");
  console.log(latestAlert);

  if (fall === true) {
    console.log("🚨 FALL DETECTED ALERT 🚨");
  }

  res.json({ success: true });
});

// Frontend → GET latest status
app.get("/alert", (req, res) => {
  res.json(latestAlert ?? {});
});

/* =====================================================
   2️⃣ MEDICINE REMINDER SYSTEM
===================================================== */

// Guardian sets medicine
app.post("/set-medicine", (req, res) => {
  const { medicineName, times } = req.body;

  /*
    times should be array like:
    ["09:00", "14:00", "21:00"]
  */

  if (!medicineName || !Array.isArray(times)) {
    return res.status(400).json({ error: "Invalid medicine data" });
  }

  medicineReminder = {
    medicineName,
    times,
    lastTriggered: null
  };

  console.log("💊 Medicine Reminder Set:");
  console.log(medicineReminder);

  res.json({ success: true });
});

// ESP32 fetches reminder
// ESP32 fetches reminder
app.get("/reminder", (req, res) => {

  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

  if (!medicineReminder) {
    return res.json({
      serverTime: currentTime,
      medicineName: "",
      trigger: false
    });
  }

  let shouldTrigger = false;

  if (
    medicineReminder.times.includes(currentTime) &&
    medicineReminder.lastTriggered !== currentTime
  ) {
    shouldTrigger = true;
    medicineReminder.lastTriggered = currentTime;
  }

  res.json({
    serverTime: currentTime,   // 👈 important addition
    medicineName: medicineReminder.medicineName,
    trigger: shouldTrigger
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});