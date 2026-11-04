import mongoose, { type InferSchemaType } from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    slug: { type: String, required: true, unique: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ownerName: { type: String, required: true, trim: true, maxlength: 80 },
    startsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, required: true, min: 15, max: 240, default: 60 },
    timezone: { type: String, trim: true, maxlength: 80, default: "Africa/Kigali" },
    meetingType: { type: String, enum: ["meeting", "prayer"], default: "meeting", index: true },
    visibility: { type: String, enum: ["link", "public"], default: "link" },
    thumbnailUrl: { type: String, trim: true, maxlength: 2000, default: "" },
    status: { type: String, enum: ["scheduled", "live", "ended", "cancelled"], default: "scheduled", index: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    bannedUserIds: { type: [String], default: [] },
    bannedGuestIds: { type: [String], default: [] },
    recordingStatus: { type: String, enum: ["idle", "consent_pending", "recording", "uploading", "ready", "failed", "declined"], default: "idle", index: true },
    activeRecordingId: { type: mongoose.Schema.Types.ObjectId, ref: "Recording", default: null },
    participantAccounts: {
      type: [{ userId: { type: String, required: true }, displayName: { type: String, required: true, maxlength: 80 }, picture: { type: String, default: "", maxlength: 2000 }, isGuest: { type: Boolean, default: false }, guestId: { type: String, default: "" } }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

meetingSchema.index({ owner: 1, startsAt: -1 });
meetingSchema.index({ meetingType: 1, status: 1, startsAt: 1 });
meetingSchema.index({ visibility: 1, status: 1, startsAt: 1 });

export type MeetingDocument = InferSchemaType<typeof meetingSchema> & mongoose.Document;
export const Meeting = (mongoose.models.Meeting ?? mongoose.model("Meeting", meetingSchema)) as mongoose.Model<InferSchemaType<typeof meetingSchema>>;
