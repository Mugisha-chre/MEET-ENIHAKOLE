import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { optionalAuth, requireAuth, signAccessToken } from "../middleware/auth.js";

const router = Router();
const bcryptPassword = z.string().min(8).max(128).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 72,
  "For security, the password must be no more than 72 UTF-8 bytes.",
);
const registerSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: bcryptPassword,
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "The password is too long.",
  ),
});

function publicUser(user: { _id: unknown; displayName: string; email: string }) {
  return { id: String(user._id), displayName: user.displayName, email: user.email };
}

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check your details." });

  try {
    const exists = await User.exists({ email: parsed.data.email });
    if (exists) return res.status(409).json({ error: "An account with this email already exists." });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await User.create({
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      passwordHash,
    });
    const profile = publicUser(user);
    const token = signAccessToken({ userId: profile.id, email: profile.email, displayName: profile.displayName });
    return res.status(201).json({ token, user: profile });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    console.error("[auth/register] failed", error);
    return res.status(500).json({ error: "Could not create your account right now." });
  }
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password." });

  try {
    const user = await User.findOne({ email: parsed.data.email }).select("+passwordHash displayName email");
    const valid = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
    if (!user || !valid) return res.status(401).json({ error: "Email or password is incorrect." });

    const profile = publicUser(user);
    const token = signAccessToken({ userId: profile.id, email: profile.email, displayName: profile.displayName });
    return res.json({ token, user: profile });
  } catch (error) {
    console.error("[auth/login] failed", error);
    return res.status(500).json({ error: "Could not sign you in right now." });
  }
});

router.get("/me", optionalAuth, requireAuth, async (req, res) => {
  return res.json({ user: { id: req.auth!.userId, displayName: req.auth!.displayName, email: req.auth!.email } });
});

export default router;
