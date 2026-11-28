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
  userAgent?: string;
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
    metadata: JSON.stringify({ displayName: input.displayName, role: input.role, picture: input.picture || "", userId: input.userId || "", userAgent: String(input.userAgent || "").slice(0, 400) }),
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

type RoomPerson = { identity: string; name: string; picture: string; userId: string; userAgent: string; role: "host" | "participant" };
let sharedRoomService: RoomServiceClient | null = null;
function roomService(): RoomServiceClient {
  if (!sharedRoomService) sharedRoomService = new RoomServiceClient(liveKitHttpUrl(), liveKitKey(), liveKitSecret());
  return sharedRoomService;
}
// Many people joining and polling at once used to make one LiveKit API call each, which LiveKit answers with "Too many requests".
// Results are now shared per room for a moment and identical in-flight lookups are merged into a single call.
const ROOM_PEOPLE_TTL_MS = 2_500;
const roomPeopleCache = new Map<string, { at: number; people: RoomPerson[] }>();
const roomPeopleInFlight = new Map<string, Promise<RoomPerson[]>>();

/** Who is already in the room (name + photo + account identity), so the browser can load everyone before the person arrives. */
export async function listRoomPeople(roomName: string, options: { fresh?: boolean } = {}): Promise<RoomPerson[]> {
  if (!isLiveKitConfigured()) return [];
  const cached = roomPeopleCache.get(roomName);
  if (!options.fresh && cached && Date.now() - cached.at < ROOM_PEOPLE_TTL_MS) return cached.people;
  const running = roomPeopleInFlight.get(roomName);
  if (running) return running;
  const lookup = (async (): Promise<RoomPerson[]> => {
    try {
      const found = await Promise.race([
        roomService().listParticipants(roomName),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      const people = found.map((item) => {
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(item.metadata || "{}") as Record<string, unknown>; } catch { /* Metadata is optional. */ }
        const picture = typeof metadata.picture === "string" && metadata.picture.startsWith("https://") ? metadata.picture : "";
        return {
          identity: item.identity,
          name: item.name || (typeof metadata.displayName === "string" ? metadata.displayName : ""),
          picture,
          userId: typeof metadata.userId === "string" ? metadata.userId : "",
          userAgent: typeof metadata.userAgent === "string" ? metadata.userAgent.slice(0, 400) : "",
          role: (metadata.role === "host" ? "host" : "participant") as "host" | "participant",
        };
      });
      roomPeopleCache.set(roomName, { at: Date.now(), people });
      if (roomPeopleCache.size > 500) { const oldest = roomPeopleCache.keys().next().value; if (oldest) roomPeopleCache.delete(oldest); }
      return people;
    } catch {
      // A busy or briefly unreachable LiveKit API must never break joining: reuse the last known list.
      return cached?.people ?? [];
    } finally { roomPeopleInFlight.delete(roomName); }
  })();
  roomPeopleInFlight.set(roomName, lookup);
  return lookup;
}

export type LiveKitModerationAction = "mute-mic" | "disable-camera" | "remove";

/** Host-authorized moderation primitives. The API route verifies ownership before calling this helper. */
export async function moderateLiveKitParticipant(roomName: string, identity: string, action: LiveKitModerationAction): Promise<{ found: boolean; userId: string }> {
  if (!isLiveKitConfigured()) throw new Error("LiveKit is not configured.");
  const service = roomService();
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
    const service = roomService();
    await service.deleteRoom(roomName);
  } catch (error) {
    // The end-meeting action remains idempotent if the room already disappeared.
    console.warn(`[livekit] Could not delete room ${roomName}; continuing`, error instanceof Error ? error.message : "unknown error");
  }
}
