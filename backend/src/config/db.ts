import mongoose from "mongoose";

let connectionPromise: Promise<void> | null = null;

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required. Copy backend/.env.example to backend/.env and configure it.");
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState === 0) connectionPromise = null;

  if (!connectionPromise) {
    mongoose.set("strictQuery", true);
    connectionPromise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
      minPoolSize: 0,
    }).then(() => {
      console.info("[database] MongoDB connected");
    }).catch((error: unknown) => {
      connectionPromise = null;
      throw error;
    });
  }

  await connectionPromise;
}
