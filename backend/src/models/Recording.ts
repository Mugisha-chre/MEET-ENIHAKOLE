import mongoose, { type InferSchemaType } from "mongoose";
import { notifyRecordingsChanged } from "../lib/realtime.js";

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
    uploadLeaseId: { type: String, default: "", index: true },
    uploadLeaseUntil: { type: Date, default: null, index: true },
    nextUploadAttemptAt: { type: Date, default: null, index: true },
    uploadProgressPercent: { type: Number, default: 0, min: 0, max: 100 },
    lastError: { type: String, default: "", maxlength: 1000 },
    // Expiry is anchored to recording completion (UTC), not upload completion.
    // Legacy rows are backfilled from endedAt, startedAt, then createdAt.
    expiresAt: { type: Date, default: null, index: true },
    deletionStatus: { type: String, enum: ["active", "deleting", "delete_failed"], default: "active", index: true },
    deletionAttempts: { type: Number, default: 0 },
    nextDeletionAttemptAt: { type: Date, default: null, index: true },
    deletionLeaseUntil: { type: Date, default: null },
    lastDeletionError: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true, versionKey: false },
);

// Any real change to a recording (new, status, ready, expired, deleted) pings connected browsers so the Recordings page updates by itself.
// Upload progress, lease and retry bookkeeping are skipped so the page is not refetched on every progress tick.
const QUIET_RECORDING_FIELDS = new Set(["uploadProgressPercent", "uploadLeaseUntil", "uploadLeaseId", "uploadAttempts", "nextUploadAttemptAt", "lastError", "stagedAvailable", "deletionLeaseUntil", "deletionAttempts", "nextDeletionAttemptAt", "lastDeletionError", "updatedAt"]);
function onlyQuietFields(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const keys: string[] = [];
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (key.startsWith("$") && value && typeof value === "object") keys.push(...Object.keys(value as Record<string, unknown>));
    else if (!key.startsWith("$")) keys.push(key);
  }
  return keys.length > 0 && keys.every((key) => QUIET_RECORDING_FIELDS.has(key));
}
recordingSchema.post("save", () => notifyRecordingsChanged());
for (const hook of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
  recordingSchema.post(hook, function (this: any) {
    try { if (onlyQuietFields(this.getUpdate?.())) return; } catch { /* Notify on any doubt. */ }
    notifyRecordingsChanged();
  });
}
for (const hook of ["deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  recordingSchema.post(hook, () => notifyRecordingsChanged());
}

recordingSchema.index({ meeting: 1, createdAt: -1 });
recordingSchema.index({ hostUserId: 1, status: 1, createdAt: -1 });
recordingSchema.index({ status: 1, deletionStatus: 1, expiresAt: 1, nextDeletionAttemptAt: 1 });
recordingSchema.index({ status: 1, stagedAvailable: 1, uploadLeaseUntil: 1, nextUploadAttemptAt: 1 });
export type RecordingDocument = InferSchemaType<typeof recordingSchema> & mongoose.Document;
export const Recording = (mongoose.models.Recording ?? mongoose.model("Recording", recordingSchema)) as mongoose.Model<InferSchemaType<typeof recordingSchema>>;
