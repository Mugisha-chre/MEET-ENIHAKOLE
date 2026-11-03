import crypto from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

const liveKitUrl = (): string => process.env.LIVEKIT_URL?.trim() || "";
const liveKitHttpUrl = (): string => liveKitUrl().replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
const liveKitKey = (): string => process.env.LIVEKIT_API_KEY?.trim() || "";
const liveKitSecret = (): string => process.env.LIVEKIT_API_SECRET?.trim() || "";

export function isLiveKitConfigured(): boolean {
  return Boolean(liveKitUrl() && liveKitKey() && liveKitSecret());
}

export function getLiveKitUrl(): string {
  return liveKitUrl();
}

export async function createJoinToken(input: {
  roomName: string;
  displayName: string;
  userId?: string;
  picture?: string;
  role: "host" | "participant";
  ttlSeconds?: number;
}): Promise<string> {
  if (!isLiveKitConfigured()) throw new Error("LiveKit is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to the API environment.");

  // A unique identity per connection prevents a second tab from evicting an existing connection.
  const identity = `${input.userId ? `user-${input.userId}` : "guest"}-${crypto.randomUUID()}`;
  const token = new AccessToken(liveKitKey(), liveKitSecret(), {
    identity,
    name: input.displayName,
    ttl: Math.max(60, Math.min(input.ttlSeconds ?? 4 * 60 * 60, 4 * 60 * 60)),
    metadata: JSON.stringify({ displayName: input.displayName, role: input.role, picture: input.picture || "", userId: input.userId || "" }),
  });
  token.addGrant({
    room: input.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}

/** Who is already in the room (name + photo + account identity), so the browser can load everyone before the person arrives. */
export async function listRoomPeople(roomName: string): Promise<Array<{ identity: string; name: string; picture: string; userId: string; role: "host" | "participant" }>> {
  if (!isLiveKitConfigured()) return [];
  try {
    const service = new RoomServiceClient(liveKitHttpUrl(), liveKitKey(), liveKitSecret());
    const found = await Promise.race([
      service.listParticipants(roomName),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    return found.map((item) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(item.metadata || "{}") as Record<string, unknown>; } catch { /* Metadata is optional. */ }
      const picture = typeof metadata.picture === "string" && metadata.picture.startsWith("https://") ? metadata.picture : "";
      return {
        identity: item.identity,
        name: item.name || (typeof metadata.displayName === "string" ? metadata.displayName : ""),
        picture,
        userId: typeof metadata.userId === "string" ? metadata.userId : "",
        role: metadata.role === "host" ? "host" : "participant",
      };
    });
  } catch { return []; }
}

export type LiveKitModerationAction = "mute-mic" | "disable-camera" | "remove";

/** Host-authorized moderation primitives. The API route verifies ownership before calling this helper. */
export async function moderateLiveKitParticipant(roomName: string, identity: string, action: LiveKitModerationAction): Promise<{ found: boolean; userId: string }> {
  if (!isLiveKitConfigured()) throw new Error("LiveKit is not configured.");
  const service = new RoomServiceClient(liveKitHttpUrl(), liveKitKey(), liveKitSecret());
  const people = await service.listParticipants(roomName);
  const target = people.find((person) => person.identity === identity);
  if (!target) return { found: false, userId: "" };
  let userId = "";
  try {
    const metadata = JSON.parse(target.metadata || "{}") as { userId?: unknown };
    if (typeof metadata.userId === "string") userId = metadata.userId;
  } catch { /* Older connections may not have account metadata. */ }

  if (action === "remove") {
    await service.removeParticipant(roomName, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
    return { found: true, userId };
  }

  // LiveKit's protobuf enums are TrackType AUDIO=0/VIDEO=1 and
  // TrackSource CAMERA=1/MICROPHONE=2. Prefer the source so a camera action
  // never mutes screen sharing (and a mic action never mutes screen-share audio).
  const trackType = action === "mute-mic" ? 0 : 1;
  const trackSource = action === "mute-mic" ? 2 : 1;
  const tracks = target.tracks.filter((track) =>
    Number(track.source) === trackSource || (Number(track.source) === 0 && Number(track.type) === trackType),
  );
  if (!tracks.length) return { found: true, userId };
  const muted = action === "mute-mic" || action === "disable-camera";
  await Promise.all(tracks.map((track) => service.mutePublishedTrack(roomName, identity, track.sid, muted)));
  return { found: true, userId };
}

export async function closeLiveKitRoom(roomName: string): Promise<void> {
  if (!isLiveKitConfigured()) return;
  try {
    const service = new RoomServiceClient(liveKitHttpUrl(), liveKitKey(), liveKitSecret());
    await service.deleteRoom(roomName);
  } catch (error) {
    // The end-meeting action remains idempotent if the room already disappeared.
    console.warn(`[livekit] Could not delete room ${roomName}; continuing`, error instanceof Error ? error.message : "unknown error");
  }
}
