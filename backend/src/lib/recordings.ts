import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { EgressClient, EncodedFileOutput, EncodedFileType, EncodingOptionsPreset, S3Upload, WebhookConfig } from "livekit-server-sdk";
import { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { v2 as cloudinary } from "cloudinary";
import { Recording } from "../models/Recording.js";
import { Meeting } from "../models/Meeting.js";

function getS3Config() {
  const bucket = process.env.RECORDING_S3_BUCKET?.trim();
  const accessKey = process.env.RECORDING_S3_ACCESS_KEY?.trim();
  const secret = process.env.RECORDING_S3_SECRET?.trim();
  const region = process.env.RECORDING_S3_REGION?.trim() || "us-east-1";
  if (!bucket || !accessKey || !secret) throw new Error("Recording staging storage is not configured. Set RECORDING_S3_BUCKET, RECORDING_S3_ACCESS_KEY and RECORDING_S3_SECRET.");
  return { bucket, accessKey, secret, region, endpoint: process.env.RECORDING_S3_ENDPOINT?.trim() || undefined, forcePathStyle: process.env.RECORDING_S3_FORCE_PATH_STYLE === "true" };
}

function egressClient(): EgressClient {
  const url = process.env.LIVEKIT_URL?.trim().replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !key || !secret) throw new Error("LiveKit egress is not configured.");
  return new EgressClient(url, key, secret);
}

export function isRecordingConfigured(): boolean {
  return Boolean(
    process.env.LIVEKIT_URL?.trim() && process.env.LIVEKIT_API_KEY?.trim() && process.env.LIVEKIT_API_SECRET?.trim()
    && process.env.RECORDING_S3_BUCKET?.trim() && process.env.RECORDING_S3_ACCESS_KEY?.trim() && process.env.RECORDING_S3_SECRET?.trim()
    && process.env.CLOUDINARY_CLOUD_NAME?.trim() && process.env.CLOUDINARY_API_KEY?.trim() && process.env.CLOUDINARY_API_SECRET?.trim()
    && process.env.API_PUBLIC_URL?.trim(),
  );
}

export async function startRoomRecording(recordingId: string): Promise<void> {
  const recording = await Recording.findById(recordingId);
  if (!recording) throw new Error("Recording request was not found.");
  if (recording.consents.some((entry: any) => entry.decision !== "accepted")) throw new Error("Every connected participant must consent before recording begins.");
  const storage = getS3Config();
  const key = `meet-enihakole/recordings/${recording.meetingSlug}/${recording._id}-${crypto.randomUUID()}.mp4`;
  const apiKey = process.env.LIVEKIT_API_KEY!.trim();
  const callback = `${process.env.API_PUBLIC_URL!.trim().replace(/\/$/, "")}/api/webhooks/livekit`;
  const file = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: key,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: storage.accessKey,
        secret: storage.secret,
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  });
  try {
    const info = await egressClient().startRoomCompositeEgress(
      `eni-${recording.meetingSlug}`,
      { file },
      { layout: "grid", encodingOptions: EncodingOptionsPreset.H264_720P_30, webhooks: [new WebhookConfig({ url: callback, signingKey: apiKey })] },
    );
    recording.egressId = info.egressId;
    recording.stagedKey = key;
    recording.stagedAvailable = false;
    recording.status = "recording";
    recording.startedAt = new Date();
    recording.endedAt = null;
    recording.expiresAt = null;
    recording.deletionStatus = "active";
    recording.lastError = "";
    await recording.save();
    await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "recording", activeRecordingId: recording._id } });
  } catch (error) {
    if (recording.egressId) {
      await egressClient().stopEgress(recording.egressId).catch((stopError) => console.warn("[recording/start-cleanup] could not stop partially started egress", stopError instanceof Error ? stopError.message : stopError));
    }
    recording.status = "failed";
    const failedAt = recording.endedAt || new Date();
    recording.endedAt = failedAt;
    recording.expiresAt = new Date(failedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    recording.lastError = (error instanceof Error ? error.message : "LiveKit could not start room recording.").slice(0, 1000);
    await recording.save();
    await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "failed" } });
    throw error;
  }
}

export async function stopRoomRecording(recordingId: string): Promise<void> {
  const recording = await Recording.findById(recordingId);
  if (!recording) throw new Error("Recording was not found.");
  if (recording.status !== "recording" || !recording.egressId) return;
  await egressClient().stopEgress(recording.egressId);
  recording.status = "uploading";
  recording.endedAt = new Date();
  recording.expiresAt = new Date(recording.endedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  await recording.save();
  await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "uploading" } });
}

export async function uploadCompletedRecording(recordingId: string): Promise<void> {
  const now = new Date();
  const maxAttempts = Math.max(1, Math.min(10, Number(process.env.RECORDING_UPLOAD_MAX_ATTEMPTS || 5)));
  const leaseId = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + 45 * 60 * 1000);
  // The database lease prevents webhook retries and multiple API replicas from
  // uploading the same staged file concurrently. Expired leases are recoverable
  // after a process restart; retries overwrite the same authenticated asset ID.
  const recording = await Recording.findOneAndUpdate(
    {
      _id: recordingId,
      status: { $in: ["uploading", "failed"] },
      stagedAvailable: true,
      stagedKey: { $nin: [null, ""] },
      expiresAt: { $gt: now },
      uploadAttempts: { $lt: maxAttempts },
      $and: [
        { $or: [{ uploadLeaseUntil: null }, { uploadLeaseUntil: { $exists: false } }, { uploadLeaseUntil: { $lte: now } }] },
        { $or: [{ nextUploadAttemptAt: null }, { nextUploadAttemptAt: { $exists: false } }, { nextUploadAttemptAt: { $lte: now } }] },
      ],
    },
    {
      $set: { status: "uploading", uploadLeaseId: leaseId, uploadLeaseUntil: leaseUntil, nextUploadAttemptAt: null, uploadProgressPercent: 0 },
      $inc: { uploadAttempts: 1 },
    },
    { new: true },
  );
  if (!recording || !recording.stagedKey) return;

  let s3: S3Client | null = null;
  const leaseHeartbeat = setInterval(() => {
    void Recording.updateOne({ _id: recording._id, uploadLeaseId: leaseId }, { $set: { uploadLeaseUntil: new Date(Date.now() + 45 * 60 * 1000) } }).catch(() => undefined);
  }, 5 * 60 * 1000);
  leaseHeartbeat.unref();
  try {
    const storage = getS3Config();
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary credentials are not configured.");
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    s3 = new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secret },
    });
    const source = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: recording.stagedKey }));
    if (!source.Body) throw new Error("The completed recording was not found in staging storage.");
    const totalBytes = Number(source.ContentLength || recording.fileSize || 0);
    // Cloudinary's chunked upload ceiling is 20 GB per asset. Use decimal GB
    // so the configured limit cannot exceed the provider's documented cap.
    const configuredLimit = Number(process.env.RECORDING_MAX_FILE_BYTES || 20_000_000_000);
    const maxBytes = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, 20_000_000_000) : 20_000_000_000;
    if (totalBytes > maxBytes) throw new Error(`Recording exceeds the configured ${Math.round(maxBytes / 1_000_000_000)} GB file limit. The staged source has been retained.`);

    const publicId = `meet-enihakole/recordings/${recording.meetingSlug}/${recording._id}`;
    const uploadOptions = {
      resource_type: "video" as const,
      type: "authenticated",
      public_id: publicId,
      overwrite: true,
      chunk_size: 6_000_000,
      context: {
        meeting_slug: recording.meetingSlug,
        meeting_title: recording.meetingTitle.slice(0, 100),
        host_user_id: recording.hostUserId,
        recorded_at: (recording.startedAt || recording.createdAt).toISOString(),
      },
      tags: ["meet-enihakole", "meeting-recording"],
    };

    // Stream directly from B2 into Cloudinary; renew the lease as bytes arrive.
    const body = source.Body as NodeJS.ReadableStream & { on: (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void) => unknown };
    let transferred = 0;
    let lastReported = 0;
    body.on("data", (chunk) => {
      transferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (totalBytes > 0) {
        const progress = Math.min(99, Math.floor((transferred / totalBytes) * 100));
        if (progress >= lastReported + 5) {
          lastReported = progress;
          void Recording.updateOne({ _id: recording._id, uploadLeaseId: leaseId }, {
            $max: { uploadProgressPercent: progress },
            $set: { uploadLeaseUntil: new Date(Date.now() + 45 * 60 * 1000) },
          }).catch(() => undefined);
        }
      }
    });

    let resolveUpload!: (result: any) => void;
    let rejectUpload!: (error: unknown) => void;
    const uploadResult = new Promise<any>((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
    const uploadStream = cloudinary.uploader.upload_chunked_stream(uploadOptions, (error, result) => {
      if (error) { rejectUpload(error); return; }
      // Chunked uploads can return intermediate done:false acknowledgements.
      if (result?.done === true) resolveUpload(result);
    });
    const [, uploaded] = await Promise.all([pipeline(body, uploadStream), uploadResult]);
    const completedAt = new Date();
    const durationSeconds = Number(uploaded.duration || 0) || (recording.startedAt && recording.endedAt ? Math.max(0, Math.round((recording.endedAt.getTime() - recording.startedAt.getTime()) / 1000)) : 0);
    const completed = await Recording.updateOne(
      { _id: recording._id, uploadLeaseId: leaseId },
      {
        $set: {
          cloudinaryPublicId: uploaded.public_id,
          cloudinaryAssetId: uploaded.asset_id || "",
          fileSize: Number(uploaded.bytes || 0),
          durationSeconds,
          status: "ready",
          expiresAt: recording.expiresAt || new Date((recording.endedAt || completedAt).getTime() + 30 * 24 * 60 * 60 * 1000),
          uploadProgressPercent: 100,
          lastError: "",
          uploadLeaseUntil: null,
          nextUploadAttemptAt: null,
          uploadLeaseId: "",
        },
      },
    );
    if (completed.modifiedCount !== 1) throw new Error("The recording upload lease expired before completion could be saved.");
    await Meeting.updateOne({ _id: recording.meeting, activeRecordingId: recording._id }, { $set: { recordingStatus: "ready" } });

    // Cloudinary is now the playback source. Staging cleanup is best-effort;
    // retention removes all B2 versions/delete markers even if this fails.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: recording.stagedKey }));
      await Recording.updateOne({ _id: recording._id }, { $set: { stagedAvailable: false } });
    } catch (cleanupError) {
      console.warn("[recording/staging-cleanup] retained staged source", cleanupError instanceof Error ? cleanupError.message : cleanupError);
    }
  } catch (error) {
    const attempts = Number(recording.uploadAttempts || 1);
    const retryable = attempts < maxAttempts && Boolean(recording.expiresAt && recording.expiresAt.getTime() > Date.now());
    const retryDelayMs = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(0, attempts - 1), 8));
    const message = (error instanceof Error ? error.message : "The recording upload failed.").slice(0, 1000);
    const failed = await Recording.updateOne(
      { _id: recording._id, uploadLeaseId: leaseId },
      {
        $set: {
          status: "failed",
          lastError: message,
          uploadLeaseUntil: null,
          uploadLeaseId: "",
          nextUploadAttemptAt: retryable ? new Date(Date.now() + retryDelayMs) : null,
        },
      },
    );
    if (failed.modifiedCount === 1) await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "failed" } });
    console.error("[recording/upload] upload failed; retry scheduled when possible", { recordingId: String(recording._id), attempts, retryable, leaseStillOwned: failed.modifiedCount === 1, error: message });
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    s3?.destroy();
  }
}

export async function createAuthorizedPlaybackUrl(publicId: string, recordingExpiresAt: Date): Promise<string> {
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME!.trim(), api_key: process.env.CLOUDINARY_API_KEY!.trim(), api_secret: process.env.CLOUDINARY_API_SECRET!.trim(), secure: true });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const retentionExpirySeconds = Math.floor(recordingExpiresAt.getTime() / 1000);
  const linkExpirySeconds = Math.min(nowSeconds + 5 * 60, retentionExpirySeconds);
  if (linkExpirySeconds <= nowSeconds) throw new Error("The recording retention period has expired.");
  return cloudinary.utils.private_download_url(publicId, "mp4", {
    resource_type: "video",
    type: "authenticated",
    expires_at: linkExpirySeconds,
  });
}

function makeStorageClient(storage: ReturnType<typeof getS3Config>): S3Client {
  return new S3Client({ region: storage.region, endpoint: storage.endpoint, forcePathStyle: storage.forcePathStyle, credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secret } });
}

/** Permanently removes every object version and delete marker for this recording's B2 staging key prefix. */
async function permanentlyDeleteStagedVersions(recording: { stagedKey?: string; meetingSlug: string; _id: unknown }): Promise<void> {
  const storage = getS3Config();
  const s3 = makeStorageClient(storage);
  const id = String(recording._id);
  // The broad ID prefix captures the MP4, thumbnails/posters, and other
  // generated variants. The exact stored key is also checked for recordings
  // created by older versions that used a different staging folder.
  const prefixes = [...new Set([
    `meet-enihakole/recordings/${recording.meetingSlug}/${id}`,
    recording.stagedKey || "",
  ].filter((value): value is string => Boolean(value)))];
  try {
    for (const prefix of prefixes) {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      // ListObjectVersions includes every live version and delete marker.
      // Delete those exact version IDs: a plain DeleteObject here would create
      // a fresh delete marker on B2 and defeat the permanent cleanup.
      for (let page = 0; page < 10_000; page += 1) {
        const listed = await s3.send(new ListObjectVersionsCommand({
          Bucket: storage.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 1000,
        }));
        const objects = [
          ...(listed.Versions || []).map((item) => ({ Key: item.Key!, VersionId: item.VersionId! })),
          ...(listed.DeleteMarkers || []).map((item) => ({ Key: item.Key!, VersionId: item.VersionId! })),
        ].filter((item) => Boolean(item.Key && item.VersionId));
        if (objects.length) {
          const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: objects, Quiet: true } }));
          if (deleted.Errors?.length) throw new Error(`B2 reported ${deleted.Errors.length} object-version deletion error(s).`);
        }
        if (!listed.IsTruncated) break;
        if (!listed.NextKeyMarker) throw new Error("B2 version listing was truncated without a continuation marker.");
        keyMarker = listed.NextKeyMarker;
        versionIdMarker = listed.NextVersionIdMarker;
        if (page === 9_999) throw new Error("B2 version listing exceeded the safety page limit.");
      }
    }
  } finally {
    s3.destroy();
  }
}

/** Delete Cloudinary source assets and B2 staging versions before database references are removed. */
export async function deleteRecordingMedia(recording: {
  _id: unknown; meetingSlug: string; stagedKey?: string; cloudinaryPublicId?: string; status?: string; uploadAttempts?: number;
}): Promise<void> {
  await permanentlyDeleteStagedVersions(recording);

  // The Cloudinary public ID is deterministic. If a process crashed after
  // Cloudinary committed an upload but before Mongo saved publicId, retry the
  // expected ID for completed or attempted uploads so no orphaned asset stays.
  const shouldCheckCloudinary = Boolean(recording.cloudinaryPublicId) || recording.status === "ready" || Number(recording.uploadAttempts || 0) > 0;
  if (shouldCheckCloudinary) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary credentials are required to permanently delete this recording asset.");
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const publicId = recording.cloudinaryPublicId || `meet-enihakole/recordings/${recording.meetingSlug}/${String(recording._id)}`;
    // Source deletion with invalidate also expires cached derived transformations.
    // Explicit legacy thumbnail/poster IDs cover previous upload conventions.
    const ids = [publicId, `${publicId}_thumbnail`, `${publicId}_poster`, `${publicId}/thumbnail`, `${publicId}/poster`];
    for (const resourceType of ["video", "image"] as const) {
      const result = await cloudinary.api.delete_resources(ids, { resource_type: resourceType, type: "authenticated", invalidate: true });
      const failures = Object.entries((result as any).deleted || {}).filter(([, status]) => status !== "deleted" && status !== "not_found");
      if (failures.length) throw new Error(`Cloudinary could not delete ${failures.length} ${resourceType} asset(s).`);
    }
  }
}

export async function deleteStagedRecording(recordingId: string): Promise<void> {
  const recording = await Recording.findById(recordingId).select("_id meetingSlug stagedKey cloudinaryPublicId").lean();
  if (!recording) return;
  await deleteRecordingMedia(recording);
}
