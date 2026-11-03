import mongoose, { type InferSchemaType } from "mongoose";

const userSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: false, versionKey: false },
);
userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type UserSessionDocument = InferSchemaType<typeof userSessionSchema> & mongoose.Document;
export const UserSession = (mongoose.models.UserSession ?? mongoose.model("UserSession", userSessionSchema)) as mongoose.Model<InferSchemaType<typeof userSessionSchema>>;
