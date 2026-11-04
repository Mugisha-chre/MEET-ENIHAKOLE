import { Router } from "express";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { Recording } from "../models/Recording.js";
import { Meeting } from "../models/Meeting.js";
import { createAuthorizedPlaybackUrl } from "../lib/recordings.js";
import { recordingExpirationDate, permanentlyDeleteRecording } from "../lib/recordingRetention.js";

const router = Router();
router.use(optionalAuth);

const publicPrayerFilter = {
  $or: [
    { meetingType: "prayer" },
    { meetingType: { $exists: false }, visibility: "public" },
    { meetingType: null, visibility: "public" },
  ],
};

router.get("/public-prayers", async (_req, res) => {
  try {
    const now = new Date();
    const publicPrayerMeetings = await Meeting.find({ ...publicPrayerFilter, status: "ended" }).select("_id slug title startsAt timezone").lean();
    if (!publicPrayerMeetings.length) return res.json({ recordings: [] });
    const meetingIds = publicPrayerMeetings.map((meeting) => meeting._id);
    const records = await Recording.find({
      meeting: { $in: meetingIds }, status: "ready",
      $or: [{ deletionStatus: "active" }, { deletionStatus: { $exists: false } }, { deletionStatus: null }],
    })
      .sort({ endedAt: -1, createdAt: -1 }).limit(150).lean();
    const meetingsById = new Map(publicPrayerMeetings.map((meeting) => [String(meeting._id), meeting]));
    const recordings = records.filter((item) => recordingExpirationDate(item).getTime() > now.getTime()).slice(0, 100).map((item) => ({
      id: String(item._id), meetingSlug: item.meetingSlug, meetingTitle: item.meetingTitle, hostName: item.hostName,
      participants: item.participants.map((person) => ({ displayName: person.displayName, isGuest: person.isGuest })),
      startedAt: item.startedAt, endedAt: item.endedAt, expiresAt: item.expiresAt,
      durationSeconds: item.durationSeconds, fileSize: item.fileSize, status: item.status,
      meetingType: "prayer", public: true, meetingStartsAt: meetingsById.get(String(item.meeting))?.startsAt || null,
    }));
    return res.json({ recordings });
  } catch (error) {
    console.error("[recordings/public-prayers] failed", error);
    return res.status(500).json({ error: "Could not load public prayer recordings." });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const records = await Recording.find({ status: "ready", deletionStatus: { $nin: ["deleting", "delete_failed"] }, $or: [{ hostUserId: req.auth!.userId }, { "participants.userId": req.auth!.userId }] })
      .sort({ endedAt: -1, createdAt: -1 }).limit(100).lean();
    const now = Date.now();
    const validRecords = records.filter((item) => recordingExpirationDate(item).getTime() > now);
    const meetings = validRecords.length
      ? await Meeting.find({ _id: { $in: validRecords.map((item) => item.meeting) } }).select("_id meetingType visibility status").lean()
      : [];
    const meetingById = new Map(meetings.map((meeting) => [String(meeting._id), meeting]));
    const recordings = validRecords.map((item) => {
      const meeting = meetingById.get(String(item.meeting));
      const publicPrayer = Boolean(meeting && (meeting.meetingType === "prayer" || (!meeting.meetingType && meeting.visibility === "public")) && meeting.status === "ended");
      return {
        id: String(item._id), meetingSlug: item.meetingSlug, meetingTitle: item.meetingTitle, hostName: item.hostName,
        participants: item.participants.map((person) => ({ displayName: person.displayName, isGuest: person.isGuest })),
        startedAt: item.startedAt, endedAt: item.endedAt, expiresAt: item.expiresAt || recordingExpirationDate(item),
        durationSeconds: item.durationSeconds, fileSize: item.fileSize, status: item.status,
        meetingType: publicPrayer ? "prayer" : "meeting", public: publicPrayer,
      };
    });
    return res.json({ recordings });
  } catch (error) {
    console.error("[recordings/mine] failed", error);
    return res.status(500).json({ error: "Could not load your recordings." });
  }
});

router.get("/:id/playback", async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id).lean();
    if (!recording || recording.status !== "ready" || !recording.cloudinaryPublicId || Boolean(recording.deletionStatus && recording.deletionStatus !== "active")) return res.status(404).json({ error: "This recording is not available." });
    const expiresAt = recordingExpirationDate(recording);
    if (expiresAt.getTime() <= Date.now()) {
      void Recording.updateOne({ _id: recording._id, expiresAt: null }, { $set: { expiresAt } }).catch(() => undefined);
      void permanentlyDeleteRecording(String(recording._id)).catch((error) => console.error("[recording/expired-playback-cleanup] failed", error instanceof Error ? error.message : error));
      return res.status(410).json({ error: "This recording has reached the end of its 30-day retention period." });
    }
    const meeting = await Meeting.findById(recording.meeting).select("meetingType visibility status slug").lean();
    const publicPrayer = Boolean(meeting && (meeting.meetingType === "prayer" || (!meeting.meetingType && meeting.visibility === "public")) && meeting.status === "ended");
    if (!publicPrayer) {
      if (!req.auth) return res.status(401).json({ error: "Sign in or open the exact meeting invitation link to listen to this recording." });
      if (req.auth.isGuest && req.auth.meetingSlug !== recording.meetingSlug) return res.status(403).json({ error: "This guest identity belongs to a different meeting." });
      const invitedByExactLink = typeof req.query.invite === "string" && req.query.invite === recording.meetingSlug;
      const isParticipant = recording.hostUserId === req.auth.userId || recording.participants.some((person) => person.userId === req.auth!.userId);
      if (!isParticipant && !invitedByExactLink) return res.status(403).json({ error: "You do not have access to this private recording." });
    }
    const playbackUrl = await createAuthorizedPlaybackUrl(recording.cloudinaryPublicId, expiresAt);
    return res.json({ playbackUrl, expiresInSeconds: Math.max(1, Math.min(300, Math.floor((expiresAt.getTime() - Date.now()) / 1000))), expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[recordings/playback] failed", error);
    return res.status(500).json({ error: "Could not prepare secure recording playback." });
  }
});

export default router;
