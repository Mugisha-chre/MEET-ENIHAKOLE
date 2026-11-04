import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { User } from "../models/User.js";
import { isAllowlistedSystemAdminEmail, optionalAuth, requireAuth, requireRegisteredAuth, signAccessToken } from "../middleware/auth.js";
import { UserSession } from "../models/UserSession.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import crypto from "node:crypto";

const router = Router();
const googleSchema = z.object({ credential: z.string().min(20).max(4096) });
let googleClient: OAuth2Client | null = null;

function publicUser(user: { _id: unknown; displayName: string; email: string; picture?: string | null; platformRole?: string; canCreateMeetings?: boolean }) {
  const isAdmin = user.platformRole === "system_admin" && isAllowlistedSystemAdminEmail(user.email);
  return { id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "", isAdmin, canCreateMeetings: Boolean(user.canCreateMeetings || isAdmin) };
}

function systemAdminEmails(): Set<string> { return new Set((process.env.SYSTEM_ADMIN_EMAILS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)); }

function safePicture(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || value.length > 600) return "";
    // Google serves avatars at the size in the URL suffix (=s96-c by default); request a large copy so photos look sharp on big screens.
    if (/^lh\d*\.googleusercontent\.com$/i.test(url.hostname)) {
      const sized = url.toString().replace(/=[sw]\d+(-[a-z0-9-]+)?$/i, "=s400-c");
      return sized.length <= 600 ? sized : url.toString();
    }
    return url.toString();
  } catch { return ""; }
}

router.post("/google", async (req, res) => {
  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Google sign-in did not return a valid credential." });
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return res.status(503).json({ error: "Google sign-in is not configured. Add GOOGLE_CLIENT_ID to the API environment." });

  try {
    googleClient ??= new OAuth2Client(clientId);
    const ticket = await googleClient.verifyIdToken({ idToken: parsed.data.credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ error: "Your Google account email could not be verified." });
    }
    const email = payload.email.trim().toLowerCase();
    const name = (payload.name || payload.given_name || email.split("@")[0] || "Choir guest").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 80);
    const displayName = name.length >= 2 ? name : (email.split("@")[0] ?? "guest").padEnd(2, "_").slice(0, 80);
    const picture = safePicture(payload.picture);

    // Match by Google id first, then by email so accounts created before Google sign-in keep their meetings.
    let user = await User.findOne({ googleId: payload.sub });
    if (!user) user = await User.findOne({ email });
    if (user) {
      user.googleId = payload.sub;
      user.displayName = displayName;
      user.picture = picture;
      user.platformRole = systemAdminEmails().has(email) ? "system_admin" : "member";
      if (user.accountStatus === "suspended") return res.status(403).json({ error: "This account has been suspended. Contact the platform administrator." });
      await user.save();
    } else {
      user = await User.create({ googleId: payload.sub, email, displayName, picture, platformRole: systemAdminEmails().has(email) ? "system_admin" : "member" });
    }
    const profile = publicUser(user);
    const sessionId = crypto.randomUUID();
    await UserSession.create({ sessionId, user: user._id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000), userAgent: String(req.headers["user-agent"] || "").slice(0, 300) });
    const token = signAccessToken({ userId: profile.id, email: profile.email, displayName: profile.displayName, picture: profile.picture, platformRole: user.platformRole === "system_admin" ? "system_admin" : "member", sessionId }, sessionId);
    void PlatformEvent.create({ category: "auth", action: "google_login", actorId: profile.id, actorName: profile.displayName, path: "/api/auth/google" }).catch(() => undefined);
    return res.json({ token, user: profile });
  } catch (error) {
    console.error("[auth/google] failed", error instanceof Error ? error.message : error);
    return res.status(401).json({ error: "Google sign-in could not be verified. Please try again." });
  }
});

router.get("/me", optionalAuth, requireRegisteredAuth, requireAuth, async (req, res) => {
  const user = await User.findById(req.auth!.userId).select("displayName email picture platformRole canCreateMeetings").lean();
  if (!user) return res.status(401).json({ error: "Your account is no longer available." });
  const isAdmin = user.platformRole === "system_admin" && isAllowlistedSystemAdminEmail(user.email);
  return res.json({ user: { id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "", isAdmin, canCreateMeetings: Boolean(user.canCreateMeetings || isAdmin) } });
});

router.post("/session-heartbeat", optionalAuth, requireRegisteredAuth, requireAuth, async (req, res) => {
  if (req.auth!.sessionId) await UserSession.updateOne({ sessionId: req.auth!.sessionId, user: req.auth!.userId, revokedAt: null }, { $set: { lastSeenAt: new Date() } });
  return res.json({ success: true });
});

router.post("/logout", optionalAuth, async (req, res) => {
  if (req.auth?.sessionId) await UserSession.updateOne({ sessionId: req.auth.sessionId }, { $set: { revokedAt: new Date() } });
  return res.json({ success: true });
});

export default router;
