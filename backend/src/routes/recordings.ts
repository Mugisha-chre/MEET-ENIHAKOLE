import { Router } from "express";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { Recording } from "../models/Recording.js";
import { createAuthorizedPlaybackUrl } from "../lib/recordings.js";

const router = Router();
router.use(optionalAuth);

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const recordings = await Recording.find({ status: "ready", $or: [{ hostUserId: req.auth!.userId }, { "participants.userId": req.auth!.userId }] })
      .sort({ endedAt: -1, createdAt: -1 }).limit(100).lean();
    return res.json({ recordings: recordings.map((item) => ({
      id: String(item._id), meetingSlug: item.meetingSlug, meetingTitle: item.meetingTitle, hostName: item.hostName,
      participants: item.participants.map((person) => ({ displayName: person.displayName, isGuest: person.isGuest })),
      startedAt: item.startedAt, endedAt: item.endedAt, durationSeconds: item.durationSeconds, fileSize: item.fileSize,
      status: item.status,
    })) });
  } catch (error) {
    console.error("[recordings/mine] failed", error);
    return res.status(500).json({ error: "Could not load your recordings." });
  }
});

router.get("/:id/playback", requireAuth, async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id).lean();
    if (!recording || recording.status !== "ready" || !recording.cloudinaryPublicId) return res.status(404).json({ error: "This recording is not available." });
    if (req.auth!.isGuest && req.auth!.meetingSlug !== recording.meetingSlug) return res.status(403).json({ error: "This guest identity belongs to a different meeting." });
    const allowed = recording.hostUserId === req.auth!.userId || recording.participants.some((person) => person.userId === req.auth!.userId);
    if (!allowed) return res.status(403).json({ error: "You do not have access to this private recording." });
    const playbackUrl = await createAuthorizedPlaybackUrl(recording.cloudinaryPublicId);
    return res.json({ playbackUrl, expiresInSeconds: 600 });
  } catch (error) {
    console.error("[recordings/playback] failed", error);
    return res.status(500).json({ error: "Could not prepare secure recording playback." });
  }
});

export default router;
