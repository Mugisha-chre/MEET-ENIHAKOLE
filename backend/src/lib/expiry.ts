import { Meeting } from "../models/Meeting.js";
import { closeLiveKitRoom } from "./livekit.js";

const MINUTE = 60_000;
/** A live room may run this long past its planned end before the server closes it (same rule used when joining). */
const LIVE_GRACE_MS = 30 * MINUTE;
const MIN_GAP_MS = 15_000;
let lastRun = 0;
let running: Promise<void> | null = null;

/** Marks every meeting whose time has passed as ended, so it is never listed as upcoming or live. Runs on the server, no click needed. */
export async function expireStaleMeetings(): Promise<void> {
  const now = new Date();
  // Scheduled meetings whose whole time slot is over and that were never started.
  await Meeting.updateMany(
    { status: "scheduled", $expr: { $lt: [{ $add: ["$startsAt", { $multiply: ["$durationMinutes", MINUTE] }] }, now] } },
    { $set: { status: "ended", endedAt: now } },
  );
  // Live meetings that ran past their planned end plus the grace period: end them and close the call room.
  const stale = await Meeting.find({
    status: "live",
    $expr: { $lt: [{ $add: [{ $ifNull: ["$startedAt", "$startsAt"] }, { $multiply: ["$durationMinutes", MINUTE] }, LIVE_GRACE_MS] }, now] },
  }).select("_id slug").lean();
  if (stale.length === 0) return;
  await Meeting.updateMany({ _id: { $in: stale.map((meeting) => meeting._id) }, status: "live" }, { $set: { status: "ended", endedAt: now } });
  await Promise.all(stale.map((meeting) => closeLiveKitRoom(`eni-${meeting.slug}`)));
}

/** Cheap to call from any request: runs at most every 15 seconds and never throws. Works on hosts that cannot keep a timer alive. */
export async function expireStaleMeetingsThrottled(): Promise<void> {
  if (running) return running;
  if (Date.now() - lastRun < MIN_GAP_MS) return;
  lastRun = Date.now();
  running = expireStaleMeetings()
    .catch((error) => { lastRun = 0; console.warn("[expiry] sweep failed", error instanceof Error ? error.message : error); })
    .finally(() => { running = null; });
  return running;
}

/** Background sweep once a minute on a normal server process. */
export function startMeetingExpiry(): void {
  void expireStaleMeetingsThrottled();
  setInterval(() => { void expireStaleMeetingsThrottled(); }, MINUTE).unref();
}
