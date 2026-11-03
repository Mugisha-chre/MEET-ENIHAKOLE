import { Router } from "express";
import { z } from "zod";
import { optionalAuth, requireAuth, requireRegisteredAuth, requireSystemAdmin } from "../middleware/auth.js";
import { Meeting } from "../models/Meeting.js";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";
import { Attendance } from "../models/Attendance.js";
import { Recording } from "../models/Recording.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { closeLiveKitRoom, listRoomPeople } from "../lib/livekit.js";
import { stopRoomRecording } from "../lib/recordings.js";

const router = Router();
router.use(optionalAuth, requireAuth, requireRegisteredAuth, requireSystemAdmin);
const userStatusSchema = z.object({ status: z.enum(["active", "suspended"]) });
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function audit(actorId: string, actorName: string, action: string, detail: Record<string, unknown> = {}, meetingSlug = "") {
  await PlatformEvent.create({ category: "admin", action, actorId, actorName, detail, meetingSlug });
}

router.get("/overview", async (_req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const activeSince = new Date(Date.now() - 3 * 60_000);
    const [totalMeetings, activeMeetings, completedMeetings, registeredAccounts, activeSessions, uniqueParticipants, guestParticipants, pageViews, pageLoads, apiRequests, daily, recentEvents, liveMeetingDocs] = await Promise.all([
      Meeting.countDocuments(),
      Meeting.countDocuments({ status: "live" }),
      Meeting.countDocuments({ status: "ended" }),
      User.countDocuments(),
      UserSession.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() }, lastSeenAt: { $gte: activeSince } }),
      Attendance.distinct("participantId"),
      Attendance.distinct("participantId", { isGuest: true, joinedAt: { $gte: since } }),
      PlatformEvent.countDocuments({ category: "page_view" }),
      PlatformEvent.countDocuments({ category: "page_view", action: "page_load" }),
      PlatformEvent.countDocuments({ category: "traffic", action: "api_request" }),
      PlatformEvent.aggregate([
        { $match: { createdAt: { $gte: since }, category: { $in: ["page_view", "traffic"] } } },
        { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, category: "$category" }, count: { $sum: 1 } } },
        { $sort: { "_id.day": 1 } },
      ]),
      PlatformEvent.find().sort({ createdAt: -1 }).limit(12).select("category action actorName meetingSlug path statusCode createdAt detail").lean(),
      Meeting.find({ status: "live" }).select("slug").lean(),
    ]);
    // Query every active room in small concurrent batches: no meeting is
    // omitted from the platform total, while API pressure stays bounded.
    let onlineParticipants = 0;
    for (let offset = 0; offset < liveMeetingDocs.length; offset += 25) {
      const batch = liveMeetingDocs.slice(offset, offset + 25);
      const counts = await Promise.all(batch.map(async (meeting) =>
        (await listRoomPeople(`eni-${meeting.slug}`)).length,
      ));
      onlineParticipants += counts.reduce((total, count) => total + count, 0);
    }
    const trendMap = new Map<string, { day: string; pageViews: number; requests: number }>();
    for (const item of daily as Array<{ _id: { day: string; category: string }; count: number }>) {
      const row = trendMap.get(item._id.day) || { day: item._id.day, pageViews: 0, requests: 0 };
      if (item._id.category === "page_view") row.pageViews = item.count;
      if (item._id.category === "traffic") row.requests = item.count;
      trendMap.set(item._id.day, row);
    }
    return res.json({
      stats: { totalMeetings, activeMeetings, completedMeetings, registeredAccounts, activeSessions, uniqueParticipants: uniqueParticipants.length, guestParticipants: guestParticipants.length, onlineParticipants, pageViews, pageLoads, apiRequests },
      trends: [...trendMap.values()],
      recentActivity: recentEvents,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[admin/overview] failed", error);
    return res.status(500).json({ error: "Could not load platform statistics." });
  }
});

router.get("/meetings", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const meetings = await Meeting.find().sort({ createdAt: -1 }).limit(limit).select("title slug owner ownerName startsAt durationMinutes status startedAt endedAt recordingStatus createdAt").lean();
    const rows = await Promise.all(meetings.map(async (meeting) => {
      const [attendanceCount, recordingCount, livePeople] = await Promise.all([
        Attendance.countDocuments({ meeting: meeting._id }),
        Recording.countDocuments({ meeting: meeting._id }),
        meeting.status === "live" ? listRoomPeople(`eni-${meeting.slug}`) : Promise.resolve([]),
      ]);
      return { ...meeting, id: String(meeting._id), ownerId: String(meeting.owner), attendanceCount, recordingCount, onlineNow: livePeople.length };
    }));
    return res.json({ meetings: rows });
  } catch (error) {
    console.error("[admin/meetings] failed", error);
    return res.status(500).json({ error: "Could not load meeting management data." });
  }
});

router.get("/meetings/:slug/attendance", async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("title slug ownerName startsAt startedAt endedAt status").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const [attendance, recordings, livePeople] = await Promise.all([
      Attendance.find({ meetingSlug: req.params.slug }).sort({ joinedAt: 1 }).select("participantId identity displayName isGuest joinedAt leftAt durationSeconds").lean(),
      Recording.find({ meetingSlug: req.params.slug }).sort({ createdAt: -1 }).select("status startedAt endedAt durationSeconds hostName participants fileSize uploadProgressPercent lastError").lean(),
      meeting.status === "live" ? listRoomPeople(`eni-${req.params.slug}`) : Promise.resolve([]),
    ]);
    const onlineIdentities = new Set(livePeople.map((person) => person.identity));
    const attendanceWithPresence = attendance.map((item) => ({
      ...item,
      onlineNow: onlineIdentities.has(item.identity),
      durationSeconds: item.leftAt ? item.durationSeconds : Math.max(0, Math.round((Date.now() - new Date(item.joinedAt).getTime()) / 1000)),
    }));
    return res.json({ meeting, attendance: attendanceWithPresence, recordings });
  } catch (error) {
    console.error("[admin/attendance] failed", error);
    return res.status(500).json({ error: "Could not load attendance history." });
  }
});

router.post("/meetings/:slug/terminate", async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    if (meeting.status !== "live") return res.status(409).json({ error: "Only an active meeting can be terminated." });
    const recording = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId) : null;
    if (recording?.status === "recording") await stopRoomRecording(String(recording._id)).catch((error) => console.warn("[admin] recording stop during terminate failed", error));
    else if (recording?.status === "consent_pending") {
      recording.status = "declined";
      recording.lastError = "The meeting was terminated before recording consent was complete.";
      await recording.save();
      meeting.recordingStatus = "declined";
    }
    meeting.status = "ended";
    meeting.endedAt = new Date();
    await meeting.save();
    await closeLiveKitRoom(`eni-${meeting.slug}`);
    await audit(req.auth!.userId, req.auth!.displayName, "meeting_terminated", { title: meeting.title, ownerId: String(meeting.owner) }, meeting.slug);
    return res.json({ success: true, meeting: { slug: meeting.slug, status: meeting.status, endedAt: meeting.endedAt } });
  } catch (error) {
    console.error("[admin/terminate] failed", error);
    return res.status(500).json({ error: "Could not terminate this meeting." });
  }
});

router.get("/users", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const safeQuery = escapeRegex(query);
    const filter = query ? { $or: [{ displayName: { $regex: safeQuery, $options: "i" } }, { email: { $regex: safeQuery, $options: "i" } }] } : {};
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(100).select("displayName email picture platformRole accountStatus createdAt").lean();
    const sessionActiveSince = new Date(Date.now() - 3 * 60_000);
    const sessions = await UserSession.find({ user: { $in: users.map((user) => user._id) }, revokedAt: null, expiresAt: { $gt: new Date() }, lastSeenAt: { $gte: sessionActiveSince } }).sort({ lastSeenAt: -1 }).select("user createdAt lastSeenAt expiresAt userAgent").lean();
    const sessionsByUser = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const key = String(session.user);
      sessionsByUser.set(key, [...(sessionsByUser.get(key) || []), session]);
    }
    return res.json({ users: users.map((user) => ({
      id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "",
      platformRole: user.platformRole || "member", accountStatus: user.accountStatus || "active", createdAt: user.createdAt,
      sessions: (sessionsByUser.get(String(user._id)) || []).map((item) => ({ createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, expiresAt: item.expiresAt, userAgent: item.userAgent })),
    })) });
  } catch (error) {
    console.error("[admin/users] failed", error);
    return res.status(500).json({ error: "Could not load platform users." });
  }
});

router.patch("/users/:id/status", async (req, res) => {
  const parsed = userStatusSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid account status." });
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You cannot suspend your own administrator account." });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Account not found." });
    if (user.platformRole === "system_admin") return res.status(403).json({ error: "System administrator accounts cannot be suspended from this screen." });
    user.accountStatus = parsed.data.status;
    await user.save();
    if (parsed.data.status === "suspended") await UserSession.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req.auth!.userId, req.auth!.displayName, parsed.data.status === "suspended" ? "user_suspended" : "user_reactivated", { targetUserId: String(user._id), targetEmail: user.email });
    return res.json({ success: true, user: { id: String(user._id), accountStatus: user.accountStatus } });
  } catch (error) {
    console.error("[admin/user-status] failed", error);
    return res.status(500).json({ error: "Could not update the account status." });
  }
});

router.get("/recordings", async (_req, res) => {
  try {
    const recordings = await Recording.find().sort({ createdAt: -1 }).limit(500).select("meetingSlug meetingTitle hostName hostUserId participants status startedAt endedAt durationSeconds fileSize uploadAttempts uploadProgressPercent lastError createdAt").lean();
    return res.json({ recordings });
  } catch (error) {
    console.error("[admin/recordings] failed", error);
    return res.status(500).json({ error: "Could not load recording inventory." });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const events = await PlatformEvent.find().sort({ createdAt: -1 }).limit(limit).select("category action actorId actorName meetingSlug path method statusCode durationMs detail createdAt").lean();
    return res.json({ events });
  } catch (error) {
    console.error("[admin/activity] failed", error);
    return res.status(500).json({ error: "Could not load system activity." });
  }
});

export default router;
