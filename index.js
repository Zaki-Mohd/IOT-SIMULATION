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

app.get("/alert", (req, res) => {
  res.json(latestAlert ?? {});
});

/* =====================================================
   2️⃣ MEDICINE REMINDER SYSTEM
===================================================== */

// Guardian sets medicine
app.post("/set-medicine", (req, res) => {
  const { medicineName, times } = req.body;

  if (!medicineName || !Array.isArray(times)) {
    return res.status(400).json({ error: "Invalid medicine data" });
  }

  medicineReminder = {
    medicineName,
    times,
    lastTriggered: null,
    acknowledged: false
  };

  console.log("💊 Medicine Reminder Set:");
  console.log(medicineReminder);

  res.json({ success: true });
});

// ESP32 fetches reminder
app.get("/reminder", (req, res) => {

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTime = now.toTimeString().slice(0, 5);

  if (!medicineReminder) {
    return res.json({
      serverTime: currentTime,
      medicineName: "",
      trigger: false
    });
  }

  for (let t of medicineReminder.times) {

    const [h, m] = t.split(":").map(Number);
    const reminderMinutes = h * 60 + m;

    if (currentMinutes >= reminderMinutes &&
        medicineReminder.acknowledged === false) {

      return res.json({
        serverTime: currentTime,
        medicineName: medicineReminder.medicineName,
        trigger: true
      });
    }
  }

  res.json({
    serverTime: currentTime,
    medicineName: medicineReminder.medicineName,
    trigger: false
  });
});

/* =====================================================
   3️⃣ ACKNOWLEDGE FROM WATCH
===================================================== */

app.post("/acknowledge", (req, res) => {

  if (!medicineReminder) {
    return res.status(400).json({ error: "No reminder set" });
  }

  medicineReminder.acknowledged = true;

  console.log("✅ Medicine Acknowledged by Watch");

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});