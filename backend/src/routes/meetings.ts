import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Meeting } from "../models/Meeting.js";
import { PrivateMessage } from "../models/PrivateMessage.js";
import { Recording } from "../models/Recording.js";
import { Attendance } from "../models/Attendance.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { optionalAuth, requireAuth, requireRegisteredAuth, signGuestAccessToken } from "../middleware/auth.js";
import { expireStaleMeetingsThrottled } from "../lib/expiry.js";
import { closeLiveKitRoom, createJoinToken, getLiveKitUrl, isLiveKitConfigured, listRoomPeople, moderateLiveKitParticipant } from "../lib/livekit.js";
import { isRecordingConfigured, startRoomRecording, stopRoomRecording, uploadCompletedRecording } from "../lib/recordings.js";

const router = Router();
router.use(optionalAuth);
// Every request first lets the server close meetings whose time is over (throttled), so lists and links are never stale.
router.use(async (_req, _res, next) => { await expireStaleMeetingsThrottled(); next(); });

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
const guestSchema = z.object({ displayName: z.string().trim().min(3).max(80) });
const recordingConsentSchema = z.object({ recordingId: z.string().min(1).max(64), identity: z.string().trim().min(1).max(200), accepted: z.boolean() });
const moderationSchema = z.object({
  identity: z.string().trim().min(1).max(200),
  action: z.enum(["mute-mic", "disable-camera", "remove", "ban", "request-unmute", "request-camera"]),
});
const privateMessageSchema = z.object({
  recipientUserId: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(2000),
});

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
  // Invitations must be opened on the frontend domain; never emit the Render API origin as a share URL.
  let base = process.env.NODE_ENV === "production" ? "https://meet-enihakole.vercel.app" : "http://localhost:5173";
  for (const candidate of [process.env.FRONTEND_APP_URL, process.env.APP_URL]) {
    if (!candidate?.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.hostname.endsWith(".onrender.com")) continue;
      if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) && process.env.NODE_ENV === "production") continue;
      base = url.origin;
      break;
    } catch { /* Try the next configured frontend URL. */ }
  }
  return `${base}/share/${encodeURIComponent(slug)}`;
}

router.get("/mine", requireRegisteredAuth, requireAuth, async (req, res) => {
  try {
    const meetings = await Meeting.find({ owner: req.auth!.userId })
      .sort({ startsAt: -1 })
      .limit(200)
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
      .limit(200)
      .lean();
    return res.json({ meetings: meetings.map((meeting) => publicMeeting(meeting)) });
  } catch (error) {
    console.error("[meetings/public] failed", error);
    return res.status(500).json({ error: "Could not load public meetings." });
  }
});

router.post("/thumbnail-upload", requireRegisteredAuth, requireAuth, async (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(503).json({ error: "Meeting image uploads are not configured. Add the Cloudinary cloud name, API key, and API secret to Render." });
  }

  const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
  const match = dataUrl.match(/^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return res.status(400).json({ error: "Choose a valid JPG, PNG, or WebP cover image." });
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: "The optimized cover image must be 8 MB or smaller." });
  }

  try {
    // Signed uploads only need cloud name + API key/secret. The upload preset is optional:
    // if one is configured but does not exist in Cloudinary ("Upload preset not found"),
    // we transparently retry as a plain signed upload so uploads always work.
    const sendToCloudinary = async (preset?: string) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signedParameters: Record<string, string> = { folder: "meet-enihakole/meeting-covers", timestamp: String(timestamp) };
      if (preset) signedParameters.upload_preset = preset;
      const stringToSign = Object.entries(signedParameters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&") + apiSecret;
      const signature = crypto.createHash("sha1").update(stringToSign).digest("hex");
      const formData = new FormData();
      formData.append("file", dataUrl);
      formData.append("api_key", apiKey);
      formData.append("signature", signature);
      for (const [key, value] of Object.entries(signedParameters)) formData.append(key, value);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json().catch(() => ({})) as { secure_url?: string; public_id?: string; error?: { message?: string } };
      return { response, result };
    };

    let { response, result } = await sendToCloudinary(uploadPreset || undefined);
    if (uploadPreset && !result.secure_url && /preset/i.test(result.error?.message || "")) {
      console.warn("[meetings/thumbnail-upload] Upload preset unavailable, retrying as plain signed upload:", result.error?.message);
      ({ response, result } = await sendToCloudinary());
    }
    if (!response.ok || !result.secure_url) {
      console.error("[meetings/thumbnail-upload] Cloudinary rejected upload", response.status, result.error?.message || "Unknown Cloudinary error");
      return res.status(502).json({
        error: result.error?.message || "Cloudinary could not accept this cover image. Check the Cloudinary cloud name, API key, and API secret on the server.",
      });
    }
    return res.status(201).json({ secureUrl: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error("[meetings/thumbnail-upload] request failed", error instanceof Error ? error.message : "unknown error");
    return res.status(502).json({ error: "Could not reach Cloudinary from the API server. Check the Render outbound connection and Cloudinary configuration." });
  }
});


router.post("/", requireRegisteredAuth, requireAuth, async (req, res) => {
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
    void PlatformEvent.create({ category: "meeting", action: "meeting_created", actorId: req.auth!.userId, actorName: req.auth!.displayName, meetingSlug: meeting.slug, detail: { visibility: meeting.visibility, durationMinutes: meeting.durationMinutes } }).catch(() => undefined);
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

router.post("/:slug/guest-session", async (req, res) => {
  const parsed = guestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Enter your first and last name to continue as a guest." });
  const displayName = parsed.data.displayName.replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (displayName.split(" ").filter(Boolean).length < 2) return res.status(400).json({ error: "Please enter both your first and last name." });
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("slug status bannedGuestIds").lean();
    if (!meeting) return res.status(404).json({ error: "We could not find this meeting." });
    if (["ended", "cancelled"].includes(meeting.status)) return res.status(410).json({ error: "This meeting has ended or was cancelled." });
    const guestId = req.auth?.isGuest && req.auth.meetingSlug === req.params.slug && req.auth.guestId ? req.auth.guestId : crypto.randomUUID();
    if ((meeting.bannedGuestIds || []).includes(guestId)) return res.status(403).json({ error: "This guest identity has been blocked from rejoining this meeting." });
    const token = signGuestAccessToken({ guestId, displayName, meetingSlug: req.params.slug });
    void PlatformEvent.create({ category: "auth", action: "guest_access_created", actorId: `guest:${guestId}`, actorName: displayName, meetingSlug: req.params.slug }).catch(() => undefined);
    return res.json({ token, guestId, displayName, isGuest: true });
  } catch (error) {
    console.error("[meetings/guest-session] failed", error);
    return res.status(500).json({ error: "Could not prepare your guest session." });
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
    if (!req.auth) return res.status(401).json({ error: "Continue with Google or choose Continue as Guest to join this meeting." });
    if (req.auth.isGuest && req.auth.meetingSlug !== req.params.slug) return res.status(403).json({ error: "This temporary guest session belongs to a different meeting." });
    if (!isHost && req.auth.isGuest && (meeting.bannedGuestIds || []).includes(req.auth.guestId || "")) return res.status(403).json({ error: "This guest identity has been blocked from rejoining this meeting." });
    if (!isHost && !req.auth.isGuest && (meeting.bannedUserIds || []).includes(req.auth.userId)) {
      return res.status(403).json({ error: "The host has blocked your account from rejoining this meeting." });
    }
    if (meeting.activeRecordingId) {
      const activeRecording = await Recording.findById(meeting.activeRecordingId).select("status consents participants").lean();
      if (["consent_pending", "recording"].includes(activeRecording?.status || "")) {
        const consented = activeRecording?.consents?.some((entry: any) => entry.userId === req.auth!.userId && entry.decision === "accepted");
        if (!consented) return res.status(409).json({ error: "The host has requested recording consent. Ask the host to stop the request or wait until the active recording ends before joining." });
      }
    }
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
      void PlatformEvent.create({ category: "meeting", action: "meeting_started", actorId: req.auth!.userId, actorName: req.auth!.displayName, meetingSlug: meeting.slug }).catch(() => undefined);
    }

    const displayName = (req.auth.displayName || "Choir guest").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 80);
    if (displayName.length < 2) return res.status(400).json({ error: "Enter a name with at least 2 characters." });

    // Keep a minimal account directory for this meeting so private messages can
    // be queued for people who briefly disconnect and delivered on their return.
    const picture = !req.auth!.isGuest && typeof req.auth!.picture === "string" && req.auth!.picture.startsWith("https://") ? req.auth!.picture.slice(0, 2000) : "";
    const accountFilter = { _id: meeting._id, "participantAccounts.userId": req.auth!.userId };
    const updatedAccount = await Meeting.updateOne(accountFilter, {
      $set: { "participantAccounts.$.displayName": displayName, "participantAccounts.$.picture": picture },
    });
    if (!updatedAccount.matchedCount) {
      // The user-id predicate makes first-time inserts safe for simultaneous joins.
      await Meeting.updateOne(
        { _id: meeting._id, "participantAccounts.userId": { $ne: req.auth!.userId } },
        { $push: { participantAccounts: { userId: req.auth!.userId, displayName, picture, isGuest: Boolean(req.auth!.isGuest), guestId: req.auth!.guestId || "" } } },
      );
    }

    const token = await createJoinToken({
      roomName: `eni-${meeting.slug}`,
      displayName,
      userId: req.auth?.userId,
      picture,
      role: isHost ? "host" : "participant",
      ttlSeconds: meeting.startedAt
        ? Math.max(60, Math.min(
            4 * 60 * 60,
            Math.ceil((meeting.startedAt.getTime() + meeting.durationMinutes * 60_000 + 30 * 60_000 - now.getTime()) / 1000),
          ))
        : 4 * 60 * 60,
    });
    const participants = await listRoomPeople(`eni-${meeting.slug}`);
    return res.json({
      token,
      participants,
      serverUrl: getLiveKitUrl(),
      role: isHost ? "host" : "participant",
      meeting: publicMeeting(meeting, req.auth?.userId),
    });
  } catch (error) {
    console.error("[meetings/token] failed", error);
    return res.status(500).json({ error: "Could not prepare the conference connection." });
  }
});


router.post("/:slug/participant-profile", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id slug owner status bannedUserIds bannedGuestIds");
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const isHost = String(meeting.owner) === req.auth!.userId;
    if (req.auth!.isGuest && req.auth!.meetingSlug !== req.params.slug) return res.status(403).json({ error: "This guest session belongs to another meeting." });
    if (!isHost && req.auth!.isGuest && (meeting.bannedGuestIds || []).includes(req.auth!.guestId || "")) return res.status(403).json({ error: "This guest identity has been blocked from this meeting." });
    if (!isHost && !req.auth!.isGuest && (meeting.bannedUserIds || []).includes(req.auth!.userId)) return res.status(403).json({ error: "The host has blocked your account from this meeting." });
    if (meeting.status !== "live") return res.status(409).json({ error: "This meeting is not live." });
    const identityFromClient = typeof req.body?.identity === "string" ? req.body.identity.trim().slice(0, 200) : "";
    const roomPeople = await listRoomPeople(`eni-${meeting.slug}`);
    const participant = roomPeople.find((person) => identityFromClient ? person.identity === identityFromClient && person.userId === req.auth!.userId : person.userId === req.auth!.userId);
    if (!participant) return res.status(409).json({ error: "Your connection is still being registered. Please retry shortly." });
    const identity = participant.identity;
    const displayName = (req.auth!.displayName || participant.name || "Participant").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 80);
    const picture = !req.auth!.isGuest && typeof req.auth!.picture === "string" && req.auth!.picture.startsWith("https://") ? req.auth!.picture.slice(0, 2000) : "";
    const updated = await Meeting.updateOne({ _id: meeting._id, "participantAccounts.userId": req.auth!.userId }, {
      $set: { "participantAccounts.$.displayName": displayName, "participantAccounts.$.picture": picture },
    });
    if (!updated.matchedCount) {
      await Meeting.updateOne({ _id: meeting._id, "participantAccounts.userId": { $ne: req.auth!.userId } }, {
        $push: { participantAccounts: { userId: req.auth!.userId, displayName, picture, isGuest: Boolean(req.auth!.isGuest), guestId: req.auth!.guestId || "" } },
      });
    }
    await Attendance.updateOne({ meeting: meeting._id, identity }, {
      $set: { meetingSlug: meeting.slug, participantId: req.auth!.userId, identity, displayName, isGuest: Boolean(req.auth!.isGuest), leftAt: null, durationSeconds: 0 },
      $setOnInsert: { joinedAt: new Date() },
    }, { upsert: true });
    return res.json({ success: true });
  } catch (error) {
    console.error("[meetings/participant-profile] failed", error);
    return res.status(500).json({ error: "Could not register your meeting profile." });
  }
});

router.post("/:slug/participant-leave", requireAuth, async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim().slice(0, 200) : "";
  if (!identity) return res.status(400).json({ error: "A meeting connection identity is required." });
  try {
    if (req.auth!.isGuest && req.auth!.meetingSlug !== req.params.slug) return res.status(403).json({ error: "This guest session belongs to another meeting." });
    const attendance = await Attendance.findOne({ meetingSlug: req.params.slug, identity, participantId: req.auth!.userId });
    if (attendance && !attendance.leftAt) {
      attendance.leftAt = new Date();
      attendance.durationSeconds = Math.max(0, Math.round((attendance.leftAt.getTime() - attendance.joinedAt.getTime()) / 1000));
      await attendance.save();
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("[meetings/participant-leave] failed", error);
    return res.status(500).json({ error: "Could not close this attendance session." });
  }
});

router.post("/:slug/moderation", requireAuth, async (req, res) => {
  const parsed = moderationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid participant moderation action." });
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId) return res.status(403).json({ error: "Only the meeting host can manage participants." });
    const { identity, action } = parsed.data;
    const people = await listRoomPeople(`eni-${meeting.slug}`);
    const target = people.find((person) => person.identity === identity);
    if (!target) return res.status(404).json({ error: "That participant is no longer connected." });
    if (target.role === "host" || target.userId === req.auth!.userId) return res.status(403).json({ error: "The host cannot moderate their own connection." });

    if (action === "ban") {
      if (!target.userId) return res.status(409).json({ error: "This participant's identity could not be verified, so re-entry cannot be blocked reliably." });
      if (target.userId.startsWith("guest:")) {
        const guestId = target.userId.slice(6);
        if (!(meeting.bannedGuestIds || []).includes(guestId)) meeting.bannedGuestIds.push(guestId);
      } else if (!(meeting.bannedUserIds || []).includes(target.userId)) meeting.bannedUserIds.push(target.userId);
      await meeting.save();
      const sameAccountSessions = people.filter((person) => person.userId === target.userId);
      const removals = await Promise.allSettled(sameAccountSessions.map((person) => moderateLiveKitParticipant(`eni-${meeting.slug}`, person.identity, "remove")));
      const removedSessions = removals.filter((result) => result.status === "fulfilled" && result.value.found).length;
      const removalIncomplete = removedSessions < sameAccountSessions.length;
      return res.json({
        success: true, action, removedSessions,
        message: removalIncomplete
          ? "The account is blocked from rejoining, but one or more active connections could not be removed automatically."
          : "Participant removed and blocked from rejoining.",
      });
    }

    if (action === "request-unmute" || action === "request-camera") {
      return res.json({ success: true, action, message: "Permission request is ready to send to the participant." });
    }
    const result = await moderateLiveKitParticipant(`eni-${meeting.slug}`, identity, action);
    if (!result.found) return res.status(404).json({ error: "That participant is no longer connected." });
    return res.json({ success: true, action, message: action === "remove" ? "Participant removed." : "Participant media updated." });
  } catch (error) {
    console.error("[meetings/moderation] failed", error);
    return res.status(500).json({ error: "Could not apply that moderation action." });
  }
});

router.get("/:slug/private-conversations", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id participantAccounts").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const participantAccounts = (meeting as unknown as { participantAccounts?: Array<{ userId: string; displayName: string; picture?: string }> }).participantAccounts || [];
    const meetingUsers = participantAccounts.map((person) => person.userId);
    if (!meetingUsers.includes(req.auth!.userId)) return res.status(403).json({ error: "Join this meeting before opening private conversations." });
    const accountById = new Map<string, { userId: string; displayName: string; picture?: string }>();
    participantAccounts.forEach((person) => accountById.set(person.userId, person));
    const messages = await PrivateMessage.find({
      meeting: meeting._id,
      $or: [{ senderUserId: req.auth!.userId }, { recipientUserId: req.auth!.userId }],
    }).sort({ createdAt: -1 }).limit(300).lean();
    const conversations = new Map<string, { userId: string; name: string; picture: string; lastMessage: string; createdAt: string }>();
    for (const item of messages) {
      const otherUserId = item.senderUserId === req.auth!.userId ? item.recipientUserId : item.senderUserId;
      if (conversations.has(otherUserId)) continue;
      const account = accountById.get(otherUserId);
      conversations.set(otherUserId, {
        userId: otherUserId,
        name: item.senderUserId === req.auth!.userId ? item.recipientName : item.senderName,
        picture: account?.picture || "",
        lastMessage: item.message,
        createdAt: new Date(item.createdAt).toISOString(),
      });
    }
    return res.json({ conversations: [...conversations.values()] });
  } catch (error) {
    console.error("[meetings/private-conversations] failed", error);
    return res.status(500).json({ error: "Could not load your private conversations." });
  }
});

router.get("/:slug/private-messages/:otherUserId", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id slug participantAccounts").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const otherUserId = String(req.params.otherUserId || "").trim();
    if (!otherUserId || otherUserId === req.auth!.userId) return res.status(400).json({ error: "Choose another participant." });
    const meetingUsers = (meeting.participantAccounts || []).map((person) => person.userId);
    if (!meetingUsers.includes(req.auth!.userId) || !meetingUsers.includes(otherUserId)) return res.status(403).json({ error: "Private conversations are available only between people who joined this meeting." });
    const messages = await PrivateMessage.find({
      meeting: meeting._id,
      $or: [
        { senderUserId: req.auth!.userId, recipientUserId: otherUserId },
        { senderUserId: otherUserId, recipientUserId: req.auth!.userId },
      ],
    }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ messages: messages.reverse().map((item) => ({
      id: String(item._id), senderUserId: item.senderUserId, recipientUserId: item.recipientUserId,
      senderIdentity: item.senderIdentity, recipientIdentity: item.recipientIdentity || "",
      senderName: item.senderName, recipientName: item.recipientName,
      message: item.message, createdAt: new Date(item.createdAt).toISOString(),
    })) });
  } catch (error) {
    console.error("[meetings/private-messages:get] failed", error);
    return res.status(500).json({ error: "Could not load this private conversation." });
  }
});

router.post("/:slug/private-messages", requireAuth, async (req, res) => {
  const parsed = privateMessageSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Write a message of up to 2,000 characters." });
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id slug status participantAccounts bannedUserIds").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (meeting.status !== "live") return res.status(409).json({ error: "Private messages are available while the meeting is live." });
    if (parsed.data.recipientUserId === req.auth!.userId) return res.status(400).json({ error: "You cannot message yourself." });
    const people = await listRoomPeople(`eni-${meeting.slug}`);
    const sender = people.find((person) => person.userId === req.auth!.userId);
    const recipientSessions = people.filter((person) => person.userId === parsed.data.recipientUserId);
    const recipient = recipientSessions[0];
    const recipientAccount = (meeting.participantAccounts || []).find((person) => person.userId === parsed.data.recipientUserId);
    if (!sender) return res.status(403).json({ error: "Join the meeting before sending a private message." });
    if (!recipientAccount) return res.status(404).json({ error: "That person has not joined this meeting." });
    if ((meeting.bannedUserIds || []).includes(parsed.data.recipientUserId)) return res.status(403).json({ error: "This participant is no longer available in the meeting." });

    const created = await PrivateMessage.create({
      meeting: meeting._id,
      meetingSlug: meeting.slug,
      senderUserId: req.auth!.userId,
      recipientUserId: parsed.data.recipientUserId,
      senderIdentity: sender.identity,
      recipientIdentity: recipient?.identity || "",
      senderName: sender.name || "Participant",
      recipientName: recipient?.name || recipientAccount.displayName || "Participant",
      message: parsed.data.message,
    });
    return res.status(201).json({ message: {
      id: String(created._id), senderUserId: created.senderUserId, recipientUserId: created.recipientUserId,
      senderIdentity: created.senderIdentity, recipientIdentity: created.recipientIdentity,
      senderName: created.senderName, recipientName: created.recipientName,
      message: created.message, createdAt: new Date(created.createdAt).toISOString(),
      recipientOnline: recipientSessions.length > 0, recipientIdentities: recipientSessions.map((person) => person.identity),
    } });
  } catch (error) {
    console.error("[meetings/private-messages:post] failed", error);
    return res.status(500).json({ error: "Could not send that private message." });
  }
});

router.post("/:slug/end", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId) return res.status(403).json({ error: "Only the meeting host can end it for everyone." });
    if (meeting.activeRecordingId) {
      const recording = await Recording.findById(meeting.activeRecordingId);
      if (recording?.status === "recording") await stopRoomRecording(String(recording._id));
      else if (recording?.status === "consent_pending") {
        recording.status = "declined";
        recording.lastError = "The meeting ended before recording consent was complete.";
        await recording.save();
        meeting.recordingStatus = "declined";
      }
    }
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


router.get("/:slug/recording/status", requireAuth, async (req, res) => {
  try {
    if (req.auth!.isGuest && req.auth!.meetingSlug !== req.params.slug) return res.status(403).json({ error: "This guest session belongs to another meeting." });
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id slug owner activeRecordingId recordingStatus").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const recording = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId).lean() : null;
    if (!recording) return res.json({ recording: null, meetingStatus: meeting.recordingStatus || "idle" });
    const isMember = String(meeting.owner) === req.auth!.userId || recording.participants.some((person: any) => person.userId === req.auth!.userId);
    if (!isMember) return res.status(403).json({ error: "You are not a participant in this meeting." });
    return res.json({ recording: {
      id: String(recording._id), status: recording.status, hostName: recording.hostName,
      consents: recording.consents.map((entry: any) => ({ displayName: entry.displayName, identity: entry.identity, decision: entry.decision })),
      myDecision: recording.consents.find((entry: any) => entry.userId === req.auth!.userId && entry.identity === String(req.query.identity || ""))?.decision || "none",
      startedAt: recording.startedAt, endedAt: recording.endedAt, uploadProgressPercent: recording.uploadProgressPercent || 0,
      lastError: recording.status === "failed" ? recording.lastError : "", canRetry: Boolean(recording.stagedAvailable),
    }, meetingStatus: meeting.recordingStatus || "idle" });
  } catch (error) {
    console.error("[recording/status] failed", error);
    return res.status(500).json({ error: "Could not load recording status." });
  }
});

router.post("/:slug/recording/start", requireAuth, async (req, res) => {
  if (!isRecordingConfigured()) return res.status(503).json({ error: "Room recording is not configured. The administrator must configure LiveKit Egress, a private S3-compatible staging bucket, Cloudinary, and the public webhook URL." });
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId || req.auth!.isGuest) return res.status(403).json({ error: "Only the registered meeting host can start recording." });
    if (meeting.status !== "live") return res.status(409).json({ error: "Start the meeting before recording it." });
    const current = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId) : null;
    if (current && ["consent_pending", "recording", "uploading"].includes(current.status)) return res.status(409).json({ error: "A recording is already active for this meeting." });
    const people = await listRoomPeople(`eni-${meeting.slug}`);
    if (!people.length || !people.some((person) => person.userId === req.auth!.userId)) return res.status(409).json({ error: "Connect to the meeting before starting its recording." });
    const participants = people.filter((person) => Boolean(person.userId)).map((person) => ({ userId: person.userId, displayName: person.name || "Participant", identity: person.identity, isGuest: person.userId.startsWith("guest:") }));
    if (participants.length !== people.length) return res.status(409).json({ error: "One or more participants have an unsupported older session. Ask them to reconnect before recording." });
    const consents = participants.map((person) => ({ ...person, decision: person.userId === req.auth!.userId ? "accepted" as const : "pending" as const, decidedAt: person.userId === req.auth!.userId ? new Date() : null }));
    const recording = await Recording.create({
      meeting: meeting._id, meetingSlug: meeting.slug, meetingTitle: meeting.title, hostUserId: req.auth!.userId,
      hostName: req.auth!.displayName, participants, consents, status: "consent_pending",
    });
    meeting.activeRecordingId = recording._id as any;
    meeting.recordingStatus = "consent_pending";
    await meeting.save();
    void PlatformEvent.create({ category: "recording", action: "recording_consent_requested", actorId: req.auth!.userId, actorName: req.auth!.displayName, meetingSlug: meeting.slug, detail: { participantCount: participants.length } }).catch(() => undefined);
    const claim = await Recording.findOneAndUpdate({ _id: recording._id, status: "consent_pending", startRequested: false, consents: { $not: { $elemMatch: { decision: { $ne: "accepted" } } } } }, { $set: { startRequested: true } }, { new: true });
    if (claim) await startRoomRecording(String(claim._id));
    const updated = await Recording.findById(recording._id).select("status consents startedAt lastError").lean();
    return res.status(201).json({ recording: { id: String(recording._id), status: updated?.status || "consent_pending", consents: updated?.consents || [] } });
  } catch (error) {
    console.error("[recording/start] failed", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not start the room recording." });
  }
});

router.post("/:slug/recording/consent", requireAuth, async (req, res) => {
  const parsed = recordingConsentSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Choose whether to consent to recording." });
  try {
    if (req.auth!.isGuest && req.auth!.meetingSlug !== req.params.slug) return res.status(403).json({ error: "This guest session belongs to another meeting." });
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id owner");
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const recording = await Recording.findOne({ _id: parsed.data.recordingId, meeting: meeting._id, status: "consent_pending" });
    if (!recording) return res.status(409).json({ error: "This recording consent request is no longer active." });
    const person = (await listRoomPeople(`eni-${meeting.slug}`)).find((item) => item.identity === parsed.data.identity && item.userId === req.auth!.userId);
    if (!person) return res.status(403).json({ error: "Your connected meeting identity could not be verified." });
    const consent = recording.consents.find((entry: any) => entry.identity === parsed.data.identity && entry.userId === req.auth!.userId) as any;
    if (!consent) return res.status(403).json({ error: "This recording request was not addressed to your participant identity." });
    consent.decision = parsed.data.accepted ? "accepted" : "declined";
    consent.decidedAt = new Date();
    if (!parsed.data.accepted) {
      recording.status = "declined";
      recording.lastError = `${person.name || "A participant"} declined recording consent.`;
      await recording.save();
      await Meeting.updateOne({ _id: meeting._id }, { $set: { recordingStatus: "declined" } });
      return res.json({ success: true, status: "declined", message: "Recording was not started because a participant declined." });
    }
    await recording.save();
    const claim = await Recording.findOneAndUpdate({ _id: recording._id, status: "consent_pending", startRequested: false, consents: { $not: { $elemMatch: { decision: { $ne: "accepted" } } } } }, { $set: { startRequested: true } }, { new: true });
    if (claim) await startRoomRecording(String(claim._id));
    const latest = await Recording.findById(recording._id).select("status consents").lean();
    return res.json({ success: true, status: latest?.status || "consent_pending", consents: latest?.consents || [] });
  } catch (error) {
    console.error("[recording/consent] failed", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not save your recording decision." });
  }
});

router.post("/:slug/recording/stop", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id owner activeRecordingId");
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId || req.auth!.isGuest) return res.status(403).json({ error: "Only the meeting host can stop recording." });
    if (!meeting.activeRecordingId) return res.status(409).json({ error: "There is no active recording." });
    await stopRoomRecording(String(meeting.activeRecordingId));
    void PlatformEvent.create({ category: "recording", action: "recording_stopped", actorId: req.auth!.userId, actorName: req.auth!.displayName, meetingSlug: req.params.slug }).catch(() => undefined);
    return res.json({ success: true, status: "uploading" });
  } catch (error) {
    console.error("[recording/stop] failed", error);
    return res.status(500).json({ error: "Could not stop the recording." });
  }
});

router.post("/:slug/recording/retry", requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id owner activeRecordingId");
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (String(meeting.owner) !== req.auth!.userId || req.auth!.isGuest) return res.status(403).json({ error: "Only the meeting host can retry an upload." });
    const recording = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId) : null;
    if (!recording || recording.status !== "failed" || !recording.stagedKey || !recording.stagedAvailable) return res.status(409).json({ error: "There is no retryable staged recording." });
    await uploadCompletedRecording(String(recording._id));
    return res.json({ success: true, status: "ready" });
  } catch (error) {
    console.error("[recording/retry] failed", error);
    return res.status(500).json({ error: "The recording upload could not be retried. The staged source has been retained." });
  }
});

export default router;
