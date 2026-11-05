import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import meetingRoutes from "./routes/meetings.js";
import recordingRoutes from "./routes/recordings.js";
import adminRoutes from "./routes/admin.js";
import analyticsRoutes from "./routes/analytics.js";
import webhookRoutes from "./routes/webhooks.js";
import { PlatformEvent } from "./models/PlatformEvent.js";
import { runRecordingRetentionSweep } from "./lib/recordingRetention.js";

const defaultAppUrl = process.env.NODE_ENV === "production" ? "https://meet-enihakole.vercel.app" : "http://localhost:5173";
function getFrontendBaseUrl(): string {
  for (const candidate of [process.env.FRONTEND_APP_URL, process.env.APP_URL]) {
    if (!candidate?.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) && process.env.NODE_ENV === "production") continue;
      if (url.hostname.endsWith(".onrender.com")) continue;
      return url.origin;
    } catch { /* Ignore invalid values and use the next configured frontend URL. */ }
  }
  return defaultAppUrl;
}
function absoluteAppUrl(path: string): string {
  const base = getFrontendBaseUrl();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}


export function createApp(): Express {
  const app = express();
  app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);

  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        imgSrc: ["'self'", "https:", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));

  const origins = (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin.replace(/\/$/, ""))) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS."));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  // LiveKit webhook signatures cover the raw body, so parse this content type before JSON.
  app.use(express.raw({ type: "application/webhook+json", limit: "2mb" }));
  app.use(express.json({ limit: "12mb" }));

  // Supports both a long-running Node process and serverless Express deployments.
  // MongoDB connections are cached per warm process to avoid reconnecting on every request.
  app.use(async (req, _res, next) => {
    if (req.path === "/health") return next();
    try {
      await connectDB();
      next();
    } catch (error) {
      next(error);
    }
  });

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 240,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // LiveKit webhooks are independently authenticated by their signed JWT;
    // a busy room must not exhaust the browser API quota and drop lifecycle events.
    skip: (req) => req.path.startsWith("/webhooks/"),
    message: { error: "Too many requests. Please wait a moment and try again." },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please try again later." },
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "MEET ENIHAKOLE API", timestamp: new Date().toISOString() });
  });

  // Backward compatibility for old Render share links: send visitors to the SPA on Vercel.
  app.get("/share/:slug", (req, res) => {
    res.redirect(302, absoluteAppUrl(`/share/${encodeURIComponent(req.params.slug)}`));
  });

  // Persist actual API traffic metadata. Do not store query strings, payloads, cookies, IPs, or credentials.
  app.use("/api", (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (req.path === "/webhooks/livekit") return;
      const requestPath = (req.path || "/").split("?")[0] ?? "/";
      void PlatformEvent.create({ category: "traffic", action: "api_request", path: requestPath.slice(0, 300), method: req.method, statusCode: res.statusCode, durationMs: Date.now() - started }).catch(() => undefined);
    });
    next();
  });

  app.use("/api", apiLimiter);
  app.use("/api/auth/google", authLimiter);

  // Optional external scheduler endpoint. Use a long random secret in Render
  // and send it as a Bearer token; never put it in the URL/query string.
  app.post("/api/maintenance/recording-retention", async (req: Request, res: Response) => {
    const expected = process.env.RECORDING_RETENTION_CRON_SECRET?.trim() || "";
    const supplied = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (!expected || expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
      return res.status(401).json({ error: "Unauthorized maintenance request." });
    }
    try {
      await runRecordingRetentionSweep();
      return res.json({ success: true, completedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[recording-retention] external sweep failed", error instanceof Error ? error.message : error);
      return res.status(503).json({ error: "Recording retention cleanup did not complete." });
    }
  });
  app.use("/api/webhooks", webhookRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/recordings", recordingRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/meetings", meetingRoutes);

  app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error.message.includes("CORS")) {
      res.status(403).json({ error: "This website is not allowed to access the API." });
      return;
    }
    console.error("[api] unhandled error", error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });
  return app;
}
