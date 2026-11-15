import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";

let io: Server | null = null;
let timer: NodeJS.Timeout | null = null;

function allowedOrigins(): string[] {
  return (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** Starts the realtime channel on the long-running HTTP server (not available on serverless hosts). */
export function startRealtime(server: HttpServer): void {
  if (io) return;
  const origins = allowedOrigins();
  io = new Server(server, {
    path: "/socket.io",
    serveClient: false,
    cors: {
      origin(origin, callback) {
        if (!origin || origins.includes(origin.replace(/\/$/, ""))) return callback(null, true);
        return callback(new Error("Origin is not allowed by CORS."));
      },
      methods: ["GET", "POST"],
    },
  });
}

/** Tells every connected browser that the recordings list changed. Bursts are merged into one event. */
export function notifyRecordingsChanged(): void {
  if (!io || timer) return;
  timer = setTimeout(() => {
    timer = null;
    io?.emit("recordings:changed", { at: Date.now() });
  }, 400);
  timer.unref?.();
}
