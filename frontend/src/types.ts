export interface User {
  id: string;
  displayName: string;
  email: string;
  picture?: string;
  isAdmin?: boolean;
  canCreateMeetings?: boolean;
}

export interface Meeting {
  id: string;
  slug: string;
  title: string;
  description: string;
  ownerName: string;
  ownerId: string;
  isOwner: boolean;
  isParticipant?: boolean;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
  meetingType: "meeting" | "prayer";
  visibility: "link" | "public";
  thumbnailUrl: string;
  status: "scheduled" | "live" | "ended" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  /** Trusted server timestamp, supplied by the invitation endpoint for start-time UI. */
  serverNow?: string;
}

export interface JoinSession {
  token: string;
  serverUrl: string;
  role: "host" | "participant";
  meeting: Meeting;
  participants?: { identity: string; name: string; picture: string; userId?: string; role?: "host" | "participant" }[];
  audio: boolean;
  video: boolean;
}


export interface PrivateMessage {
  id: string;
  senderUserId: string;
  recipientUserId: string;
  senderIdentity: string;
  recipientIdentity: string;
  senderName: string;
  recipientName: string;
  message: string;
  createdAt: string;
  recipientOnline?: boolean;
  recipientIdentities?: string[];
}


export interface PrivateConversationSummary {
  userId: string;
  name: string;
  picture: string;
  lastMessage: string;
  createdAt: string;
}
