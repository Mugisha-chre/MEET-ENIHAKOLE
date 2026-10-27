import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Meeting } from "./models/Meeting.js";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import meetingRoutes from "./routes/meetings.js";

const defaultAppUrl = "http://localhost:5173";
const htmlEscape = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function absoluteAppUrl(path: string): string {
  const base = (process.env.APP_URL || defaultAppUrl).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function sharePageHtml(meeting: {
  title: string;
  description?: string;
  slug: string;
  ownerName?: string;
  startsAt: Date;
  thumbnailUrl?: string;
  visibility?: string;
}): string {
  const title = htmlEscape(meeting.title);
  const descriptionText = meeting.description?.trim() || `Join ${meeting.ownerName || "ENIHAKOLE CHOIR"} for an online prayer or meeting on MEET ENIHAKOLE.`;
  const description = htmlEscape(descriptionText.slice(0, 240));
  const canonical = htmlEscape(`${(process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, "")}/share/${encodeURIComponent(meeting.slug)}`);
  const target = htmlEscape(absoluteAppUrl(`/meeting/${encodeURIComponent(meeting.slug)}`));
  const image = htmlEscape(meeting.thumbnailUrl || absoluteAppUrl("/og-default.png"));
  const start = htmlEscape(new Date(meeting.startsAt).toLocaleString("en-RW", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Africa/Kigali",
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · MEET ENIHAKOLE</title>
  <meta name="description" content="${description}" />
  <meta name="robots" content="${meeting.visibility === "public" ? "index,follow" : "noindex,nofollow"}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="MEET ENIHAKOLE" />
  <meta property="og:title" content="${title} · MEET ENIHAKOLE" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:alt" content="MEET ENIHAKOLE meeting preview" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title} · MEET ENIHAKOLE" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />
  <meta name="theme-color" content="#180e12" />
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#180e12;color:#faf4f0}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 15% 10%,#532032 0,transparent 48%),#180e12}
    main{width:min(100%,620px);padding:clamp(28px,7vw,56px);border:1px solid #50323c;border-radius:28px;background:rgba(36,21,27,.9);box-shadow:0 28px 80px #08050780}
    .brand{font-size:12px;font-weight:800;letter-spacing:.18em;color:#e7c58c;text-transform:uppercase}.brand span{color:#fff}h1{font-size:clamp(30px,7vw,48px);line-height:1.08;letter-spacing:-.04em;margin:28px 0 14px}p{line-height:1.7;color:#d3c4c7}.meta{font-size:13px;color:#b8a5aa;margin:24px 0}.button{display:inline-block;padding:14px 20px;border-radius:14px;text-decoration:none;background:#922344;color:white;font-weight:750}.fine{font-size:12px;color:#9f8c92;margin-top:25px}
  </style>
</head>
<body>
  <main>
    <div class="brand">MEET <span>ENIHAKOLE</span></div>
    <h1>${title}</h1>
    <p>${description}</p>
    <div class="meta">Hosted by ${htmlEscape(meeting.ownerName || "ENIHAKOLE CHOIR")}<br />${start} · Africa/Kigali</div>
    <a class="button" href="${target}">Open meeting details</a>
    <p class="fine">A peaceful place to gather, pray, and rehearse — wherever you are.</p>
  </main>
</body>
</html>`;
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
  app.use(express.json({ limit: "1mb" }));

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

  app.get("/share/:slug", async (req, res) => {
    try {
      const meeting = await Meeting.findOne({ slug: req.params.slug }).lean();
      if (!meeting) {
        res.status(404).type("html").send("<!doctype html><html><title>Meeting not found</title><body><h1>Meeting not found</h1><p>This meeting link may be incorrect or no longer available.</p></body></html>");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.type("html").send(sharePageHtml(meeting));
    } catch (error) {
      console.error("[share] failed", error);
      res.status(500).type("html").send("<!doctype html><html><title>Share preview unavailable</title><body><h1>Preview unavailable</h1><p>Please open the platform and find your meeting again.</p></body></html>");
    }
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
