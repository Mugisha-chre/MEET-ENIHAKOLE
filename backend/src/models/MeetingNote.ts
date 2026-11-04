import mongoose, { type InferSchemaType } from "mongoose";

const meetingNoteSchema = new mongoose.Schema(
  {
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, unique: true, index: true },
    meetingSlug: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120, default: "Meeting notes" },
    contentHtml: { type: String, maxlength: 50000, default: "" },
    revision: { type: Number, min: 0, default: 0 },
    updatedBy: { type: String, required: true, maxlength: 120 },
    updatedByName: { type: String, required: true, maxlength: 80 },
  },
  { timestamps: true, versionKey: false },
);

meetingNoteSchema.index({ meetingSlug: 1, updatedAt: -1 });
export type MeetingNoteDocument = InferSchemaType<typeof meetingNoteSchema> & mongoose.Document;
export const MeetingNote = (mongoose.models.MeetingNote ?? mongoose.model("MeetingNote", meetingNoteSchema)) as mongoose.Model<InferSchemaType<typeof meetingNoteSchema>>;
