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
    metadata: JSON.stringify({ displayName: input.displayName, role: input.role, picture: input.picture || "" }),
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
