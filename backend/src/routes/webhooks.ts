import { Router, type Request, type Response } from "express";
import { WebhookReceiver } from "livekit-server-sdk";
import { Attendance } from "../models/Attendance.js";
import { Meeting } from "../models/Meeting.js";
import { Recording } from "../models/Recording.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { deleteStagedRecording, startRoomRecording, uploadCompletedRecording } from "../lib/recordings.js";
import { listRoomPeople } from "../lib/livekit.js";

const router = Router();
let receiver: WebhookReceiver | null = null;

router.post("/livekit", async (req: Request, res: Response) => {
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!key || !secret) return res.status(503).json({ error: "LiveKit webhook verification is not configured." });
  try {
    receiver ??= new WebhookReceiver(key, secret);
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!body) return res.status(400).json({ error: "A raw LiveKit webhook body is required." });
    const event = await receiver.receive(body, req.get("Authorization") || "");
    const payload = event as any;
    const roomName = String(payload.room?.name || "");
    const slug = roomName.startsWith("eni-") ? roomName.slice(4) : "";

    if ((payload.event === "participant_joined" || payload.event === "participant_left") && slug && payload.participant?.identity) {
      const participant = payload.participant;
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(String(participant.metadata || "{}")); } catch { /* Ignore invalid metadata. */ }
      const userId = typeof metadata.userId === "string" ? metadata.userId : "";
      const name = String(participant.name || metadata.displayName || "Participant").slice(0, 80);
      const isGuest = userId.startsWith("guest:");
      const meeting = await Meeting.findOne({ slug }).select("_id participantAccounts owner").lean();
      if (meeting) {
        if (payload.event === "participant_joined") {
          await Attendance.updateOne({ meeting: meeting._id, identity: participant.identity }, {
            $set: { meetingSlug: slug, participantId: userId || participant.identity, displayName: name, isGuest, leftAt: null, durationSeconds: 0 },
            $setOnInsert: { joinedAt: new Date() },
          }, { upsert: true });
          if (userId) {
            await Meeting.updateOne({ _id: meeting._id, "participantAccounts.userId": { $ne: userId } }, {
              $push: { participantAccounts: { userId, displayName: name, picture: String(metadata.picture || ""), isGuest, guestId: isGuest ? userId.slice(6) : "" } },
            });
          }
        } else {
          const entry = await Attendance.findOne({ meeting: meeting._id, identity: participant.identity });
          if (entry && !entry.leftAt) {
            entry.leftAt = new Date();
            entry.durationSeconds = Math.max(0, Math.round((entry.leftAt.getTime() - entry.joinedAt.getTime()) / 1000));
            await entry.save();
          }

          // A person who leaves before recording starts no longer needs to hold
          // the consent gate open. The host must still be connected before the
          // remaining accepted consents can start the room composite.
          const pending = await Recording.findOne({ meeting: meeting._id, status: "consent_pending", "consents.identity": participant.identity });
          if (pending) {
            if (userId && userId === pending.hostUserId) {
              await Recording.updateOne({ _id: pending._id, status: "consent_pending" }, { $set: { status: "declined", lastError: "The host left before recording consent was complete." } });
              await Meeting.updateOne({ _id: meeting._id, activeRecordingId: pending._id }, { $set: { recordingStatus: "declined" } });
            } else {
              await Recording.updateOne({ _id: pending._id, status: "consent_pending" }, {
                $pull: { consents: { identity: participant.identity }, participants: { identity: participant.identity } },
              });
              const latest = await Recording.findById(pending._id).lean();
              if (latest && latest.consents.length > 0 && latest.consents.every((entry: any) => entry.decision === "accepted") && !latest.startRequested) {
                const hostStillConnected = (await listRoomPeople(`eni-${slug}`)).some((person) => person.userId === pending.hostUserId);
                if (hostStillConnected) {
                  const claim = await Recording.findOneAndUpdate(
                    { _id: pending._id, status: "consent_pending", startRequested: false, consents: { $not: { $elemMatch: { decision: { $ne: "accepted" } } } } },
                    { $set: { startRequested: true } },
                    { new: true },
                  );
                  if (claim) await startRoomRecording(String(claim._id));
                }
              }
            }
          }
        }
      }
    }

    if (payload.event === "egress_ended" && payload.egressInfo?.egressId) {
      const egressId = String(payload.egressInfo.egressId);
      const status = Number(payload.egressInfo.status);
      const fileResult = Array.isArray(payload.egressInfo.fileResults) ? payload.egressInfo.fileResults[0] : null;
      if (status === 3 && fileResult) {
        // Webhooks may be retried or delivered both from the project and the
        // per-egress callback. Claim the completed source atomically so only
        // one worker uploads it to Cloudinary.
        const recording = await Recording.findOneAndUpdate(
          { egressId, status: { $in: ["recording", "uploading"] }, stagedAvailable: { $ne: true } },
          { $set: { status: "uploading", endedAt: new Date(), fileSize: Number(fileResult.size || 0), stagedAvailable: true } },
          { new: true },
        );
        if (recording) {
          void uploadCompletedRecording(String(recording._id)).catch((error) => console.error("[recording/upload] retryable failure", error instanceof Error ? error.message : error));
        }
      } else {
        const recording = await Recording.findOneAndUpdate(
          { egressId, status: { $in: ["recording", "uploading"] }, stagedAvailable: { $ne: true } },
          { $set: { status: "failed", endedAt: new Date(), lastError: String(payload.egressInfo.error || "LiveKit recording did not finish successfully.").slice(0, 1000) } },
          { new: true },
        );
        if (recording) {
          await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "failed" } });
          void deleteStagedRecording(String(recording._id)).catch((cleanupError) => console.warn("[recording/failed-egress-cleanup] could not remove partial source", cleanupError instanceof Error ? cleanupError.message : cleanupError));
        }
      }
    }

    if (payload.event === "room_finished" && slug) {
      await Meeting.updateOne({ slug, status: "live" }, { $set: { status: "ended", endedAt: new Date() } });
      await PlatformEvent.create({ category: "meeting", action: "room_finished", meetingSlug: slug });
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[webhook/livekit] rejected or failed", error instanceof Error ? error.message : error);
    return res.status(401).json({ error: "Invalid or unprocessable LiveKit webhook." });
  }
});

export default router;
