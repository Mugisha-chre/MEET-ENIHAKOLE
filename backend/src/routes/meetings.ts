import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Meeting } from "../models/Meeting.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { closeLiveKitRoom, createJoinToken, getLiveKitUrl, isLiveKitConfigured } from "../lib/livekit.js";

const router = Router();
router.use(optionalAuth);

const createMeetingSchema = z.object({
  title: z.string().trim().min(3, "Give your meeting a title of at least 3 characters.").max(120),
  description: z.string().trim().max(1000).optional().default(""),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.coerce.number().int().min(15).max(240).default(60),
  timezone: z.string().trim().min(1).max(80).default("Africa/Kigali"),
  visibility: z.enum(["link", "public"]).default("link"),
  thumbnailUrl: z.string().trim().max(2000).optional().default(""),
});
const joinSchema = z.object({ displayName: z.string().trim().min(2).max(80).optional() });

function slugFromTitle(title: string): string {
  const prefix = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "choir-meeting";
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function publicMeeting(meeting: any, currentUserId?: string) {
  return {
    id: String(meeting._id),
    slug: meeting.slug,
    title: meeting.title,
    description: meeting.description || "",
    ownerName: meeting.ownerName,
    ownerId: String(meeting.owner),
    isOwner: Boolean(currentUserId && String(meeting.owner) === currentUserId),
    startsAt: new Date(meeting.startsAt).toISOString(),
    durationMinutes: meeting.durationMinutes,
    timezone: meeting.timezone,
    visibility: meeting.visibility,
    thumbnailUrl: meeting.thumbnailUrl || "",
    status: meeting.status,
    startedAt: meeting.startedAt ? new Date(meeting.startedAt).toISOString() : null,
    endedAt: meeting.endedAt ? new Date(meeting.endedAt).toISOString() : null,
    createdAt: new Date(meeting.createdAt).toISOString(),
  };
}

function shareUrl(slug: string): string {
  const base = (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, "");
  return `${base}/share/${encodeURIComponent(slug)}`;
}

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const meetings = await Meeting.find({ owner: req.auth!.userId })
      .sort({ startsAt: -1 })
      .limit(40)
      .lean();
    return res.json({ meetings: meetings.map((meeting) => publicMeeting(meeting, req.auth!.userId)) });
  } catch (error) {
    console.error("[meetings/mine] failed", error);
    return res.status(500).json({ error: "Could not load your meetings." });
  }
});

router.get("/public", async (_req, res) => {
  try {
    const meetings = await Meeting.find({ visibility: "public", status: { $in: ["scheduled", "live"] } })
      .sort({ startsAt: 1 })
      .limit(20)
      .lean();
    return res.json({ meetings: meetings.map((meeting) => publicMeeting(meeting)) });
  } catch (error) {
    console.error("[meetings/public] failed", error);
    return res.status(500).json({ error: "Could not load public meetings." });
  }
});

router.post("/thumbnail-signature", requireAuth, (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET?.trim();
  if (!cloudName || !apiKey || !apiSecret || !uploadPreset) {
    return res.status(503).json({ error: "Meeting image uploads are not configured yet. The administrator must configure Cloudinary credentials and a signed image-upload preset." });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  // Keep destination, allowed formats, and size restrictions in a signed Cloudinary preset.
  // The preset should allow only JPG, PNG, and WebP and have an 8 MB maximum file size.
  const parameters = { timestamp: String(timestamp), upload_preset: uploadPreset };
  const stringToSign = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&") + apiSecret;
  const signature = crypto.createHash("sha1").update(stringToSign).digest("hex");

  return res.json({ cloudName, apiKey, timestamp, uploadPreset, signature });
});

router.post("/", requireAuth, async (req, res) => {
  const parsed = createMeetingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the meeting details." });

  const startsAt = new Date(parsed.data.startsAt);
  if (!Number.isFinite(startsAt.getTime())) return res.status(400).json({ error: "Choose a valid start date and time." });
  const maxDuration = Number(process.env.MEETING_MAX_DURATION_MINUTES || 240);
  if (parsed.data.durationMinutes > maxDuration) {
    return res.status(400).json({ error: `Meetings can be up to ${maxDuration} minutes long.` });
  }

  const rawThumbnail = parsed.data.thumbnailUrl.trim();
  let normalizedThumbnail = "";
  if (rawThumbnail) {
    try {
      const url = new URL(rawThumbnail);
      if (url.protocol !== "https:") return res.status(400).json({ error: "The thumbnail image URL must use HTTPS." });
      normalizedThumbnail = url.toString();
    } catch {
      return res.status(400).json({ error: "Enter a valid thumbnail image URL." });
    }
  }

  try {
    const meeting = await Meeting.create({
      ...parsed.data,
      startsAt,
      thumbnailUrl: normalizedThumbnail,
      slug: slugFromTitle(parsed.data.title),
      owner: req.auth!.userId,
      ownerName: req.auth!.displayName,
      status: "scheduled",
    });
    return res.status(201).json({ meeting: publicMeeting(meeting, req.auth!.userId), shareUrl: shareUrl(meeting.slug) });
  } catch (error) {
    console.error("[meetings/create] failed", error);
    return res.status(500).json({ error: "Could not schedule this meeting." });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).lean();
    if (!meeting) return res.status(404).json({ error: "We could not find this meeting. Check the shared link." });
    return res.json({ meeting: publicMeeting(meeting, req.auth?.userId) });
  } catch (error) {
    console.error("[meetings/get] failed", error);
    return res.status(500).json({ error: "Could not load this meeting." });
  }
});

router.post("/:slug/token", async (req, res) => {
  const parsed = joinSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Enter your name to join." });
  if (!isLiveKitConfigured()) {
    return res.status(503).json({ error: "Video calling is not configured yet. The administrator must add the LiveKit credentials to the API environment." });
  }

  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "We could not find this meeting." });
    if (meeting.status === "ended" || meeting.status === "cancelled") {
      return res.status(410).json({ error: "This meeting has ended or was cancelled." });
    }

    const isHost = Boolean(req.auth && String(meeting.owner) === req.auth.userId);
    const now = new Date();

    // Close stale meetings for hosts and guests alike. Do not rely on a browser timer
    // to enforce the meeting's lifetime because browsers and free hosts can sleep.
    if (
      meeting.status === "live" &&
      meeting.startedAt &&
      now.getTime() > meeting.startedAt.getTime() + meeting.durationMinutes * 60_000 + 30 * 60_000
    ) {
      meeting.status = "ended";
      meeting.endedAt = now;
      await meeting.save();
      await closeLiveKitRoom(`eni-${meeting.slug}`);
      return res.status(410).json({ error: "This meeting has reached its scheduled end time." });
    }

    if (!isHost) {
      if (meeting.status !== "live") {
        const openAt = new Date(meeting.startsAt.getTime() - 15 * 60_000);
        if (now < openAt) return res.status(409).json({ error: "This meeting has not opened yet. You can join 15 minutes before it starts." });
        return res.status(409).json({ error: "The host has not started this meeting yet. Keep this page open and try again shortly." });
      }
    } else if (meeting.status === "scheduled") {
      meeting.status = "live";
      meeting.startedAt = now;
      await meeting.save();
    }

    const displayName = isHost
      ? req.auth!.displayName
      : (parsed.data.displayName || req.auth?.displayName || "Choir guest").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 80);
    if (displayName.length < 2) return res.status(400).json({ error: "Enter a name with at least 2 characters." });

    const token = await createJoinToken({
      roomName: `eni-${meeting.slug}`,
      displayName,
      userId: req.auth?.userId,
      role: isHost ? "host" : "participant",
      ttlSeconds: meeting.startedAt
        ? Math.max(60, Math.min(
            4 * 60 * 60,
            Math.ceil((meeting.startedAt.getTime() + meeting.durationMinutes * 60_000 + 30 * 60_000 - now.getTime()) / 1000),
          ))
        : 4 * 60 * 60,
    });
    return res.json({
      token,
      serverUrl: getLiveKitUrl(),
      role: isHost ? "host" : "participant",
      meeting: publicMeeting(meeting, req.auth?.userId),
    });
  } catch (error) {
    console.error("[meetings/token] failed", error);
    return res.status(500).json({ error: "Could not prepare the conference connection." });
  }
});

router.post("/:slug/end", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId) return res.status(403).json({ error: "Only the meeting host can end it for everyone." });
    if (meeting.status !== "ended" && meeting.status !== "cancelled") {
      meeting.status = "ended";
      meeting.endedAt = new Date();
      await meeting.save();
    }
    await closeLiveKitRoom(`eni-${meeting.slug}`);
    return res.json({ meeting: publicMeeting(meeting, req.auth!.userId) });
  } catch (error) {
    console.error("[meetings/end] failed", error);
    return res.status(500).json({ error: "Could not end the meeting cleanly." });
  }
});

router.post("/:slug/cancel", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId) return res.status(403).json({ error: "Only the meeting host can cancel it." });
    if (meeting.status !== "scheduled") return res.status(409).json({ error: "Only a scheduled meeting can be cancelled." });
    meeting.status = "cancelled";
    meeting.endedAt = new Date();
    await meeting.save();
    return res.json({ meeting: publicMeeting(meeting, req.auth!.userId) });
  } catch (error) {
    console.error("[meetings/cancel] failed", error);
    return res.status(500).json({ error: "Could not cancel this meeting." });
  }
});

export default router;
