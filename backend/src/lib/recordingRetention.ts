import { Recording } from "../models/Recording.js";
import { Meeting } from "../models/Meeting.js";
import { PlatformEvent } from "../models/PlatformEvent.js";
import { deleteRecordingMedia, uploadCompletedRecording } from "./recordings.js";

export const RECORDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const DELETE_LEASE_MS = 30 * 60 * 1000;
const BATCH_SIZE = 8;
let sweepPromise: Promise<void> | null = null;
let lastSweepAt = 0;

/** UTC-safe exact 30-day expiry from the recording completion timestamp. */
export function recordingExpirationDate(recording: {
  endedAt?: Date | string | null;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
  expiresAt?: Date | string | null;
}): Date {
  if (recording.expiresAt) {
    const persisted = recording.expiresAt instanceof Date ? recording.expiresAt : new Date(recording.expiresAt);
    if (!Number.isNaN(persisted.getTime())) return persisted;
  }
  const source = recording.endedAt || recording.startedAt || recording.createdAt || new Date();
  const base = source instanceof Date ? source : new Date(source);
  return new Date((Number.isNaN(base.getTime()) ? Date.now() : base.getTime()) + RECORDING_RETENTION_MS);
}

async function backfillLegacyExpirationDates(): Promise<void> {
  // Legacy rows predate deletionStatus. Keep unexpired completed recordings
  // available until their calculated 30-day expiry; the normal sweep will
  // permanently delete them once that date arrives.
  await Recording.updateMany(
    { $or: [{ deletionStatus: null }, { deletionStatus: { $exists: false } }] },
    { $set: { deletionStatus: "active" } },
  );
  // Existing records did not have expiresAt. Anchor them to endedAt first,
  // then startedAt, then createdAt. MongoDB dates are absolute UTC instants.
  await Recording.updateMany(
    {
      status: { $in: ["ready", "failed", "declined"] },
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }],
    },
    [{
      $set: {
        expiresAt: {
          $add: [
            { $ifNull: ["$endedAt", { $ifNull: ["$startedAt", "$createdAt"] }] },
            RECORDING_RETENTION_MS,
          ],
        },
      },
    }],
  );
  await Recording.updateMany(
    {
      status: "uploading",
      endedAt: { $ne: null },
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }],
    },
    [{ $set: { expiresAt: { $add: ["$endedAt", RECORDING_RETENTION_MS] } } }],
  );
}

async function logRetentionEvent(action: string, recordingId: string, slug: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await PlatformEvent.create({ category: "recording", action, meetingSlug: slug, detail: { recordingId, ...detail } });
  } catch (error) {
    console.error(`[recording-retention] could not persist ${action} event`, error instanceof Error ? error.message : error);
  }
}

async function clearMeetingRecordingPointer(recording: { _id: unknown; meeting: unknown }): Promise<void> {
  await Meeting.updateOne(
    { _id: recording.meeting, activeRecordingId: recording._id },
    { $set: { recordingStatus: "idle" }, $unset: { activeRecordingId: 1 } },
  );
}

async function recordDeletionFailure(recording: any, error: unknown): Promise<void> {
  const attempts = Math.max(1, Number(recording.deletionAttempts || 1));
  const backoffMs = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempts, 10));
  const message = (error instanceof Error ? error.message : "Recording media deletion failed.").slice(0, 1000);
  await Recording.updateOne(
    { _id: recording._id },
    {
      $set: {
        deletionStatus: "delete_failed",
        deletionLeaseUntil: null,
        nextDeletionAttemptAt: new Date(Date.now() + backoffMs),
        lastDeletionError: message,
      },
    },
  );
  await logRetentionEvent("recording_deletion_failed", String(recording._id), recording.meetingSlug, { attempts, error: message, retryAfterMs: backoffMs });
  console.error("[recording-retention] deletion failed; scheduled retry", { recordingId: String(recording._id), attempts, error: message });
}

/**
 * Permanently deletes Cloudinary assets and every version/delete marker in the
 * B2 staging prefix. The row is removed only after every storage provider has
 * confirmed success. Re-running is safe when a provider already deleted an item.
 */
export async function permanentlyDeleteRecording(recordingId: string, actor?: { userId: string; displayName: string; reason: string }): Promise<boolean> {
  const now = new Date();
  const claimed = await Recording.findOneAndUpdate(
    {
      _id: recordingId,
      $or: [
        { status: { $nin: ["recording", "uploading", "consent_pending"] } },
        { status: "uploading", expiresAt: { $lte: now } },
      ],
      $and: [{ $or: [
        { deletionStatus: { $in: ["active", "delete_failed"] } },
        { deletionStatus: { $exists: false } },
        { deletionStatus: "deleting", deletionLeaseUntil: { $lte: now } },
      ] }],
    },
    { $set: { deletionStatus: "deleting", deletionLeaseUntil: new Date(now.getTime() + DELETE_LEASE_MS), nextDeletionAttemptAt: null }, $inc: { deletionAttempts: 1 } },
    { new: true },
  ).lean();
  if (!claimed) return false;

  try {
    await deleteRecordingMedia(claimed);
    // Clear the meeting reference before removing the recording row. If this
    // database write fails, the row remains leased/retryable and media deletion
    // is safe to repeat; it cannot leave a stale activeRecordingId behind.
    await clearMeetingRecordingPointer(claimed);
    const removed = await Recording.deleteOne({ _id: claimed._id, deletionStatus: "deleting" });
    if (removed.deletedCount !== 1) throw new Error("Recording metadata changed while permanent deletion was in progress.");
    await logRetentionEvent("recording_permanently_deleted", String(claimed._id), claimed.meetingSlug, {
      reason: actor?.reason || "retention_expired",
      actorId: actor?.userId || "system",
      actorName: actor?.displayName || "Recording retention worker",
    });
    return true;
  } catch (error) {
    await recordDeletionFailure(claimed, error);
    throw error;
  }
}

async function retryStagedRecordingUploads(): Promise<void> {
  const now = new Date();
  const maxAttempts = Math.max(1, Math.min(10, Number(process.env.RECORDING_UPLOAD_MAX_ATTEMPTS || 5)));
  const pending = await Recording.find({
    status: { $in: ["uploading", "failed"] },
    stagedAvailable: true,
    stagedKey: { $nin: [null, ""] },
    expiresAt: { $gt: now },
    uploadAttempts: { $lt: maxAttempts },
    $and: [
      { $or: [{ uploadLeaseUntil: null }, { uploadLeaseUntil: { $exists: false } }, { uploadLeaseUntil: { $lte: now } }] },
      { $or: [{ nextUploadAttemptAt: null }, { nextUploadAttemptAt: { $exists: false } }, { nextUploadAttemptAt: { $lte: now } }] },
    ],
  }).sort({ endedAt: 1 }).limit(3).select("_id").lean();

  // Claiming occurs atomically inside uploadCompletedRecording; these tasks are
  // launched without blocking the expiry sweep behind multi-GB media uploads.
  for (const recording of pending) {
    void uploadCompletedRecording(String(recording._id)).catch((error) => {
      console.error("[recording-retention] staged upload retry failed", { recordingId: String(recording._id), error: error instanceof Error ? error.message : error });
    });
  }
}

async function sweepExpiredRecordings(): Promise<void> {
  const now = new Date();
  await backfillLegacyExpirationDates();
  await retryStagedRecordingUploads();

  // Only terminal records are eligible. Active and in-progress egress/upload
  // jobs are never removed, even if their timestamps are unexpectedly old.
  for (let batch = 0; batch < 20; batch += 1) {
    const candidates = await Recording.find({
      status: { $in: ["ready", "failed", "declined", "uploading"] },
      expiresAt: { $lte: now },
      $or: [
        { deletionStatus: { $in: ["active", "delete_failed"] }, $or: [{ nextDeletionAttemptAt: null }, { nextDeletionAttemptAt: { $lte: now } }] },
        { deletionStatus: { $exists: false } },
        { deletionStatus: "deleting", deletionLeaseUntil: { $lte: now } },
      ],
    }).sort({ expiresAt: 1 }).limit(BATCH_SIZE).select("_id").lean();
    if (!candidates.length) break;
    let claimedCount = 0;
    for (const candidate of candidates) {
      try {
        const removed = await permanentlyDeleteRecording(String(candidate._id));
        if (removed) claimedCount += 1;
      } catch {
        // The failure has a persisted retry time and a system activity entry.
      }
    }
    if (claimedCount === 0) break;
  }
}

async function runSweep(force: boolean): Promise<void> {
  if (sweepPromise) return sweepPromise;
  if (!force && Date.now() - lastSweepAt < SWEEP_INTERVAL_MS - 1000) return;
  lastSweepAt = Date.now();
  sweepPromise = sweepExpiredRecordings()
    .catch((error) => {
      lastSweepAt = 0;
      console.error("[recording-retention] sweep failed", error instanceof Error ? error.message : error);
      throw error;
    })
    .finally(() => { sweepPromise = null; });
  return sweepPromise;
}

/** A protected endpoint can invoke this when a hosting free tier sleeps between requests. */
export function runRecordingRetentionSweep(): Promise<void> {
  return runSweep(true);
}

/** Run once a minute on the long-lived Render API process. DB leases make the sweep safe across replicas. */
export function startRecordingRetention(): void {
  void runSweep(false).catch(() => undefined);
  setInterval(() => { void runSweep(false).catch(() => undefined); }, SWEEP_INTERVAL_MS).unref();
}
