import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";

export interface AuthPayload {
  userId: string;
  email: string;
  displayName: string;
  picture?: string;
  platformRole?: "member" | "system_admin";
  canCreateMeetings?: boolean;
  isGuest?: boolean;
  guestId?: string;
  meetingSlug?: string;
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request { auth?: AuthPayload; }
  }
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  return secret;
}

export function signAccessToken(payload: AuthPayload, sessionId?: string): string {
  return jwt.sign({ ...payload, sid: sessionId }, jwtSecret(), { subject: payload.userId, expiresIn: "7d", issuer: "meet-enihakole" });
}

export function signGuestAccessToken(input: { guestId: string; displayName: string; meetingSlug: string }): string {
  return jwt.sign({ guest: true, guestId: input.guestId, meetingSlug: input.meetingSlug, displayName: input.displayName, email: "", picture: "", platformRole: "member" }, jwtSecret(), {
    subject: `guest:${input.guestId}`, expiresIn: "24h", issuer: "meet-enihakole",
  });
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return next();

  try {
    const decoded = jwt.verify(raw.slice(7), jwtSecret(), { issuer: "meet-enihakole" });
    if (typeof decoded !== "object" || decoded === null || typeof decoded.sub !== "string") return next();
    const claims = decoded as jwt.JwtPayload & { guest?: boolean; guestId?: string; meetingSlug?: string; displayName?: string; picture?: string; sid?: string };
    if (claims.guest === true && typeof claims.guestId === "string" && typeof claims.meetingSlug === "string") {
      req.auth = {
        userId: `guest:${claims.guestId}`,
        guestId: claims.guestId,
        meetingSlug: claims.meetingSlug,
        isGuest: true,
        email: "",
        displayName: String(claims.displayName || "Guest").slice(0, 80),
        picture: "",
        platformRole: "member",
      };
      return next();
    }
    if (claims.sid && typeof claims.sid === "string") {
      const session = await UserSession.findOne({ sessionId: claims.sid, revokedAt: null, expiresAt: { $gt: new Date() } }).select("sessionId").lean();
      if (!session) return next();
    }
    const user = await User.findById(decoded.sub).select("displayName email picture platformRole accountStatus canCreateMeetings").lean();
    if (user && user.accountStatus !== "suspended") {
      req.auth = {
        userId: String(user._id),
        email: user.email,
        displayName: user.displayName,
        picture: user.picture || "",
        platformRole: user.platformRole === "system_admin" && isAllowlistedSystemAdminEmail(user.email) ? "system_admin" : "member",
        canCreateMeetings: Boolean(user.canCreateMeetings),
        sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
      };
    }
  } catch {
    // Invalid/expired optional tokens are treated as anonymous, not as a server error.
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) { res.status(401).json({ error: "Sign in to continue." }); return; }
  next();
}

export function requireRegisteredAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.isGuest) { res.status(401).json({ error: "A Google account is required for this action." }); return; }
  next();
}

export function isAllowlistedSystemAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return (process.env.SYSTEM_ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export function requireSystemAdmin(req: Request, res: Response, next: NextFunction): void {
  if (
    !req.auth || req.auth.isGuest || req.auth.platformRole !== "system_admin" ||
    !req.auth.email || !isAllowlistedSystemAdminEmail(req.auth.email)
  ) {
    res.status(403).json({ error: "System administrator access is required." });
    return;
  }
  next();
}
