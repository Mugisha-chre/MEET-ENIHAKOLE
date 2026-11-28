import mongoose, { type InferSchemaType } from "mongoose";

const emailVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  codeHash: { type: String, required: true },
  firstName: { type: String, required: true, maxlength: 40 },
  lastName: { type: String, required: true, maxlength: 40 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  attempts: { type: Number, default: 0 },
  sentAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false });

emailVerificationSchema.index({ email: 1 }, { unique: true });
export type EmailVerificationDocument = InferSchemaType<typeof emailVerificationSchema> & mongoose.Document;
export const EmailVerification = (mongoose.models.EmailVerification ?? mongoose.model("EmailVerification", emailVerificationSchema)) as mongoose.Model<InferSchemaType<typeof emailVerificationSchema>>;
