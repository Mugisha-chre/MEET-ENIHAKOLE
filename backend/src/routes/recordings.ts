import { Router } from "express";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { Recording } from "../models/Recording.js";
import { createAuthorizedPlaybackUrl } from "../lib/recordings.js";
import { recordingExpirationDate, permanentlyDeleteRecording } from "../lib/recordingRetention.js";

const router = Router();
router.use(optionalAuth);

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const records = await Recording.find({ status: "ready", deletionStatus: { $nin: ["deleting", "delete_failed"] }, $or: [{ hostUserId: req.auth!.userId }, { "participants.userId": req.auth!.userId }] })
      .sort({ endedAt: -1, createdAt: -1 }).limit(100).lean();
    const now = Date.now();
    const recordings = records.filter((item) => recordingExpirationDate(item).getTime() > now).map((item) => ({
      id: String(item._id), meetingSlug: item.meetingSlug, meetingTitle: item.meetingTitle, hostName: item.hostName,
      participants: item.participants.map((person) => ({ displayName: person.displayName, isGuest: person.isGuest })),
      startedAt: item.startedAt, endedAt: item.endedAt, expiresAt: item.expiresAt || recordingExpirationDate(item),
      durationSeconds: item.durationSeconds, fileSize: item.fileSize, status: item.status,
    }));
    return res.json({ recordings });
  } catch (error) {
    console.error("[recordings/mine] failed", error);
    return res.status(500).json({ error: "Could not load your recordings." });
  }
});

router.get("/:id/playback", requireAuth, async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id).lean();
    if (!recording || recording.status !== "ready" || !recording.cloudinaryPublicId || Boolean(recording.deletionStatus && recording.deletionStatus !== "active")) return res.status(404).json({ error: "This recording is not available." });
    const expiresAt = recordingExpirationDate(recording);
    if (expiresAt.getTime() <= Date.now()) {
      void Recording.updateOne({ _id: recording._id, expiresAt: null }, { $set: { expiresAt } }).catch(() => undefined);
      void permanentlyDeleteRecording(String(recording._id)).catch((error) => console.error("[recording/expired-playback-cleanup] failed", error instanceof Error ? error.message : error));
      return res.status(410).json({ error: "This recording has reached the end of its 30-day retention period." });
    }
    if (req.auth!.isGuest && req.auth!.meetingSlug !== recording.meetingSlug) return res.status(403).json({ error: "This guest identity belongs to a different meeting." });
    const allowed = recording.hostUserId === req.auth!.userId || recording.participants.some((person) => person.userId === req.auth!.userId);
    if (!allowed) return res.status(403).json({ error: "You do not have access to this private recording." });
    const playbackUrl = await createAuthorizedPlaybackUrl(recording.cloudinaryPublicId, expiresAt);
    return res.json({ playbackUrl, expiresInSeconds: Math.max(1, Math.min(300, Math.floor((expiresAt.getTime() - Date.now()) / 1000))), expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[recordings/playback] failed", error);
    return res.status(500).json({ error: "Could not prepare secure recording playback." });
  }
});

export default router;
