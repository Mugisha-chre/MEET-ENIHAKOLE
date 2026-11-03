import mongoose, { type InferSchemaType } from "mongoose";

const attendanceSchema = new mongoose.Schema(
  {
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, index: true },
    meetingSlug: { type: String, required: true, index: true },
    participantId: { type: String, required: true, index: true },
    identity: { type: String, required: true, index: true },
    displayName: { type: String, required: true, maxlength: 80 },
    isGuest: { type: Boolean, default: false, index: true },
    joinedAt: { type: Date, required: true, default: Date.now },
    leftAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
attendanceSchema.index({ meeting: 1, identity: 1 }, { unique: true });
attendanceSchema.index({ meetingSlug: 1, joinedAt: -1 });
export type AttendanceDocument = InferSchemaType<typeof attendanceSchema> & mongoose.Document;
export const Attendance = (mongoose.models.Attendance ?? mongoose.model("Attendance", attendanceSchema)) as mongoose.Model<InferSchemaType<typeof attendanceSchema>>;
