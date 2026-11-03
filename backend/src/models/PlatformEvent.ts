import mongoose, { type InferSchemaType } from "mongoose";

const platformEventSchema = new mongoose.Schema(
  {
    category: { type: String, enum: ["traffic", "page_view", "auth", "meeting", "recording", "admin", "system"], required: true, index: true },
    action: { type: String, required: true, maxlength: 100, index: true },
    actorId: { type: String, default: "", index: true },
    actorName: { type: String, default: "", maxlength: 80 },
    meetingSlug: { type: String, default: "", index: true },
    path: { type: String, default: "", maxlength: 300 },
    method: { type: String, default: "", maxlength: 12 },
    statusCode: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
platformEventSchema.index({ createdAt: -1 });
export type PlatformEventDocument = InferSchemaType<typeof platformEventSchema> & mongoose.Document;
export const PlatformEvent = (mongoose.models.PlatformEvent ?? mongoose.model("PlatformEvent", platformEventSchema)) as mongoose.Model<InferSchemaType<typeof platformEventSchema>>;
