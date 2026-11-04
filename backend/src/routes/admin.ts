import { Router } from "express";
import { z } from "zod";
import { optionalAuth, requireAuth, requireRegisteredAuth, requireSystemAdmin } from "../middleware/auth.js";
import { Meeting } from "../models/Meeting.js";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";
import { Attendance } from "../models/Attendance.js";
import { PrivateMessage } from "../models/PrivateMessage.js";
import { Recording } from "../models/Recording.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { closeLiveKitRoom, listRoomPeople } from "../lib/livekit.js";
import { stopRoomRecording } from "../lib/recordings.js";
import { permanentlyDeleteRecording, RECORDING_RETENTION_MS } from "../lib/recordingRetention.js";

const router = Router();
router.use(optionalAuth, requireAuth, requireRegisteredAuth, requireSystemAdmin);
const userStatusSchema = z.object({ status: z.enum(["active", "suspended"]) });
const meetingPermissionSchema = z.object({ allowed: z.boolean() });
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pageParams = (req: any) => ({
  page: Math.max(1, Math.min(100_000, Number(req.query.page) || 1)),
  limit: Math.max(5, Math.min(50, Number(req.query.limit) || 20)),
});
const pageResult = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
const sortOrder = (req: any) => req.query.sort === "oldest" ? 1 : -1;

async function audit(actorId: string, actorName: string, action: string, detail: Record<string, unknown> = {}, meetingSlug = "") {
  await PlatformEvent.create({ category: "admin", action, actorId, actorName, detail, meetingSlug });
}

async function cancelPendingRecordingConsentForDelete(recordingId: unknown, meetingId: unknown): Promise<string> {
  const now = new Date();
  const result = await Recording.updateOne(
    { _id: recordingId, status: "consent_pending" },
    { $set: { status: "declined", endedAt: now, expiresAt: new Date(now.getTime() + RECORDING_RETENTION_MS), lastError: "Recording consent was cancelled because an administrator deleted the meeting or host account." } },
  );
  if (result.modifiedCount > 0) {
    await Meeting.updateOne({ _id: meetingId, activeRecordingId: recordingId }, { $set: { recordingStatus: "idle" }, $unset: { activeRecordingId: 1 } });
    return "declined";
  }
  const latest = await Recording.findById(recordingId).select("status").lean();
  return String(latest?.status || "missing");
}

router.get("/overview", async (_req, res) => {
  try {
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - 30 * 24 * 60 * 60_000);
    const activeSince = new Date(generatedAt.getTime() - 3 * 60_000);
    const [totalMeetings, activeMeetings, completedMeetings, registeredAccounts, activeSessions, uniqueParticipants, guestParticipants, pageViews, pageLoads, apiRequests, daily, liveMeetingDocs, meetingStatusRows, recordingStatusRows, meetingCreationRows] = await Promise.all([
      Meeting.countDocuments(),
      Meeting.countDocuments({ status: "live" }),
      Meeting.countDocuments({ status: "ended" }),
      User.countDocuments(),
      UserSession.countDocuments({ revokedAt: null, expiresAt: { $gt: generatedAt }, lastSeenAt: { $gte: activeSince } }),
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
      Meeting.find({ status: "live" }).select("slug").lean(),
      Meeting.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Recording.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      PlatformEvent.aggregate([
        { $match: { createdAt: { $gte: since }, category: "meeting", action: { $in: ["meeting_created", "meeting_started", "room_finished"] } } },
        { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, action: "$action" }, count: { $sum: 1 } } },
        { $sort: { "_id.day": 1 } },
      ]),
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
    const trendMap = new Map<string, { day: string; pageViews: number; requests: number; meetingsCreated: number; meetingsStarted: number; meetingsEnded: number }>();
    // Include zero-event UTC days as true zeroes so gaps are not compressed into
    // a misleading straight line on the analytics chart.
    const firstDay = new Date(since);
    firstDay.setUTCHours(0, 0, 0, 0);
    for (const cursor = new Date(firstDay); cursor <= generatedAt; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.toISOString().slice(0, 10);
      trendMap.set(day, { day, pageViews: 0, requests: 0, meetingsCreated: 0, meetingsStarted: 0, meetingsEnded: 0 });
    }
    for (const item of daily as Array<{ _id: { day: string; category: string }; count: number }>) {
      const row = trendMap.get(item._id.day) || { day: item._id.day, pageViews: 0, requests: 0, meetingsCreated: 0, meetingsStarted: 0, meetingsEnded: 0 };
      if (item._id.category === "page_view") row.pageViews = item.count;
      if (item._id.category === "traffic") row.requests = item.count;
      trendMap.set(item._id.day, row);
    }
    for (const item of meetingCreationRows as Array<{ _id: { day: string; action: string }; count: number }>) {
      const row = trendMap.get(item._id.day) || { day: item._id.day, pageViews: 0, requests: 0, meetingsCreated: 0, meetingsStarted: 0, meetingsEnded: 0 };
      if (item._id.action === "meeting_created") row.meetingsCreated = item.count;
      if (item._id.action === "meeting_started") row.meetingsStarted = item.count;
      if (item._id.action === "room_finished") row.meetingsEnded = item.count;
      trendMap.set(item._id.day, row);
    }
    return res.json({
      stats: { totalMeetings, activeMeetings, completedMeetings, registeredAccounts, activeSessions, uniqueParticipants: uniqueParticipants.length, guestParticipants: guestParticipants.length, onlineParticipants, pageViews, pageLoads, apiRequests },
      trends: [...trendMap.values()],
      meetingStatusBreakdown: meetingStatusRows.map((item: any) => ({ label: String(item._id || "unknown"), value: item.count })),
      recordingStatusBreakdown: recordingStatusRows.map((item: any) => ({ label: String(item._id || "unknown"), value: item.count })),
      range: { start: since.toISOString(), end: generatedAt.toISOString(), days: 30 },
      generatedAt: generatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[admin/overview] failed", error);
    return res.status(500).json({ error: "Could not load platform statistics." });
  }
});

router.get("/meetings", async (req, res) => {
  try {
    const { page, limit } = pageParams(req);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const filter: Record<string, any> = {};
    if (query) { const safe = escapeRegex(query); filter.$or = [{ title: { $regex: safe, $options: "i" } }, { slug: { $regex: safe, $options: "i" } }, { ownerName: { $regex: safe, $options: "i" } }]; }
    if (["scheduled", "live", "ended", "cancelled"].includes(status)) filter.status = status;
    const total = await Meeting.countDocuments(filter);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const meetings = await Meeting.find(filter).sort({ createdAt: sortOrder(req), _id: sortOrder(req) }).skip((currentPage - 1) * limit).limit(limit).select("title slug owner ownerName startsAt durationMinutes status startedAt endedAt recordingStatus createdAt").lean();
    const rows = await Promise.all(meetings.map(async (meeting) => {
      const [attendanceCount, recordingCount, livePeople] = await Promise.all([
        Attendance.countDocuments({ meeting: meeting._id }),
        Recording.countDocuments({ meeting: meeting._id }),
        meeting.status === "live" ? listRoomPeople(`eni-${meeting.slug}`) : Promise.resolve([]),
      ]);
      return { ...meeting, id: String(meeting._id), ownerId: String(meeting.owner), attendanceCount, recordingCount, onlineNow: livePeople.length };
    }));
    return res.json({ meetings: rows, pagination: pageResult(currentPage, limit, total) });
  } catch (error) {
    console.error("[admin/meetings] failed", error);
    return res.status(500).json({ error: "Could not load meeting management data." });
  }
});

router.get("/meetings/:slug/attendance", async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug }).select("_id title slug ownerName startsAt startedAt endedAt status").lean();
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    const { page, limit } = pageParams(req);
    const filter = { meeting: meeting._id };
    const total = await Attendance.countDocuments(filter);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const [attendance, livePeople] = await Promise.all([
      Attendance.find(filter).sort({ joinedAt: 1, _id: 1 }).skip((currentPage - 1) * limit).limit(limit).select("participantId identity displayName isGuest joinedAt leftAt durationSeconds").lean(),
      meeting.status === "live" ? listRoomPeople(`eni-${req.params.slug}`) : Promise.resolve([]),
    ]);
    const onlineIdentities = new Set(livePeople.map((person) => person.identity));
    const attendanceWithPresence = attendance.map((item) => ({
      ...item,
      onlineNow: onlineIdentities.has(item.identity),
      durationSeconds: item.leftAt ? item.durationSeconds : Math.max(0, Math.round((Date.now() - new Date(item.joinedAt).getTime()) / 1000)),
    }));
    return res.json({ meeting, attendance: attendanceWithPresence, pagination: pageResult(currentPage, limit, total) });
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
      recording.endedAt = new Date();
      recording.expiresAt = new Date(recording.endedAt.getTime() + RECORDING_RETENTION_MS);
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
    const { page, limit } = pageParams(req);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const safeQuery = escapeRegex(query);
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const filter: Record<string, any> = query ? { $or: [{ displayName: { $regex: safeQuery, $options: "i" } }, { email: { $regex: safeQuery, $options: "i" } }] } : {};
    if (["active", "suspended"].includes(status)) filter.accountStatus = status;
    const total = await User.countDocuments(filter);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const users = await User.find(filter).sort({ createdAt: sortOrder(req), _id: sortOrder(req) }).skip((currentPage - 1) * limit).limit(limit).select("displayName email picture platformRole accountStatus canCreateMeetings createdAt").lean();
    const generatedAt = new Date();
    const sessionActiveSince = new Date(generatedAt.getTime() - 3 * 60_000);
    const sessions = await UserSession.find({ user: { $in: users.map((user) => user._id) }, revokedAt: null, expiresAt: { $gt: generatedAt }, lastSeenAt: { $gte: sessionActiveSince } }).sort({ lastSeenAt: -1 }).select("user createdAt lastSeenAt expiresAt userAgent").lean();
    const sessionsByUser = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const key = String(session.user);
      sessionsByUser.set(key, [...(sessionsByUser.get(key) || []), session]);
    }
    return res.json({ users: users.map((user) => ({
      id: String(user._id), displayName: user.displayName, email: user.email, picture: user.picture || "",
      platformRole: user.platformRole || "member", accountStatus: user.accountStatus || "active", canCreateMeetings: Boolean(user.canCreateMeetings), createdAt: user.createdAt,
      sessions: (sessionsByUser.get(String(user._id)) || []).map((item) => ({ createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, expiresAt: item.expiresAt, userAgent: item.userAgent })),
    })), pagination: pageResult(currentPage, limit, total) });
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

router.patch("/users/:id/meeting-permission", async (req, res) => {
  const parsed = meetingPermissionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Choose whether this account may create meetings." });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Account not found." });
    if (user.platformRole === "system_admin") return res.status(400).json({ error: "System administrators already have meeting creation access." });
    user.canCreateMeetings = parsed.data.allowed;
    await user.save();
    await audit(req.auth!.userId, req.auth!.displayName, parsed.data.allowed ? "meeting_creation_permission_granted" : "meeting_creation_permission_revoked", { targetUserId: String(user._id), targetEmail: user.email });
    return res.json({ success: true, user: { id: String(user._id), canCreateMeetings: user.canCreateMeetings } });
  } catch (error) {
    console.error("[admin/user-meeting-permission] failed", error);
    return res.status(500).json({ error: "Could not update meeting creation permission." });
  }
});

router.get("/recordings", async (req, res) => {
  try {
    const { page, limit } = pageParams(req);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const filter: Record<string, any> = {};
    if (query) { const safe = escapeRegex(query); filter.$or = [{ meetingTitle: { $regex: safe, $options: "i" } }, { meetingSlug: { $regex: safe, $options: "i" } }, { hostName: { $regex: safe, $options: "i" } }]; }
    if (["consent_pending", "recording", "uploading", "ready", "failed", "declined"].includes(status)) filter.status = status;
    const total = await Recording.countDocuments(filter);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const recordings = await Recording.find(filter).sort({ createdAt: sortOrder(req), _id: sortOrder(req) }).skip((currentPage - 1) * limit).limit(limit).select("meetingSlug meetingTitle hostName hostUserId participants status startedAt endedAt expiresAt durationSeconds fileSize uploadAttempts uploadProgressPercent lastError deletionStatus lastDeletionError createdAt").lean();
    return res.json({ recordings, pagination: pageResult(currentPage, limit, total) });
  } catch (error) {
    console.error("[admin/recordings] failed", error);
    return res.status(500).json({ error: "Could not load recording inventory." });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const { page, limit } = pageParams(req);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const filter: Record<string, any> = {};
    if (query) { const safe = escapeRegex(query); filter.$or = [{ action: { $regex: safe, $options: "i" } }, { actorName: { $regex: safe, $options: "i" } }, { meetingSlug: { $regex: safe, $options: "i" } }, { path: { $regex: safe, $options: "i" } }]; }
    if (["traffic", "page_view", "auth", "meeting", "recording", "admin", "system"].includes(category)) filter.category = category;
    const total = await PlatformEvent.countDocuments(filter);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const events = await PlatformEvent.find(filter).sort({ createdAt: sortOrder(req), _id: sortOrder(req) }).skip((currentPage - 1) * limit).limit(limit).select("category action actorId actorName meetingSlug path method statusCode durationMs detail createdAt").lean();
    return res.json({ events, pagination: pageResult(currentPage, limit, total) });
  } catch (error) {
    console.error("[admin/activity] failed", error);
    return res.status(500).json({ error: "Could not load system activity." });
  }
});

router.delete("/recordings/:id", async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id).select("_id meeting status meetingSlug meetingTitle stagedKey cloudinaryPublicId").lean();
    if (!recording) return res.status(404).json({ error: "Recording not found." });
    if (recording.status === "consent_pending") await cancelPendingRecordingConsentForDelete(recording._id, recording.meeting);
    else if (["recording", "uploading"].includes(recording.status)) return res.status(409).json({ error: "Stop or finish this recording before deleting its media." });
    await audit(req.auth!.userId, req.auth!.displayName, "recording_delete_requested", { recordingId: String(recording._id), meetingTitle: recording.meetingTitle }, recording.meetingSlug);
    const deleted = await permanentlyDeleteRecording(String(recording._id), { userId: req.auth!.userId, displayName: req.auth!.displayName, reason: "admin_manual_delete" });
    if (!deleted) return res.status(409).json({ error: "This recording is already being deleted. Refresh and try again." });
    await audit(req.auth!.userId, req.auth!.displayName, "recording_deleted", { recordingId: String(recording._id), meetingTitle: recording.meetingTitle }, recording.meetingSlug);
    return res.json({ success: true });
  } catch (error) {
    console.error("[admin/recording-delete] failed", error);
    return res.status(503).json({ error: "Recording access has been blocked, but storage cleanup is incomplete and will be retried. " + (error instanceof Error ? error.message : "") });
  }
});

router.delete("/meetings/:slug", async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ slug: req.params.slug });
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    await audit(req.auth!.userId, req.auth!.displayName, "meeting_delete_requested", { title: meeting.title, ownerId: String(meeting.owner) }, meeting.slug);
    if (meeting.status === "live") {
      const activeRecording = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId) : null;
      let activeStatus = activeRecording?.status || "";
      if (activeRecording && activeStatus === "consent_pending") activeStatus = await cancelPendingRecordingConsentForDelete(activeRecording._id, meeting._id);
      if (activeRecording && activeStatus === "recording") {
        await stopRoomRecording(String(activeRecording._id));
        await closeLiveKitRoom(`eni-${meeting.slug}`).catch(() => undefined);
        return res.status(409).json({ error: "The meeting has been ended. Its recording is still finalizing; retry deletion after the recording upload finishes." });
      }
      if (activeRecording && activeStatus === "uploading") {
        await closeLiveKitRoom(`eni-${meeting.slug}`).catch(() => undefined);
        return res.status(409).json({ error: "The meeting has been ended. Its recording is still uploading; retry deletion after the upload finishes." });
      }
      await closeLiveKitRoom(`eni-${meeting.slug}`);
    }
    const [recordings, attendanceCountBefore] = await Promise.all([
      Recording.find({ meeting: meeting._id }).select("_id status").lean(),
      Attendance.countDocuments({ meeting: meeting._id }),
    ]);
    for (const item of recordings) {
      let recording = await Recording.findById(item._id).select("status").lean();
      if (recording?.status === "consent_pending") {
        await cancelPendingRecordingConsentForDelete(item._id, meeting._id);
        recording = await Recording.findById(item._id).select("status").lean();
      }
      if (recording && ["recording", "uploading"].includes(recording.status)) return res.status(409).json({ error: "A recording is still active or uploading. Retry after it finishes." });
      const deleted = await permanentlyDeleteRecording(String(item._id), { userId: req.auth!.userId, displayName: req.auth!.displayName, reason: "meeting_deleted" });
      if (!deleted) return res.status(409).json({ error: "A recording is already being deleted. Retry shortly." });
    }
    await Promise.all([
      Attendance.deleteMany({ meeting: meeting._id }),
      PrivateMessage.deleteMany({ meeting: meeting._id }),
      PlatformEvent.deleteMany({ meetingSlug: meeting.slug, category: { $ne: "admin" } }),
    ]);
    await Meeting.deleteOne({ _id: meeting._id });
    await audit(req.auth!.userId, req.auth!.displayName, "meeting_deleted", { title: meeting.title, ownerId: String(meeting.owner), attendanceRecords: attendanceCountBefore, recordingCount: recordings.length }, meeting.slug).catch((auditError) => console.error("[admin/meeting-delete] completion audit failed", auditError));
    return res.json({ success: true });
  } catch (error) {
    console.error("[admin/meeting-delete] failed", error);
    return res.status(503).json({ error: "Meeting cleanup is incomplete. No dependent attendance/history was removed before recording storage cleanup succeeded. " + (error instanceof Error ? error.message : "") });
  }
});

router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You cannot delete your own administrator account." });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Account not found." });
    if (user.platformRole === "system_admin") return res.status(403).json({ error: "System administrator accounts cannot be deleted from this screen." });
    await audit(req.auth!.userId, req.auth!.displayName, "user_delete_requested", { targetUserId: String(user._id), targetEmail: user.email });
    const ownedMeetings = await Meeting.find({ owner: user._id }).select("slug status activeRecordingId title owner startsAt durationMinutes");
    // Host-owned meeting content is removed as part of account erasure. If an
    // egress job is still writing, stop the room and require a retry once final.
    for (const meeting of ownedMeetings) {
      if (meeting.status === "live") {
        const active = meeting.activeRecordingId ? await Recording.findById(meeting.activeRecordingId).select("_id status") : null;
        let activeStatus = active?.status || "";
        if (active && activeStatus === "consent_pending") activeStatus = await cancelPendingRecordingConsentForDelete(active._id, meeting._id);
        if (active && activeStatus === "recording") {
          await stopRoomRecording(String(active._id));
          await closeLiveKitRoom(`eni-${meeting.slug}`).catch(() => undefined);
          return res.status(409).json({ error: `Meeting ${meeting.slug} has a recording that is still finalizing. Retry account deletion when it completes.` });
        }
        await closeLiveKitRoom(`eni-${meeting.slug}`).catch(() => undefined);
        if (active && activeStatus === "uploading") return res.status(409).json({ error: `Meeting ${meeting.slug} has a recording that is still uploading. Retry account deletion when it completes.` });
      }
      const recordings = await Recording.find({ meeting: meeting._id }).select("_id status").lean();
      for (const rec of recordings) {
        let latest = await Recording.findById(rec._id).select("status").lean();
        if (latest?.status === "consent_pending") {
          await cancelPendingRecordingConsentForDelete(rec._id, meeting._id);
          latest = await Recording.findById(rec._id).select("status").lean();
        }
        if (latest && ["recording", "uploading"].includes(latest.status)) return res.status(409).json({ error: `Meeting ${meeting.slug} has an active recording. Retry account deletion later.` });
        const deleted = await permanentlyDeleteRecording(String(rec._id), { userId: req.auth!.userId, displayName: req.auth!.displayName, reason: "host_account_deleted" });
        if (!deleted) return res.status(409).json({ error: "A recording is already being deleted. Retry shortly." });
      }
    }
    for (const meeting of ownedMeetings) {
      await Promise.all([
        Attendance.deleteMany({ meeting: meeting._id }),
        PrivateMessage.deleteMany({ meeting: meeting._id }),
        PlatformEvent.deleteMany({ meetingSlug: meeting.slug, category: { $ne: "admin" } }),
      ]);
      await Meeting.deleteOne({ _id: meeting._id });
    }
    await Promise.all([
      UserSession.deleteMany({ user: user._id }),
      Attendance.deleteMany({ participantId: String(user._id) }),
      PrivateMessage.deleteMany({ $or: [{ senderUserId: String(user._id) }, { recipientUserId: String(user._id) }] }),
      Meeting.updateMany({}, { $pull: { participantAccounts: { userId: String(user._id) }, bannedUserIds: String(user._id) } }),
    ]);
    await User.deleteOne({ _id: user._id });
    await audit(req.auth!.userId, req.auth!.displayName, "user_deleted", { targetUserId: String(user._id), targetEmail: user.email, ownedMeetingsDeleted: ownedMeetings.length }).catch((auditError) => console.error("[admin/user-delete] completion audit failed", auditError));
    return res.json({ success: true });
  } catch (error) {
    console.error("[admin/user-delete] failed", error);
    return res.status(503).json({ error: "Account deletion was not completed. " + (error instanceof Error ? error.message : "") });
  }
});

export default router;
