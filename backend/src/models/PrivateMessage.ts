import mongoose, { type InferSchemaType } from "mongoose";

const privateMessageSchema = new mongoose.Schema(
  {
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, index: true },
    meetingSlug: { type: String, required: true, index: true },
    senderUserId: { type: String, required: true, index: true },
    recipientUserId: { type: String, required: true, index: true },
    senderIdentity: { type: String, required: true },
    recipientIdentity: { type: String, default: "" },
    senderName: { type: String, required: true, maxlength: 80 },
    recipientName: { type: String, required: true, maxlength: 80 },
    message: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

privateMessageSchema.index({ meeting: 1, senderUserId: 1, recipientUserId: 1, createdAt: 1 });
privateMessageSchema.index({ meeting: 1, recipientUserId: 1, senderUserId: 1, createdAt: 1 });

export type PrivateMessageDocument = InferSchemaType<typeof privateMessageSchema> & mongoose.Document;
export const PrivateMessage = (mongoose.models.PrivateMessage ?? mongoose.model("PrivateMessage", privateMessageSchema)) as mongoose.Model<InferSchemaType<typeof privateMessageSchema>>;
