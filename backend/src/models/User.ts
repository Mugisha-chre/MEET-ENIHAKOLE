import mongoose, { type InferSchemaType } from "mongoose";

const userSchema = new mongoose.Schema(
  {
    displayName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, unique: true, index: true },
    passwordHash: { type: String, select: false },
    googleId: { type: String, trim: true, maxlength: 80, unique: true, sparse: true, index: true },
    picture: { type: String, trim: true, maxlength: 600, default: "" },
  },
  { timestamps: true, versionKey: false },
);

export type UserDocument = InferSchemaType<typeof userSchema> & mongoose.Document;
export const User = (mongoose.models.User ?? mongoose.model("User", userSchema)) as mongoose.Model<InferSchemaType<typeof userSchema>>;
