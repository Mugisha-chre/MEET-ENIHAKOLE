import mongoose, { type InferSchemaType } from "mongoose";

const verseSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 64 },
  reference: { type: String, required: true, trim: true, maxlength: 120 },
  text: { type: String, required: true, trim: true, maxlength: 4000 },
  createdBy: { type: String, required: true, maxlength: 100 },
  createdByName: { type: String, required: true, maxlength: 80 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });
const presenterSchema = new mongoose.Schema({
  userId: { type: String, required: true, maxlength: 100 },
  email: { type: String, required: true, maxlength: 254 },
  displayName: { type: String, required: true, maxlength: 80 },
}, { _id: false });
const meetingBibleSchema = new mongoose.Schema({
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, unique: true, index: true },
  meetingSlug: { type: String, required: true, unique: true, index: true },
  verses: { type: [verseSchema], default: [] },
  presenters: { type: [presenterSchema], default: [] },
  activeVerseId: { type: String, default: null },
  updatedBy: { type: String, default: "" },
}, { timestamps: true, versionKey: false });

export type MeetingBibleDocument = InferSchemaType<typeof meetingBibleSchema> & mongoose.Document;
export const MeetingBible = (mongoose.models.MeetingBible ?? mongoose.model("MeetingBible", meetingBibleSchema)) as mongoose.Model<InferSchemaType<typeof meetingBibleSchema>>;
