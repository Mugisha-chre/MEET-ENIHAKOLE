import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import meetingRoutes from "./routes/meetings.js";

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
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
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

  app.use("/api", apiLimiter);
  app.use("/api/auth/register", authLimiter);
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth", authRoutes);
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
