import { Router } from "express";
import rateLimit from "express-rate-limit";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { User } from "../models/User.js";
import { isAllowlistedSystemAdminEmail, optionalAuth, requireAuth, requireRegisteredAuth, signAccessToken } from "../middleware/auth.js";
import { UserSession } from "../models/UserSession.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { EmailVerification } from "../models/EmailVerification.js";
import crypto from "node:crypto";

const router = Router();
// Email verification is independently rate-limited even when the optional
// global API limits are disabled for large choir gatherings.
const emailCodeRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many verification requests. Please try again later." }),
});
const emailCodeVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many verification attempts. Please try again later." }),
});
const googleSchema = z.object({ credential: z.string().min(20).max(4096) });

const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(40),
  lastName: z.string().trim().min(1).max(40),
});
const profilePictureSchema = z.object({ dataUrl: z.string().max(12 * 1024 * 1024).regex(/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/i) });
let googleClient: OAuth2Client | null = null;

const emailRequestSchema = z.object({
  firstName: z.string().trim().min(1).max(40).regex(/^[^<>\u0000-\u001f]+$/),
  lastName: z.string().trim().min(1).max(40).regex(/^[^<>\u0000-\u001f]+$/),
  email: z.string().trim().email().max(254),
});
const emailVerifySchema = emailRequestSchema.extend({ code: z.string().trim().regex(/^\d{6}$/) });
function emailCodeHash(email: string, code: string): string {
  const secret = process.env.EMAIL_CODE_SECRET?.trim() || process.env.JWT_SECRET?.trim() || "";
  if (secret.length < 32) throw new Error("EMAIL_CODE_SECRET or a 32-character JWT_SECRET must be configured.");
  return crypto.createHmac("sha256", secret).update(`${email.toLowerCase()}:${code}`).digest("hex");
}
async function deliverEmailCode(email: string, firstName: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new Error("Email registration is not configured. Add RESEND_API_KEY and EMAIL_FROM to the backend environment.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your MEET ENIHAKOLE verification code",
      html: `<div style="font-family:Arial,sans-serif;color:#3b2630;max-width:520px;margin:auto;padding:28px"><h2 style="color:#8f2141">Welcome to MEET ENIHAKOLE</h2><p>Hello ${firstName.replace(/[&<>"']/g, "")},</p><p>Use this code to verify your email and finish creating your account:</p><p style="font-size:30px;font-weight:700;letter-spacing:8px;padding:18px;background:#f8eff0;border-radius:12px;text-align:center">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(data.message || "The verification email could not be delivered.");
  }
}
async function issueEmailSession(user: any, req: any) {
  const profile = publicUser(user);
  const sessionId = crypto.randomUUID();
  await UserSession.create({ sessionId, user: user._id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000), userAgent: String(req.headers["user-agent"] || "").slice(0, 300) });
  const token = signAccessToken({ userId: profile.id, email: profile.email, displayName: profile.displayName, picture: profile.picture, platformRole: user.platformRole === "system_admin" ? "system_admin" : "member", sessionId }, sessionId);
  return { token, user: profile };
}


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


router.post("/register/request-code", emailCodeRequestLimiter, async (req, res) => {
  const parsed = emailRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid first name, last name, and email address." });
  const email = parsed.data.email.toLowerCase();
  try {
    const existing = await User.findOne({ email }).select("accountStatus").lean();
    if (existing?.accountStatus === "suspended") return res.status(403).json({ error: "This account has been suspended. Contact the platform administrator." });
    const recent = await EmailVerification.findOne({ email }).select("sentAt").lean();
    if (recent?.sentAt && Date.now() - new Date(recent.sentAt).getTime() < 45_000) return res.status(429).json({ error: "A code was sent recently. Check your inbox before requesting another." });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = emailCodeHash(email, code);
    await EmailVerification.findOneAndUpdate({ email }, { $set: { email, codeHash, firstName: parsed.data.firstName, lastName: parsed.data.lastName, expiresAt: new Date(Date.now() + 10 * 60_000), attempts: 0, sentAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await deliverEmailCode(email, parsed.data.firstName, code);
    return res.json({ success: true, expiresInSeconds: 600, message: "A six-digit verification code has been sent to your email." });
  } catch (error) {
    console.error("[auth/register/request-code] failed", error instanceof Error ? error.message : error);
    return res.status(503).json({ error: error instanceof Error ? error.message : "Could not send your verification code. Please try again." });
  }
});

router.post("/register/verify-code", emailCodeVerifyLimiter, async (req, res) => {
  const parsed = emailVerifySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Enter the email address, names, and six-digit code." });
  const email = parsed.data.email.toLowerCase();
  try {
    const challenge = await EmailVerification.findOne({ email, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } });
    if (!challenge) return res.status(400).json({ error: "This verification code expired or is no longer valid. Request a new code." });
    const expected = Buffer.from(challenge.codeHash, "hex");
    const supplied = Buffer.from(emailCodeHash(email, parsed.data.code), "hex");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      challenge.attempts += 1;
      await challenge.save();
      return res.status(401).json({ error: "That verification code is incorrect. Check the email and try again." });
    }
    let user = await User.findOne({ email });
    if (user?.accountStatus === "suspended") return res.status(403).json({ error: "This account has been suspended. Contact the platform administrator." });
    if (!user) {
      const displayName = `${parsed.data.firstName} ${parsed.data.lastName}`.replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      user = await User.create({ email, displayName, picture: "", platformRole: systemAdminEmails().has(email) ? "system_admin" : "member" });
    }
    await EmailVerification.deleteOne({ _id: challenge._id });
    const result = await issueEmailSession(user, req);
    void PlatformEvent.create({ category: "auth", action: "email_verified_login", actorId: result.user.id, actorName: result.user.displayName, path: "/api/auth/register/verify-code" }).catch(() => undefined);
    return res.json(result);
  } catch (error) {
    console.error("[auth/register/verify-code] failed", error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "Could not verify your account. Please try again." });
  }
});

router.post("/google", async (req, res) => {
  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Google login did not return a valid credential." });
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return res.status(503).json({ error: "Google login is not configured. Add GOOGLE_CLIENT_ID to the API environment." });

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

    // Match by Google id first, then by email so accounts created before Google login keep their meetings.
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
    return res.status(401).json({ error: "Google login could not be verified. Please try again." });
  }
});

router.get("/me", optionalAuth, requireRegisteredAuth, requireAuth, async (req, res) => {
  const user = await User.findById(req.auth!.userId).select("displayName email picture platformRole canCreateMeetings").lean();
  if (!user) return res.status(401).json({ error: "Your account is no longer available." });
  const isAdmin = user.platformRole === "system_admin" && isAllowlistedSystemAdminEmail(user.email);
  return res.json({ user: { id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "", isAdmin, canCreateMeetings: Boolean(user.canCreateMeetings || isAdmin) } });
});


router.patch("/profile", requireRegisteredAuth, requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Enter your first and last name." });
  const displayName = `${parsed.data.firstName} ${parsed.data.lastName}`.replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  try {
    const user = await User.findByIdAndUpdate(req.auth!.userId, { $set: { displayName } }, { new: true, runValidators: true }).select("displayName email picture platformRole canCreateMeetings");
    if (!user) return res.status(404).json({ error: "Your account is no longer available." });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth/profile] failed", error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "Could not update your profile." });
  }
});

router.post("/profile-picture", requireRegisteredAuth, requireAuth, async (req, res) => {
  const parsed = profilePictureSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid JPG, PNG, or WebP profile photo." });
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return res.status(503).json({ error: "Profile photo uploads are not configured on the server." });
  const dataUrl = parsed.data.dataUrl;
  const bytes = Buffer.from(dataUrl.split(",", 2)[1] || "", "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return res.status(413).json({ error: "The profile photo must be 8 MB or smaller." });
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = { folder: "meet-enihakole/profile-photos", timestamp: String(timestamp), transformation: "c_thumb,g_face,w_512,h_512,q_auto,f_auto" };
    const signature = crypto.createHash("sha1").update(Object.entries(signed).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&") + apiSecret).digest("hex");
    const form = new FormData();
    form.append("file", dataUrl); form.append("api_key", apiKey); form.append("signature", signature);
    for (const [key, value] of Object.entries(signed)) form.append(key, value);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    const result = await response.json().catch(() => ({})) as { secure_url?: string; error?: { message?: string } };
    if (!response.ok || !result.secure_url) return res.status(502).json({ error: result.error?.message || "Cloudinary could not upload this profile photo." });
    const user = await User.findByIdAndUpdate(req.auth!.userId, { $set: { picture: result.secure_url } }, { new: true }).select("displayName email picture platformRole canCreateMeetings");
    if (!user) return res.status(404).json({ error: "Your account is no longer available." });
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth/profile-picture] failed", error instanceof Error ? error.message : error);
    return res.status(502).json({ error: "Could not reach Cloudinary. Please try again." });
  }
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
