import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { User } from "../models/User.js";
import { optionalAuth, requireAuth, signAccessToken } from "../middleware/auth.js";

const router = Router();
const googleSchema = z.object({ credential: z.string().min(20).max(4096) });
let googleClient: OAuth2Client | null = null;

function publicUser(user: { _id: unknown; displayName: string; email: string; picture?: string | null }) {
  return { id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "" };
}

function safePicture(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && value.length <= 600 ? url.toString() : "";
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
    if (!payload?.sub || !payload.email || payload.email_verified === false) {
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
      await user.save();
    } else {
      user = await User.create({ googleId: payload.sub, email, displayName, picture });
    }
    const profile = publicUser(user);
    const token = signAccessToken({ userId: profile.id, email: profile.email, displayName: profile.displayName, picture: profile.picture });
    return res.json({ token, user: profile });
  } catch (error) {
    console.error("[auth/google] failed", error instanceof Error ? error.message : error);
    return res.status(401).json({ error: "Google sign-in could not be verified. Please try again." });
  }
});

router.get("/me", optionalAuth, requireAuth, async (req, res) => {
  return res.json({ user: { id: req.auth!.userId, displayName: req.auth!.displayName, email: req.auth!.email, picture: req.auth!.picture || "" } });
});

export default router;
