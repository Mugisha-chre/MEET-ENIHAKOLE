import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { EgressClient, EncodedFileOutput, EncodedFileType, EncodingOptionsPreset, S3Upload } from "livekit-server-sdk";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
      { layout: "grid", encodingOptions: EncodingOptionsPreset.H264_720P_30, webhooks: [{ url: callback, signingKey: apiKey }] },
    );
    recording.egressId = info.egressId;
    recording.stagedKey = key;
    recording.stagedAvailable = false;
    recording.status = "recording";
    recording.startedAt = new Date();
    recording.lastError = "";
    await recording.save();
    await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "recording", activeRecordingId: recording._id } });
  } catch (error) {
    recording.status = "failed";
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
  await recording.save();
  await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "uploading" } });
}

export async function uploadCompletedRecording(recordingId: string): Promise<void> {
  const recording = await Recording.findById(recordingId);
  if (!recording || recording.status === "ready" || !recording.stagedKey || !recording.stagedAvailable) return;
  const storage = getS3Config();
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!.trim();
  cloudinary.config({ cloud_name: cloudName, api_key: process.env.CLOUDINARY_API_KEY!.trim(), api_secret: process.env.CLOUDINARY_API_SECRET!.trim(), secure: true });
  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    forcePathStyle: storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secret },
  });
  try {
    recording.uploadAttempts += 1;
    recording.status = "uploading";
    recording.uploadProgressPercent = 0;
    await recording.save();
    const source = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: recording.stagedKey }));
    if (!source.Body) throw new Error("The completed recording was not found in staging storage.");
    const totalBytes = Number(source.ContentLength || recording.fileSize || 0);
    // Cloudinary's chunked upload ceiling is 20 GB per asset. Use decimal GB
    // so the configured limit cannot exceed the provider's documented cap.
    const configuredLimit = Number(process.env.RECORDING_MAX_FILE_BYTES || 20_000_000_000);
    const maxBytes = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, 20_000_000_000) : 20_000_000_000;
    if (totalBytes > maxBytes) throw new Error(`Recording exceeds the configured ${Math.round(maxBytes / 1_000_000_000)} GB file limit. The staged source has been retained.`);
    if (totalBytes > 0) recording.fileSize = totalBytes;
    await recording.save();

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

    // Stream the staged object directly into Cloudinary's chunked uploader.
    // This avoids requiring a multi-GB temporary disk allocation on the API host.
    const body = source.Body as NodeJS.ReadableStream & { on: (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void) => unknown };
    let transferred = 0;
    let lastReported = 0;
    body.on("data", (chunk) => {
      transferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (totalBytes > 0) {
        const progress = Math.min(99, Math.floor((transferred / totalBytes) * 100));
        if (progress >= lastReported + 5) {
          lastReported = progress;
          recording.uploadProgressPercent = progress;
          // $max prevents a late progress write from moving a completed upload backwards.
          void Recording.updateOne({ _id: recording._id }, { $max: { uploadProgressPercent: progress } }).catch(() => undefined);
        }
      }
    });

    let resolveUpload!: (result: any) => void;
    let rejectUpload!: (error: unknown) => void;
    const uploadResult = new Promise<any>((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
    const uploadStream = cloudinary.uploader.upload_chunked_stream(uploadOptions, (error, result) => {
      if (error) {
        rejectUpload(error);
        return;
      }
      // Chunked uploads can return intermediate done:false acknowledgements.
      // Do not expose the recording until Cloudinary confirms the final asset.
      if (result?.done === true) resolveUpload(result);
    });
    const [, uploaded] = await Promise.all([pipeline(body, uploadStream), uploadResult]);
    recording.cloudinaryPublicId = uploaded.public_id;
    recording.cloudinaryAssetId = uploaded.asset_id || "";
    recording.fileSize = Number(uploaded.bytes || 0);
    recording.durationSeconds = Number(uploaded.duration || 0) || (recording.startedAt && recording.endedAt ? Math.max(0, Math.round((recording.endedAt.getTime() - recording.startedAt.getTime()) / 1000)) : 0);
    recording.status = "ready";
    recording.uploadProgressPercent = 100;
    recording.lastError = "";
    await recording.save();
    await Meeting.updateOne({ _id: recording.meeting, activeRecordingId: recording._id }, { $set: { recordingStatus: "ready" } });
    // Cloudinary is now the playback source. Staging cleanup is best-effort and
    // must not turn a successfully uploaded recording into a failed recording.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: recording.stagedKey }));
      recording.stagedAvailable = false;
      await recording.save();
    } catch (cleanupError) {
      console.warn("[recording/staging-cleanup] retained staged source", cleanupError instanceof Error ? cleanupError.message : cleanupError);
    }
  } catch (error) {
    recording.status = "failed";
    recording.lastError = (error instanceof Error ? error.message : "The recording upload failed.").slice(0, 1000);
    await recording.save();
    await Meeting.updateOne({ _id: recording.meeting }, { $set: { recordingStatus: "failed" } });
    throw error;
  } finally {
    s3.destroy();
  }
}

export async function createAuthorizedPlaybackUrl(publicId: string): Promise<string> {
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME!.trim(), api_key: process.env.CLOUDINARY_API_KEY!.trim(), api_secret: process.env.CLOUDINARY_API_SECRET!.trim(), secure: true });
  return cloudinary.utils.private_download_url(publicId, "mp4", {
    resource_type: "video",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
  });
}

export async function deleteStagedRecording(recordingId: string): Promise<void> {
  const recording = await Recording.findById(recordingId).select("stagedKey");
  if (!recording?.stagedKey) return;
  const storage = getS3Config();
  const s3 = new S3Client({ region: storage.region, endpoint: storage.endpoint, forcePathStyle: storage.forcePathStyle, credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secret } });
  try { await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: recording.stagedKey })); }
  finally { s3.destroy(); }
}
