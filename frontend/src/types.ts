export interface User {
  id: string;
  displayName: string;
  email: string;
  picture?: string;
}

export interface Meeting {
  id: string;
  slug: string;
  title: string;
  description: string;
  ownerName: string;
  ownerId: string;
  isOwner: boolean;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
  visibility: "link" | "public";
  thumbnailUrl: string;
  status: "scheduled" | "live" | "ended" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface JoinSession {
  token: string;
  serverUrl: string;
  role: "host" | "participant";
  meeting: Meeting;
  audio: boolean;
  video: boolean;
}
