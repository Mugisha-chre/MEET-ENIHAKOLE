import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

export interface AuthPayload {
  userId: string;
  email: string;
  displayName: string;
  picture?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  return secret;
}

export function signAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload, jwtSecret(), { subject: payload.userId, expiresIn: "7d", issuer: "meet-enihakole" });
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return next();

  try {
    const decoded = jwt.verify(raw.slice(7), jwtSecret(), { issuer: "meet-enihakole" });
    if (typeof decoded === "object" && decoded !== null && typeof decoded.sub === "string") {
      const user = await User.findById(decoded.sub).select("displayName email picture").lean();
      if (user) {
        req.auth = {
          userId: String(user._id),
          email: user.email,
          displayName: user.displayName,
          picture: user.picture || "",
        };
      }
    }
  } catch {
    // Invalid/expired optional tokens are treated as anonymous, not as a server error.
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
}
