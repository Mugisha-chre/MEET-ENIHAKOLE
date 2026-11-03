import type { JoinSession, Meeting, PrivateConversationSummary, PrivateMessage, User } from "./types";

const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:4000/api").replace(/\/$/, "");
const AUTH_KEY = "meet-enihakole-auth-token";
const GUEST_AUTH_KEY = "meet-enihakole-guest-token";
const GUEST_PROFILE_KEY = "meet-enihakole-guest-profile";

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(GUEST_AUTH_KEY);
}

export function getRegisteredAuthToken(): string | null {
  return localStorage.getItem(AUTH_KEY);
}

export function saveAuthToken(token: string): void {
  localStorage.setItem(AUTH_KEY, token);
  sessionStorage.removeItem(GUEST_AUTH_KEY);
  sessionStorage.removeItem(GUEST_PROFILE_KEY);
}

export function saveGuestAuthToken(token: string, profile: { guestId: string; displayName: string; meetingSlug: string }): void {
  sessionStorage.setItem(GUEST_AUTH_KEY, token);
  sessionStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(profile));
}

export function getGuestProfile(meetingSlug?: string): { guestId: string; displayName: string; meetingSlug: string } | null {
  try {
    const value = sessionStorage.getItem(GUEST_PROFILE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as { guestId?: unknown; displayName?: unknown; meetingSlug?: unknown };
    if (typeof parsed.guestId !== "string" || typeof parsed.displayName !== "string" || typeof parsed.meetingSlug !== "string") return null;
    if (meetingSlug && parsed.meetingSlug !== meetingSlug) return null;
    return { guestId: parsed.guestId, displayName: parsed.displayName, meetingSlug: parsed.meetingSlug };
  } catch { return null; }
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(GUEST_AUTH_KEY);
  sessionStorage.removeItem(GUEST_PROFILE_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

// Wakes a sleeping API host in the background so the first real request is not the one that waits for it.
export function warmServer(): void {
  try {
    void fetch(`${API_BASE.replace(/\/api$/, "")}/health`, { mode: "no-cors", cache: "no-store" }).catch(() => { /* Best effort only. */ });
  } catch { /* Best effort only. */ }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new Error("We could not reach the server. Check your connection and try again.");
  }

  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status}).`, response.status);
  return payload as T;
}

export const api = {
  googleSignIn: (credential: string) =>
    request<{ token: string; user: User }>("/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
  me: () => request<{ user: User }>("/auth/me"),
  sessionHeartbeat: () => request<{ success: boolean }>("/auth/session-heartbeat", { method: "POST" }),
  logout: () => request<{ success: boolean }>("/auth/logout", { method: "POST" }),
  myMeetings: () => request<{ meetings: Meeting[] }>("/meetings/mine"),
  publicMeetings: () => request<{ meetings: Meeting[] }>("/meetings/public"),
  meeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}`),
  uploadMeetingThumbnail: (dataUrl: string) => request<{ secureUrl: string; publicId?: string }>("/meetings/thumbnail-upload", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  }),
  createMeeting: (input: {
    title: string;
    description: string;
    startsAt: string;
    durationMinutes: number;
    timezone: string;
    visibility: "link" | "public";
    thumbnailUrl: string;
  }) => request<{ meeting: Meeting; shareUrl: string }>("/meetings", { method: "POST", body: JSON.stringify(input) }),
  guestSession: (slug: string, displayName: string) => request<{ token: string; guestId: string; displayName: string; isGuest: true }>(`/meetings/${encodeURIComponent(slug)}/guest-session`, { method: "POST", body: JSON.stringify({ displayName }) }),
  join: (slug: string) =>
    request<Omit<JoinSession, "audio" | "video">>(`/meetings/${encodeURIComponent(slug)}/token`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  endMeeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}/end`, { method: "POST" }),
  cancelMeeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}/cancel`, { method: "POST" }),
  registerParticipantProfile: (slug: string, identity: string) =>
    request<{ success: boolean }>(`/meetings/${encodeURIComponent(slug)}/participant-profile`, { method: "POST", body: JSON.stringify({ identity }) }),
  leaveParticipantProfile: (slug: string, identity: string) =>
    request<{ success: boolean }>(`/meetings/${encodeURIComponent(slug)}/participant-leave`, { method: "POST", body: JSON.stringify({ identity }) }),
  moderateParticipant: (slug: string, identity: string, action: "mute-mic" | "disable-camera" | "remove" | "ban" | "request-unmute" | "request-camera") =>
    request<{ success: boolean; action: string; message: string; removedSessions?: number }>(`/meetings/${encodeURIComponent(slug)}/moderation`, {
      method: "POST", body: JSON.stringify({ identity, action }),
    }),
  privateConversations: (slug: string) =>
    request<{ conversations: PrivateConversationSummary[] }>(`/meetings/${encodeURIComponent(slug)}/private-conversations`),
  privateMessages: (slug: string, otherUserId: string) =>
    request<{ messages: PrivateMessage[] }>(`/meetings/${encodeURIComponent(slug)}/private-messages/${encodeURIComponent(otherUserId)}`),
  startRecording: (slug: string) => request<{ recording: { id: string; status: string; consents: Array<{ displayName: string; decision: string }> } }>(`/meetings/${encodeURIComponent(slug)}/recording/start`, { method: "POST" }),
  recordingStatus: (slug: string, identity: string) => request<{ recording: null | { id: string; status: string; hostName: string; consents: Array<{ displayName: string; identity: string; decision: string }>; myDecision: string; startedAt: string | null; endedAt: string | null; uploadProgressPercent: number; lastError: string; canRetry: boolean }; meetingStatus: string }>(`/meetings/${encodeURIComponent(slug)}/recording/status?identity=${encodeURIComponent(identity)}`),
  recordingConsent: (slug: string, recordingId: string, identity: string, accepted: boolean) => request<{ success: boolean; status: string }>(`/meetings/${encodeURIComponent(slug)}/recording/consent`, { method: "POST", body: JSON.stringify({ recordingId, identity, accepted }) }),
  stopRecording: (slug: string) => request<{ success: boolean; status: string }>(`/meetings/${encodeURIComponent(slug)}/recording/stop`, { method: "POST" }),
  retryRecording: (slug: string) => request<{ success: boolean; status: string }>(`/meetings/${encodeURIComponent(slug)}/recording/retry`, { method: "POST" }),
  myRecordings: () => request<{ recordings: Array<{ id: string; meetingSlug: string; meetingTitle: string; hostName: string; participants: Array<{ displayName: string; isGuest: boolean }>; startedAt: string | null; endedAt: string | null; durationSeconds: number; fileSize: number; status: string }> }>("/recordings/mine"),
  recordingPlayback: (id: string) => request<{ playbackUrl: string; expiresInSeconds: number }>(`/recordings/${encodeURIComponent(id)}/playback`),
  pageView: (path: string, pageLoad = false) => request<{ accepted: boolean }>("/analytics/page-view", { method: "POST", body: JSON.stringify({ path, pageLoad }) }),
  adminOverview: () => request<any>("/admin/overview"),
  adminMeetings: () => request<any>("/admin/meetings?limit=500"),
  adminAttendance: (slug: string) => request<any>(`/admin/meetings/${encodeURIComponent(slug)}/attendance`),
  adminTerminateMeeting: (slug: string) => request<{ success: boolean }>(`/admin/meetings/${encodeURIComponent(slug)}/terminate`, { method: "POST" }),
  adminUsers: (q = "") => request<any>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  adminSetUserStatus: (id: string, status: "active" | "suspended") => request<{ success: boolean }>(`/admin/users/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  adminRecordings: () => request<any>("/admin/recordings"),
  adminActivity: () => request<any>("/admin/activity?limit=150"),
  sendPrivateMessage: (slug: string, recipientUserId: string, message: string) =>
    request<{ message: PrivateMessage }>(`/meetings/${encodeURIComponent(slug)}/private-messages`, {
      method: "POST", body: JSON.stringify({ recipientUserId, message }),
    }),
};
