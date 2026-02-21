import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import Reminder from "./models/Reminder.js";


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

// ESP32 fetches reminder
app.get("/reminder", async (req, res) => {

  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata"
  });

  const indianTime = new Date(now);

  const currentTime = indianTime.toLocaleString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });

  const reminder = await Reminder.findOne();

  if (!reminder) {
    return res.json({
      serverTime: currentTime,
      medicineName: "",
      trigger: false
    });
  }

  if (
    reminder.times.includes(currentTime) &&
    reminder.acknowledged === false &&
    reminder.lastTriggered !== currentTime
  ) {
    reminder.lastTriggered = currentTime;
    await reminder.save();

    return res.json({
      serverTime: currentTime,
      medicineName: reminder.medicineName,
      trigger: true
    });
  }

  res.json({
    serverTime: currentTime,
    medicineName: reminder.medicineName,
    trigger: false
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
});