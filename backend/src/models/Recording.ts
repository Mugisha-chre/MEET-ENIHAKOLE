import mongoose, { type InferSchemaType } from "mongoose";

const recordingSchema = new mongoose.Schema(
  {
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, index: true },
    meetingSlug: { type: String, required: true, index: true },
    meetingTitle: { type: String, required: true, maxlength: 120 },
    hostUserId: { type: String, required: true, index: true },
    hostName: { type: String, required: true, maxlength: 80 },
    participants: {
      type: [{ userId: { type: String, required: true }, displayName: { type: String, required: true, maxlength: 80 }, identity: { type: String, required: true }, isGuest: { type: Boolean, default: false } }],
      default: [],
    },
    consents: {
      type: [{ userId: { type: String, required: true }, identity: { type: String, required: true }, displayName: { type: String, required: true, maxlength: 80 }, decision: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" }, decidedAt: { type: Date, default: null } }],
      default: [],
    },
    status: { type: String, enum: ["consent_pending", "recording", "uploading", "ready", "failed", "declined"], default: "consent_pending", index: true },
    egressId: { type: String, default: "", index: true },
    startRequested: { type: Boolean, default: false },
    stagedKey: { type: String, default: "" },
    stagedAvailable: { type: Boolean, default: false },
    cloudinaryPublicId: { type: String, default: "" },
    cloudinaryAssetId: { type: String, default: "" },
    durationSeconds: { type: Number, default: 0 },
    fileSize: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    uploadAttempts: { type: Number, default: 0 },
    uploadProgressPercent: { type: Number, default: 0, min: 0, max: 100 },
    lastError: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true, versionKey: false },
);

recordingSchema.index({ meeting: 1, createdAt: -1 });
recordingSchema.index({ hostUserId: 1, status: 1, createdAt: -1 });
export type RecordingDocument = InferSchemaType<typeof recordingSchema> & mongoose.Document;
export const Recording = (mongoose.models.Recording ?? mongoose.model("Recording", recordingSchema)) as mongoose.Model<InferSchemaType<typeof recordingSchema>>;
