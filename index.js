import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let latestAlert = null;

// ESP32 → POSTs continuously
app.post("/alert", (req, res) => {
  const { temperature, heartRate, risk } = req.body;

  // Basic validation (non-breaking)
  if (
    temperature === undefined ||
    heartRate === undefined ||
    risk === undefined
  ) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  latestAlert = {
    temperature,
    heartRate,
    risk, // "HIGH" or "NORMAL"
    time: new Date().toISOString(),
  };

  console.log("ESP32 DATA:", latestAlert);
  res.json({ success: true });
});

// Frontend → GET latest status
app.get("/alert", (req, res) => {
  res.json(latestAlert ?? {});
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
