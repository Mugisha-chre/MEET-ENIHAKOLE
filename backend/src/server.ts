import "dotenv/config";
import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";

const port = Number(process.env.PORT || 4000);
const app = createApp();

// Vercel detects this default-exported Express app and runs it as a Node function.
// On local development and conventional hosts, start a normal HTTP listener instead.
export default app;

async function main(): Promise<void> {
  await connectDB();
  const server = app.listen(port, "0.0.0.0", () => {
    console.info(`[api] MEET ENIHAKOLE listening on port ${port}`);
  });

  const shutdown = (signal: string) => {
    console.info(`[api] ${signal} received; closing server`);
    server.close(() => {
      console.info("[api] server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.env.VERCEL !== "1") {
  void main().catch((error) => {
    console.error("[startup] failed", error);
    process.exit(1);
  });
}
