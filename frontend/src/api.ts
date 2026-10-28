import type { JoinSession, Meeting, User } from "./types";

const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:4000/api").replace(/\/$/, "");
const AUTH_KEY = "meet-enihakole-auth-token";

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_KEY);
}

export function saveAuthToken(token: string): void {
  localStorage.setItem(AUTH_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_KEY);
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
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload as T;
}

export const api = {
  register: (input: { displayName: string; email: string; password: string }) =>
    request<{ token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<{ token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: () => request<{ user: User }>("/auth/me"),
  myMeetings: () => request<{ meetings: Meeting[] }>("/meetings/mine"),
  publicMeetings: () => request<{ meetings: Meeting[] }>("/meetings/public"),
  meeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}`),
  thumbnailUploadSignature: () => request<{
    cloudName: string;
    apiKey: string;
    timestamp: number;
    uploadPreset: string;
    signature: string;
  }>("/meetings/thumbnail-signature", { method: "POST", body: JSON.stringify({}) }),
  createMeeting: (input: {
    title: string;
    description: string;
    startsAt: string;
    durationMinutes: number;
    timezone: string;
    visibility: "link" | "public";
    thumbnailUrl: string;
  }) => request<{ meeting: Meeting; shareUrl: string }>("/meetings", { method: "POST", body: JSON.stringify(input) }),
  join: (slug: string, displayName: string) =>
    request<Omit<JoinSession, "audio" | "video">>(`/meetings/${encodeURIComponent(slug)}/token`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),
  endMeeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}/end`, { method: "POST" }),
  cancelMeeting: (slug: string) => request<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(slug)}/cancel`, { method: "POST" }),
};
