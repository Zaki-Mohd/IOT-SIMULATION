import mongoose from "mongoose";

const reminderSchema = new mongoose.Schema({
  medicineName: String,
  times: [String],
  acknowledged: {
    type: Boolean,
    default: false
  },
  lastTriggered: {
    type: String,
    default: null
  }
});

export default mongoose.model("Reminder", reminderSchema);