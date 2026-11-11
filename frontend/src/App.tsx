import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject, type FormEvent, type ReactNode, type TouchEvent as ReactTouchEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { LiveKitRoom, ParticipantTile, RoomAudioRenderer, isTrackReference, useChat, useIsMuted, useLocalParticipant, useParticipants, useRoomContext, useTracks, VideoTrack, type TrackReference } from "@livekit/components-react";
import { ConnectionState, DisconnectReason, MediaDeviceFailure, ParticipantEvent, Room, RoomEvent, Track, VideoPresets, VideoQuality, type Participant, type RemoteParticipant, type RoomOptions, type VideoCaptureOptions } from "livekit-client";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, AudioLines, CalendarClock, CalendarDays, Check,
  CheckCircle2, CircleHelp, Clock3, Copy, DoorOpen, HeartHandshake, Home,
  Link2, LoaderCircle, LogIn, LogOut, Menu, Mic, Plus, Share2, ShieldCheck,
  Sparkles, Users, Video, VideoIcon, VideoOff, X, Sun, Moon, MessageCircle,
  Hand, Send, MonitorUp, MicOff, Maximize2, Minimize2, ChevronLeft, ChevronRight, Smile, ChevronDown, Download,
  MousePointer2, MoveUpRight, Eraser, Eye, EyeOff, PenLine, Undo2, Settings2,
  FileText, Bold, Italic, Underline, List, ListOrdered, Heading1, Heading2, IndentIncrease, IndentDecrease,
} from "lucide-react";
import { api, ApiError, clearAuthToken, getRegisteredAuthToken, getGuestProfile, saveAuthToken, saveGuestAuthToken, type MeetingNotesPayload } from "./api";
import { AdminCenterPage, AudioRecordingPlayer, RecordingsPage } from "./ManagementPages";
import { clearCachePrefix, patchCache, readCache, removeCache, writeCache } from "./cache";
import type { JoinSession, Meeting, PrivateConversationSummary, PrivateMessage, User } from "./types";
import { GoogleContinueButton, ProfilePhoto, googleSignOut, preloadPhoto, preloadPhotoBriefly } from "./google";

interface AppContextValue {
  user: User | null;
  meetings: Meeting[];
  publicMeetings: Meeting[];
  loadingMeetings: boolean;
  refreshMeetings: (force?: boolean) => Promise<void>;
  openAuth: () => void;
  completeAuth: (user: User, token: string) => void;
  openSchedule: (instant?: boolean) => void;
  signOut: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);
// Only an explicit choice (the sun/moon button) is remembered; otherwise the app follows the browser or device light/dark setting.
const THEME_STORAGE_KEY = "meet-enihakole-theme-choice";
// Recording UI is enabled for host-controlled, consent-gated audio-only capture.
const RECORDING_UI_ENABLED = true;

type VideoQualityMode = "auto" | "standard" | "480p" | "hd" | "fullhd";
type VideoQualityHeight = 360 | 480 | 720 | 1080;
const VIDEO_QUALITY_STORAGE_KEY = "meet-enihakole-video-quality";
const VIDEO_QUALITY_OPTIONS: Array<{ value: VideoQualityMode; label: string; detail: string; height: VideoQualityHeight }> = [
  { value: "auto", label: "Auto", detail: "Adapts to device and network", height: 720 },
  { value: "standard", label: "Standard · 360p", detail: "Lower data and CPU usage", height: 360 },
  { value: "480p", label: "Balanced · 480p", detail: "Clear video with moderate data use", height: 480 },
  { value: "hd", label: "HD · 720p", detail: "High-definition video", height: 720 },
  { value: "fullhd", label: "Full HD · 1080p", detail: "Requires a capable camera and connection", height: 1080 },
];

function readVideoQualityChoice(): VideoQualityMode {
  try {
    const stored = localStorage.getItem(VIDEO_QUALITY_STORAGE_KEY);
    return VIDEO_QUALITY_OPTIONS.some((option) => option.value === stored) ? stored as VideoQualityMode : "auto";
  } catch { return "auto"; }
}

function videoCaptureResolution(height: VideoQualityHeight) {
  if (height === 1080) return VideoPresets.h1080.resolution;
  if (height === 720) return VideoPresets.h720.resolution;
  if (height === 360) return VideoPresets.h360.resolution;
  return { width: 854, height: 480, frameRate: 24 };
}
function videoCaptureOptionsForTrack(
  track: { mediaStreamTrack: MediaStreamTrack },
  height: VideoQualityHeight,
): VideoCaptureOptions {
  // Keep the participant's selected physical camera when changing resolution.
  // Omitting deviceId during restartTrack can make the browser reacquire the
  // system-default camera instead of the one chosen in the device menu.
  const deviceId = track.mediaStreamTrack.getSettings().deviceId;
  return {
    resolution: videoCaptureResolution(height),
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function videoPublishingQuality(mode: VideoQualityMode): VideoQuality {
  if (mode === "standard") return VideoQuality.LOW;
  if (mode === "480p" || mode === "hd") return VideoQuality.MEDIUM;
  return VideoQuality.HIGH;
}

interface VideoStatsSnapshot {
  width: number;
  height: number;
  fps: number;
  bitrateBps: number;
  packetLossPercent: number | null;
  roundTripMs: number | null;
  limitation: string;
}

interface VideoStatsCounter { bytes: number; sampledAt: number }

async function readVideoStatsSnapshot(
  track: { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>; mediaStreamTrack?: MediaStreamTrack },
  direction: "outbound" | "inbound",
  previous?: VideoStatsCounter,
): Promise<{ snapshot: VideoStatsSnapshot; counter?: VideoStatsCounter } | null> {
  try {
    const report = await track.getRTCStatsReport?.();
    if (!report) return null;
    const rows = Array.from(report.values()) as unknown as Array<Record<string, unknown>>;
    const isVideo = (row: Record<string, unknown>) => row.kind === "video" || row.mediaType === "video";
    const mediaStats = rows.filter((row) => row.type === (direction === "outbound" ? "outbound-rtp" : "inbound-rtp") && isVideo(row) && row.isRemote !== true);
    const primary = mediaStats.sort((a, b) => {
      const aPixels = Number(a.frameWidth ?? 0) * Number(a.frameHeight ?? 0);
      const bPixels = Number(b.frameWidth ?? 0) * Number(b.frameHeight ?? 0);
      return bPixels - aPixels || Number(b.bytesSent ?? b.bytesReceived ?? 0) - Number(a.bytesSent ?? a.bytesReceived ?? 0);
    })[0];
    const remoteInbound = rows.find((row) => row.type === "remote-inbound-rtp" && isVideo(row) && row.id === primary?.remoteId)
      ?? rows.find((row) => row.type === "remote-inbound-rtp" && isVideo(row));
    const inboundLoss = direction === "inbound" ? primary : remoteInbound;
    const packetsLost = Number(inboundLoss?.packetsLost);
    const packetsReceived = Number(inboundLoss?.packetsReceived);
    const fractionLost = Number(inboundLoss?.fractionLost);
    const packetLossPercent = Number.isFinite(fractionLost) && fractionLost >= 0 && fractionLost <= 1
      ? fractionLost * 100
      : Number.isFinite(packetsLost) && Number.isFinite(packetsReceived) && packetsLost >= 0 && packetsReceived > 0
        ? (packetsLost / (packetsLost + packetsReceived)) * 100
        : null;
    const now = Date.now();
    const byteField = direction === "outbound" ? "bytesSent" : "bytesReceived";
    const bytes = mediaStats.reduce((total, row) => total + Number(row[byteField] ?? 0), 0);
    const elapsed = previous ? now - previous.sampledAt : 0;
    const bitrateBps = previous && elapsed > 0 && bytes >= previous.bytes ? ((bytes - previous.bytes) * 8 * 1000) / elapsed : 0;
    const settings = track.mediaStreamTrack?.getSettings?.();
    const width = Number(primary?.frameWidth ?? settings?.width ?? 0);
    const height = Number(primary?.frameHeight ?? settings?.height ?? 0);
    const fps = Number(primary?.framesPerSecond ?? 0);
    const candidate = rows.find((row) => row.type === "candidate-pair" && row.state === "succeeded" && (row.nominated === true || row.selected === true));
    const roundTripSeconds = Number(remoteInbound?.roundTripTime ?? candidate?.currentRoundTripTime);
    const limitation = typeof primary?.qualityLimitationReason === "string" ? primary.qualityLimitationReason : "unknown";
    return {
      snapshot: {
        width, height, fps,
        bitrateBps: Number.isFinite(bitrateBps) ? bitrateBps : 0,
        packetLossPercent,
        roundTripMs: Number.isFinite(roundTripSeconds) && roundTripSeconds >= 0 ? roundTripSeconds * 1000 : null,
        limitation,
      },
      counter: Number.isFinite(bytes) && bytes > 0 ? { bytes, sampledAt: now } : undefined,
    };
  } catch { return null; }
}

function formatVideoResolution(stats: VideoStatsSnapshot | null): string {
  return stats && stats.width > 0 && stats.height > 0 ? `${stats.width} × ${stats.height}` : "Waiting for video";
}

function formatVideoBitrate(value: number): string {
  if (!value) return "—";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1000)} kbps`;
}

function systemTheme(): "light" | "dark" {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  catch { return "light"; }
}
function storedThemeChoice(): "light" | "dark" | null {
  try { const choice = localStorage.getItem(THEME_STORAGE_KEY); return choice === "dark" || choice === "light" ? choice : null; }
  catch { return null; }
}
function getInitialTheme(): "light" | "dark" {
  return storedThemeChoice() ?? systemTheme();
}
let activeRoomSlugInApp: string | null = null;
function roomSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/room\/([^/]+)\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context is missing.");
  return value;
}

function formatDate(dateString: string, options: Intl.DateTimeFormatOptions = {}, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...options,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(dateString));
}

function formatTime(dateString: string, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}),
  }).format(new Date(dateString));
}


/** Builds a small dependency-free, multi-page PDF for meeting notes. */
function downloadMeetingNotesPdf(meetingTitle: string, meetingDate: string, noteTitle: string, html: string) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = parsed.body.firstElementChild;
  const blocks: Array<{ text: string; bold: boolean; size: number; gap: number }> = [];
  const nodeText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node instanceof Element && node.tagName === "BR") return "\n";
    return Array.from(node.childNodes).map(nodeText).join("");
  };
  const walk = (node: Node) => {
    if (node instanceof Element && ["H1", "H2", "H3", "P", "LI", "BLOCKQUOTE", "PRE"].includes(node.tagName)) {
      const text = nodeText(node).replace(/\s+/g, " ").trim();
      if (text) {
        const tag = node.tagName;
        const parentList = node instanceof Element ? node.parentElement : null;
        const ordered = tag === "LI" && parentList?.tagName === "OL";
        const listPosition = ordered && parentList ? Array.from(parentList.children).filter((child) => child.tagName === "LI").indexOf(node as Element) + 1 : 0;
        blocks.push({
          text: `${tag === "LI" ? (ordered ? `${listPosition}. ` : "• ") : tag === "BLOCKQUOTE" ? "> " : ""}${text}`,
          bold: tag === "H1" || tag === "H2" || tag === "H3",
          size: tag === "H1" ? 15 : tag === "H2" ? 13 : tag === "H3" ? 11 : 10,
          gap: tag === "H1" || tag === "H2" ? 9 : 4,
        });
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
    if (root) walk(root);
  if (blocks.length === 0 && root?.textContent?.trim()) {
    blocks.push({ text: root.textContent.trim(), bold: false, size: 10, gap: 4 });
  }
  const toAscii = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/•/g, "*").replace(/[^\x20-\x7e]/g, "?");
  const escapePdf = (value: string) => toAscii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const wrap = (value: string, limit = 88) => {
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= limit) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };
  const dateLabel = Number.isFinite(new Date(meetingDate).getTime())
    ? new Date(meetingDate).toLocaleString([], { dateStyle: "long", timeStyle: "short" })
    : "Date unavailable";
  const content: Array<{ text: string; bold: boolean; size: number; gap: number }> = [
    { text: meetingTitle || "Meeting", bold: true, size: 18, gap: 0 },
    { text: `Meeting date: ${dateLabel}`, bold: false, size: 9, gap: 10 },
    { text: noteTitle || "Meeting notes", bold: true, size: 14, gap: 14 },
    ...blocks,
  ];
  if (blocks.length === 0) content.push({ text: "No notes have been added yet.", bold: false, size: 10, gap: 5 });

  const pages: string[][] = [];
  let page: string[] = [];
  let y = 790;
  const lineHeightFor = (size: number) => Math.max(13, size + 4);
  const addText = (text: string, bold: boolean, size: number, gap: number) => {
    const safeLines = wrap(text, size >= 14 ? 66 : 88);
    if (y - gap < 52) { pages.push(page); page = []; y = 790; }
    y -= gap;
    for (const line of safeLines) {
      const lineHeight = lineHeightFor(size);
      if (y < 48) { pages.push(page); page = []; y = 790; }
      page.push(`/${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 48 ${y} Tm (${escapePdf(line)}) Tj`);
      y -= lineHeight;
    }
    y -= 2;
  };
  for (const item of content) addText(item.text, item.bold, item.size, item.gap);
  if (page.length || pages.length === 0) pages.push(page);

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = pages.map((_, index) => 5 + index * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  pages.forEach((commands, index) => {
    const pageId = 5 + index * 2;
    const contentId = pageId + 1;
    const heading = index === 0 ? "" : `BT /F2 9 Tf 48 812 Td (Meeting notes - continued) Tj ET\n`;
    const stream = `${heading}BT\n${commands.join("\n")}\nET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n%ENIHAKOLE\n";
  const offsets: number[] = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${(noteTitle || "meeting-notes").trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "meeting-notes"}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function meetingImage(meeting: Meeting) {
  return meeting.thumbnailUrl || "/og-default.png";
}

/** True once a meeting's time is over (same rule the server uses), so it stops looking upcoming or live without waiting for a refresh. */
function expireMeetingLocally(meeting: Meeting, now: number): Meeting {
  if (meeting.status !== "scheduled" && meeting.status !== "live") return meeting;
  const minute = 60_000;
  const over = meeting.status === "scheduled"
    ? now > new Date(meeting.startsAt).getTime() + meeting.durationMinutes * minute
    : now > new Date(meeting.startedAt || meeting.startsAt).getTime() + meeting.durationMinutes * minute + 30 * minute;
  return over ? { ...meeting, status: "ended", endedAt: meeting.endedAt || new Date(now).toISOString() } : meeting;
}

function getMeetingStateLabel(meeting: Meeting) {
  if (meeting.status === "live") return "Live now";
  if (meeting.status === "ended") return "Ended";
  if (meeting.status === "cancelled") return "Cancelled";
  if (meeting.status === "scheduled" && new Date(meeting.startsAt).getTime() <= Date.now()) return "Ready to join";
  return "Scheduled";
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => getRegisteredAuthToken() ? (readCache<User>("user")?.value ?? null) : null);
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [meetings, setMeetings] = useState<Meeting[]>(() => getRegisteredAuthToken() ? (readCache<Meeting[]>("mine")?.value ?? []) : []);
  const [publicMeetings, setPublicMeetings] = useState<Meeting[]>(() => readCache<Meeting[]>("public")?.value ?? []);
  const [loadingMeetings, setLoadingMeetings] = useState(() => !readCache("public") && !(getRegisteredAuthToken() && readCache("mine")));
  const lastMeetingsFetch = useRef(0);
  const initialPageLoad = useRef(true);
  const [clock, setClock] = useState(() => Date.now());
  const [authOpen, setAuthOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  // Keep the LiveKit room mounted outside the route tree so browsing other
  // parts of this SPA does not unmount the media session.
  const [activeRoomSlug, setActiveRoomSlug] = useState<string | null>(() => {
    activeRoomSlugInApp = roomSlugFromPath(location.pathname);
    return activeRoomSlugInApp;
  });
  const activeRoomVisible = activeRoomSlug !== null && roomSlugFromPath(location.pathname) === activeRoomSlug;

  useEffect(() => {
    const pageLoad = initialPageLoad.current;
    initialPageLoad.current = false;
    // Keep meeting identifiers out of analytics while still counting meeting-page traffic.
    const analyticsPath = location.pathname.replace(/^\/(room|meeting)\/[^/]+\/?$/, "/$1/:meeting");
    void api.pageView(analyticsPath, pageLoad).catch(() => undefined);
  }, [location.pathname]);

  useEffect(() => {
    if (!user) return;
    void api.sessionHeartbeat().catch(() => undefined);
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") void api.sessionHeartbeat().catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(heartbeat);
  }, [user?.id]);

  useEffect(() => {
    const onRoomOpened = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string }>).detail;
      if (typeof detail?.slug === "string" && detail.slug) {
        activeRoomSlugInApp = detail.slug;
        setActiveRoomSlug(detail.slug);
      }
    };
    const onRoomClosed = (event: Event) => {
      const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
      if (typeof slug !== "string" || !slug) return;
      if (activeRoomSlugInApp === slug) activeRoomSlugInApp = null;
      setActiveRoomSlug((current) => current === slug ? null : current);
    };
    window.addEventListener("meet-room-opened", onRoomOpened);
    window.addEventListener("meet-room-closed", onRoomClosed);
    return () => {
      window.removeEventListener("meet-room-opened", onRoomOpened);
      window.removeEventListener("meet-room-closed", onRoomClosed);
    };
  }, []);

  useEffect(() => {
    const routeSlug = roomSlugFromPath(location.pathname);
    if (routeSlug) {
      activeRoomSlugInApp = routeSlug;
      setActiveRoomSlug(routeSlug);
    }
  }, [location.pathname]);

  useEffect(() => {
    const previousRestoration = window.history.scrollRestoration;
    try { window.history.scrollRestoration = "manual"; } catch { /* Unsupported by older browsers. */ }
    return () => {
      try { window.history.scrollRestoration = previousRestoration; } catch { /* Ignore unsupported history controls. */ }
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Theme still applies for this session. */ }
      return next;
    });
  }, []);

  // Without a saved choice, follow the browser/device theme live (including when it switches while the app is open).
  useEffect(() => {
    let media: MediaQueryList;
    try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch { return; }
    const onChange = () => { if (!storedThemeChoice()) setTheme(media.matches ? "dark" : "light"); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let resetTimer = 0;
    const onScroll = () => {
      if (!document.documentElement.classList.contains("is-scrolling")) document.documentElement.classList.add("is-scrolling");
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => document.documentElement.classList.remove("is-scrolling"), 850);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", onScroll, true); window.clearTimeout(resetTimer); document.documentElement.classList.remove("is-scrolling"); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === "light" ? "#fbf7f2" : "#130d10";
  }, [theme]);

  // Cache-first: cached lists render instantly, then refresh quietly in the background (skipped if fetched moments ago).
  const refreshMeetings = useCallback(async (force = false) => {
    if (!force && Date.now() - lastMeetingsFetch.current < 30_000) return;
    lastMeetingsFetch.current = Date.now();
    if (getRegisteredAuthToken() && !readCache("mine")) setLoadingMeetings(true);
    const [mineResult, publicResult] = await Promise.allSettled([
      getRegisteredAuthToken() ? api.myMeetings() : Promise.resolve({ meetings: [] as Meeting[] }),
      api.publicMeetings(),
    ]);
    if (mineResult.status === "fulfilled") { setMeetings(mineResult.value.meetings); if (getRegisteredAuthToken()) writeCache("mine", mineResult.value.meetings); }
    else lastMeetingsFetch.current = 0;
    if (publicResult.status === "fulfilled") { setPublicMeetings(publicResult.value.meetings); writeCache("public", publicResult.value.meetings); }
    else lastMeetingsFetch.current = 0;
    setLoadingMeetings(false);
  }, []);

  // Instant, optimistic status changes (e.g. a host ends a meeting) applied to every list and cache, then reconciled with the server.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const { slug, patch } = (event as CustomEvent<{ slug: string; patch: Partial<Meeting> }>).detail;
      const apply = (list: Meeting[]) => list.map((item) => item.slug === slug ? { ...item, ...patch } : item);
      setMeetings(apply);
      setPublicMeetings(apply);
      patchCache<Meeting[]>((key) => key === "mine" || key === "public", apply);
      patchCache<Meeting>((key) => key.startsWith("meeting:") && key.endsWith(`:${slug}`), (item) => ({ ...item, ...patch }));
      void refreshMeetings(true);
    };
    window.addEventListener("meet-meeting-changed", onChanged);
    return () => window.removeEventListener("meet-meeting-changed", onChanged);
  }, [refreshMeetings]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      // Lists and the profile load in parallel; cached copies are already on screen.
      const listsLoad = refreshMeetings(true);
      if (getRegisteredAuthToken()) {
        try {
          const result = await api.me();
          if (!cancelled) { setUser(result.user); writeCache("user", result.user); }
        } catch (cause) {
          // Only drop the session when the server says it is invalid, never because the network was slow or unreachable.
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
            clearAuthToken(); removeCache("user"); removeCache("mine"); clearCachePrefix("admin:"); clearCachePrefix("recordings:"); clearCachePrefix("notes:");
            if (!cancelled) { setUser(null); setMeetings([]); }
          }
        }
      }
      await listsLoad;
    };
    void initialize();
    return () => { cancelled = true; };
  }, [refreshMeetings]);

  useEffect(() => {
    setMobileNavOpen(false);
    setAuthOpen(false);
    setScheduleOpen(false);
  }, [location.pathname]);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const openSchedule = useCallback((_instant = false) => {
    if (!user || (!user.canCreateMeetings && !user.isAdmin)) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Meeting creation is currently managed by the Super Admin." } }));
      return;
    }
    setScheduleOpen(true);
  }, [user]);
  const completeAuth = useCallback((nextUser: User, token: string) => {
    saveAuthToken(token);
    setUser(nextUser);
    writeCache("user", nextUser);
    setAuthOpen(false);
    void refreshMeetings(true);
  }, [refreshMeetings]);
  const signOut = useCallback(() => {
    void api.logout().catch(() => undefined);
    googleSignOut();
    clearAuthToken();
    removeCache("user"); removeCache("mine"); clearCachePrefix("meeting:"); clearCachePrefix("admin:"); clearCachePrefix("recordings:"); clearCachePrefix("notes:");
    setUser(null);
    setMeetings([]);
    void refreshMeetings(true);
  }, [refreshMeetings]);

  // Keep prayer availability and meeting-creation permission in sync. Re-check
  // immediately when a background tab becomes active, as well as periodically.
  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 20_000);
    const syncPermissionsAndMeetings = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMeetings(true);
      if (getRegisteredAuthToken()) {
        void api.me().then(({ user: latest }) => {
          setUser(latest);
          writeCache("user", latest);
          if (!latest.canCreateMeetings && !latest.isAdmin) setScheduleOpen(false);
        }).catch(() => undefined);
      }
    };
    const sync = window.setInterval(syncPermissionsAndMeetings, 20_000);
    document.addEventListener("visibilitychange", syncPermissionsAndMeetings);
    window.addEventListener("focus", syncPermissionsAndMeetings);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
      document.removeEventListener("visibilitychange", syncPermissionsAndMeetings);
      window.removeEventListener("focus", syncPermissionsAndMeetings);
    };
  }, [refreshMeetings]);
  // The discoverable workspace intentionally contains Online Prayers only.
  // Ordinary meetings are invitation-link only, even if stale local cache data exists.
  const liveMeetings = useMemo(() => meetings.filter((meeting) => meeting.meetingType === "prayer").map((meeting) => expireMeetingLocally(meeting, clock)), [meetings, clock]);
  const livePublicMeetings = useMemo(() => publicMeetings.filter((meeting) => meeting.meetingType === "prayer").map((meeting) => expireMeetingLocally(meeting, clock)), [publicMeetings, clock]);

  const contextValue = useMemo<AppContextValue>(() => ({
    user, meetings: liveMeetings, publicMeetings: livePublicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, theme, toggleTheme,
  }), [user, liveMeetings, livePublicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, theme, toggleTheme]);

  return (
    <AppContext.Provider value={contextValue}>
      <RouteScrollReset />
      <Routes>
        <Route path="/" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><Dashboard /></AppShell>} />
        <Route path="/meetings" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><MeetingsPage /></AppShell>} />
        <Route path="/recordings" element={RECORDING_UI_ENABLED ? <AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><RecordingsPage /></AppShell> : <Navigate to="/" replace />} />
        <Route path="/admin" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>{user?.isAdmin ? <AdminCenterPage /> : <Navigate to="/" replace />}</AppShell>} />
        <Route path="/share/:slug" element={<ShareRedirect />} />
        <Route path="/meeting/:slug" element={<MeetingPage />} />
        <Route path="/room/:slug" element={null} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {activeRoomSlug && <MeetingRoomPage key={activeRoomSlug} slug={activeRoomSlug} isActive={activeRoomVisible}/>}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthenticated={completeAuth} />}
      {scheduleOpen && user && (user.canCreateMeetings || user.isAdmin) && <ScheduleModal onClose={() => setScheduleOpen(false)} onCreated={(meeting) => {
        if (meeting.meetingType === "prayer") {
          const merge = (list: Meeting[]) => [meeting, ...list.filter((item) => item.slug !== meeting.slug)];
          setMeetings((current) => { const next = merge(current); writeCache("mine", next); return next; });
          setPublicMeetings((current) => { const next = merge(current); writeCache("public", next); return next; });
        }
        writeCache(`meeting:${user.id}:${meeting.slug}`, meeting);
        void refreshMeetings(true);
      }} />}
      {!location.pathname.startsWith("/room/") && !location.pathname.startsWith("/meeting/") && <InstallPwaButton />}
      <ToastHost />
    </AppContext.Provider>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useAppContext();
  const nextTheme = theme === "light" ? "dark" : "light";
  return <button type="button" className="icon-button theme-toggle" onClick={toggleTheme} title={`Switch to ${nextTheme} mode`} aria-label={`Switch to ${nextTheme} mode`} aria-pressed={theme === "dark"}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</button>;
}

type PwaPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function InstallPwaButton({ inline = false }: { inline?: boolean }) {
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const [deferred, setDeferred] = useState<PwaPromptEvent | null>(() => ((window as unknown as { __pwaPrompt?: PwaPromptEvent }).__pwaPrompt ?? null));
  const [installed, setInstalled] = useState(isStandalone);
  const [iosTip, setIosTip] = useState(false);
  const { pathname } = useLocation();
  const hasBottomNav = pathname === "/" || pathname === "/meetings" || pathname === "/recordings" || pathname === "/admin";
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  useEffect(() => {
    const onReady = () => setDeferred((window as unknown as { __pwaPrompt?: PwaPromptEvent }).__pwaPrompt ?? null);
    const onInstalled = () => { setInstalled(true); setDeferred(null); setIosTip(false); (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = undefined; };
    const media = window.matchMedia("(display-mode: standalone)");
    const onDisplay = () => setInstalled(isStandalone());
    window.addEventListener("pwa-prompt-ready", onReady);
    window.addEventListener("appinstalled", onInstalled);
    media.addEventListener("change", onDisplay);
    return () => { window.removeEventListener("pwa-prompt-ready", onReady); window.removeEventListener("appinstalled", onInstalled); media.removeEventListener("change", onDisplay); };
  }, []);

  if (installed || (!deferred && !isIos)) return null;

  const install = async () => {
    if (!deferred) { setIosTip((v) => !v); return; }
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
    } catch { /* Prompt can only be used once; wait for the browser to offer it again. */ }
    (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = undefined;
    setDeferred(null);
  };

  if (inline) return (
    <span className="pwa-install-inline">
      <button type="button" className="button button-soft button-small pwa-install-inline-button" onClick={() => void install()} title="Install app" aria-label="Install MEET ENIHAKOLE app"><Download size={15}/> Install App</button>
      {iosTip && <div className="pwa-install-tip pwa-install-tip-inline" role="status">To install, tap <b>Share</b> in Safari, then choose <b>Add to Home Screen</b>.<button type="button" onClick={() => setIosTip(false)} aria-label="Close"><X size={14}/></button></div>}
    </span>
  );

  return (
    <div className={`pwa-install ${hasBottomNav ? "" : "pwa-install-no-nav"}`}>
      {iosTip && <div className="pwa-install-tip" role="status">To install, tap <b>Share</b> in Safari, then choose <b>Add to Home Screen</b>.<button type="button" onClick={() => setIosTip(false)} aria-label="Close"><X size={14}/></button></div>}
      <button type="button" className="pwa-install-button" onClick={() => void install()} title="Install app" aria-label="Install MEET ENIHAKOLE app"><Download size={20}/><span>Install app</span></button>
    </div>
  );
}

function RouteScrollReset() {
  const location = useLocation();
  useLayoutEffect(() => {
    // Every route transition starts at the beginning of the destination page.
    // This intentionally includes browser back/forward (POP) navigation so a
    // previously scrolled page never reopens halfway down.
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll<HTMLElement>(".main-content").forEach((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    document.querySelectorAll<HTMLElement>(".conference-page, .standalone-state").forEach((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
  }, [location.key, location.pathname]);
  return null;
}

function AppShell({ children, mobileNavOpen, setMobileNavOpen }: { children: ReactNode; mobileNavOpen: boolean; setMobileNavOpen: (v: boolean) => void }) {
  const { user, openAuth, openSchedule, signOut } = useAppContext();
  const location = useLocation();
  const active = location.pathname === "/meetings" ? "meetings" : location.pathname === "/recordings" ? "recordings" : location.pathname === "/admin" ? "admin" : "home";
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const blocked = (target: EventTarget | null) => {
      let el = target instanceof Element ? target : null;
      while (el && el !== document.body) {
        if (el.matches("input, textarea, select, [contenteditable='true'], .modal-backdrop, .no-swipe")) return true;
        if (el.scrollWidth > el.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
        el = el.parentElement;
      }
      return false;
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || window.innerWidth > 720 || event.touches.length > 1) { start = null; return; }
      if (mobileNavOpen) { start = { x: touch.clientX, y: touch.clientY }; return; }
      start = blocked(event.target) ? null : { x: touch.clientX, y: touch.clientY };
    };
    const onEnd = (event: TouchEvent) => {
      if (!start || window.innerWidth > 720) { start = null; return; }
      const touch = event.changedTouches[0];
      if (!touch) { start = null; return; }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        if (!mobileNavOpen && dx > 0) setMobileNavOpen(true);
        if (mobileNavOpen && dx < 0) setMobileNavOpen(false);
      }
      start = null;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => { document.removeEventListener("touchstart", onStart); document.removeEventListener("touchend", onEnd); };
  }, [mobileNavOpen, setMobileNavOpen]);
  useEffect(() => {
    // Lets floating buttons (like Install app) tuck away underneath the open sidebar, then come back with the bottom nav.
    const root = document.documentElement;
    root.classList.toggle("mobile-nav-open", mobileNavOpen);
    return () => root.classList.remove("mobile-nav-open");
  }, [mobileNavOpen]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen, setMobileNavOpen]);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <Link className="brand-lockup" to="/" aria-label="MEET ENIHAKOLE home">
          <span className="brand-mark"><AudioLines size={23} strokeWidth={2.2} /></span>
          <span className="brand-words"><strong>MEET</strong><b>ENIHAKOLE</b><small>GATHER IN FAITH</small></span>
        </Link>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-navigation" aria-label="Main navigation">
          <Link to="/" className={`side-link ${active === "home" ? "side-link-active" : ""}`}><Home size={18} /><span>Home</span></Link>
          <Link to="/meetings" className={`side-link ${active === "meetings" ? "side-link-active" : ""}`}><CalendarDays size={18} /><span>Meetings & prayers</span></Link>
          {RECORDING_UI_ENABLED && <Link to="/recordings" className={`side-link ${active === "recordings" ? "side-link-active" : ""}`}><AudioLines size={18} /><span>Recorded meetings</span></Link>}
          {user?.isAdmin && <Link to="/admin" className={`side-link ${active === "admin" ? "side-link-active" : ""}`}><ShieldCheck size={18} /><span>Admin center</span></Link>}
        </nav>
        <div className="sidebar-bottom">
          {user && <div className="sidebar-account"><ProfilePhoto className="sidebar-account-photo" src={user.picture} name={user.displayName} size={160}/><span><b title={user.displayName}>{user.displayName}</b><small title={user.email}>{user.email}</small></span><button type="button" className="sidebar-signout" onClick={() => { setMobileNavOpen(false); signOut(); }} title="Sign out" aria-label="Sign out"><LogOut size={16}/><span>Sign out</span></button></div>}
          {!user && <div className="sidebar-signin-card"><span className="sidebar-signin-icon" aria-hidden="true"><LogIn size={18}/></span><span className="sidebar-signin-copy"><b>You're not signed in</b><small>Sign in to manage your meetings, recordings and profile.</small></span><button type="button" className="sidebar-signin-button" onClick={() => { setMobileNavOpen(false); openAuth(); }}><LogIn size={15}/><span>Sign in</span></button></div>}
          <button className="side-link quiet-link" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Help centre will be added in a future release." } }))}><CircleHelp size={18} /><span>Help & support</span></button>
          <div className="sidebar-version">MEET ENIHAKOLE <span>EARLY ACCESS</span></div>
        </div>
      </aside>
      <button type="button" className={`mobile-scrim ${mobileNavOpen ? "mobile-scrim-open" : ""}`} aria-label="Close navigation" aria-hidden={!mobileNavOpen} tabIndex={mobileNavOpen ? 0 : -1} onClick={() => setMobileNavOpen(false)} />
      <div className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>ENIHAKOLE CHOIR</span><span className="breadcrumb-slash">/</span><strong>{active === "meetings" ? "My meetings" : active === "recordings" ? "Recordings" : active === "admin" ? "System admin" : "Workspace"}</strong></div>
          <div className="topbar-actions">
            <button className="topbar-help" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Open Meetings to discover Online Prayers, or use a private invitation link to enter an ordinary meeting." } }))}><CircleHelp size={16} /><span>Need help?</span></button>
            <ThemeToggle />
            {user ? (
              <div className="profile-menu">
                <ProfilePhoto className="profile-avatar" src={user.picture} name={user.displayName} />
                <span className="profile-name">{user.displayName}</span>
                <button className="icon-button profile-signout" title="Sign out" aria-label="Sign out" onClick={signOut}><LogOut size={17} /></button>
              </div>
            ) : <button className="button button-soft button-small" onClick={openAuth}><LogIn size={16} /> Sign in</button>}
            {(user?.canCreateMeetings || user?.isAdmin) && <button className="button button-primary button-small topbar-create" onClick={() => openSchedule(false)}><Plus size={17} /> Create</button>}
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="page-footer"><span>© {new Date().getFullYear()} MEET ENIHAKOLE</span><span>Made for connection, prayer, and community</span></footer>
      </div>
      <nav className={`mobile-bottom-nav mbn-${active} ${(user?.canCreateMeetings || user?.isAdmin) ? "mbn-has-fab" : "mbn-nofab"}`} aria-label="Mobile navigation">
        <span className="mbn-bar" aria-hidden="true"/>
        <Link to="/" className={active === "home" ? "mobile-nav-active" : ""} aria-current={active === "home" ? "page" : undefined}><Home size={20}/><span>Home</span></Link>
        {(user?.canCreateMeetings || user?.isAdmin) ? <button type="button" className="mbn-fab" aria-label="Create meeting" onClick={() => openSchedule(false)}><Plus size={26} strokeWidth={2.4}/></button> : <Link to="/recordings" className={active === "recordings" ? "mobile-nav-active" : ""} aria-current={active === "recordings" ? "page" : undefined}><AudioLines size={20}/><span>Recorded</span></Link>}
        <Link to="/meetings" className={active === "meetings" ? "mobile-nav-active" : ""} aria-current={active === "meetings" ? "page" : undefined}><CalendarDays size={20}/><span>Meetings</span></Link>
      </nav>
    </div>
  );
}

function Dashboard() {
  const { user, meetings, publicMeetings, loadingMeetings, openSchedule } = useAppContext();
  const navigate = useNavigate();
  const upcoming = [...meetings, ...publicMeetings]
    .filter((meeting) => meeting.meetingType === "prayer")
    .filter((meeting, index, array) => array.findIndex((other) => other.slug === meeting.slug) === index)
    .filter((meeting) => meeting.status === "scheduled" || meeting.status === "live")
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    .slice(0, 3);
  const liveCount = upcoming.filter((meeting) => meeting.status === "live").length;
  const nextMeeting = upcoming[0];

  return (
    <div className="dashboard-page page-enter">
      <section className="welcome-row">
        <div>
          <p className="eyebrow"><span className="eyebrow-dot" /> YOUR CHOIR'S ONLINE GATHERING SPACE</p>
          <h1>{user ? `Welcome back, ${user.displayName.split(" ")[0]}.` : "Gather in faith. Wherever you are."}</h1>
          <p className="welcome-copy">A quieter, simpler way to pray, rehearse, and stay connected with your choir.</p>
        </div>
        <div className="welcome-decoration" aria-hidden="true"><span className="decor-ring decor-ring-one"/><span className="decor-ring decor-ring-two"/><span className="decor-center"><AudioLines size={36}/></span><span className="decor-star decor-star-one">✦</span><span className="decor-star decor-star-two">✧</span></div>
      </section>

      <section className="hero-panel">
        <div className="hero-shimmer" aria-hidden="true" />
        <div className="hero-copy">
          <div className="hero-pill"><Sparkles size={13} /> A LITTLE CLOSER, EVEN FROM AFAR</div>
          <h2>Make room for<br /><em>what matters.</em></h2>
          <p>Bring every voice into one room. No complicated setup — just open your link and be there.</p>
          <div className="hero-actions">
            <Link className="button button-cream" to="/meetings"><CalendarDays size={17}/> Go to Meetings <ArrowRight size={16}/></Link>
            <Link className="hero-secondary" to="/recordings"><AudioLines size={17}/> Recorded Meetings</Link>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-window"><div className="art-window-top"><span/><span/><span/><i>ENIHAKOLE · PRAYER ROOM</i></div><div className="art-video-grid"><span className="art-person art-person-one"><b>✦</b></span><span className="art-person art-person-two"><b>♪</b></span><span className="art-person art-person-three"><b>◌</b></span><span className="art-person art-person-four"><b>+</b></span></div><div className="art-controls"><span><Mic size={12}/></span><span><Video size={12}/></span><span className="art-end"><X size={12}/></span></div></div>
          <div className="art-note"><span className="art-note-icon"><HeartHandshake size={17}/></span><span><b>All together</b><small>One room. Many voices.</small></span><CheckCircle2 size={17} className="art-note-check"/></div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><p className="section-overline">YOUR SPACE</p><h2>At a glance</h2></div><button className="text-action" onClick={() => navigate("/meetings")}>View my meetings <ArrowRight size={15}/></button></div>
        <div className="stats-grid">
          <div className="stat-card"><span className="stat-icon stat-burgundy"><CalendarDays size={19}/></span><div><span className="stat-label">Upcoming Online Prayers</span><strong>{loadingMeetings ? "—" : upcoming.filter((m) => m.status === "scheduled").length.toString().padStart(2, "0")}</strong><small>Ready when you are</small></div><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-gold"><Video size={19}/></span><div><span className="stat-label">Live right now</span><strong>{loadingMeetings ? "—" : String(liveCount).padStart(2, "0")}</strong><small>{liveCount ? "Join the conversation" : "Your room is waiting"}</small></div><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-rose"><Users size={19}/></span><div><span className="stat-label">Your community</span><strong>ENIHAKOLE</strong><small>Stronger when connected</small></div><span className="stat-sheen"/></div>
        </div>
      </section>

      <section className="section-block meetings-section">
        <div className="section-heading"><div><p className="section-overline">DON'T MISS A MOMENT</p><h2>{nextMeeting?.status === "live" ? "Happening now" : "Coming together soon"}</h2></div>{(user?.canCreateMeetings || user?.isAdmin) && <button className="button button-outline button-small" onClick={() => openSchedule(false)}><Plus size={15}/> Create a gathering</button>}</div>
        {loadingMeetings ? <div className="loading-surface"><LoaderCircle className="spin" size={24}/><span>Finding your next gathering…</span></div> : upcoming.length ? (
          <div className="meeting-card-grid">{upcoming.map((meeting) => <MeetingCard key={meeting.slug} meeting={meeting} />)}</div>
        ) : (
          <div className="empty-state"><div className="empty-icon"><CalendarClock size={23}/></div><div><h3>No upcoming Online Prayers</h3><p>Public Online Prayers will appear here when they are scheduled. Ordinary meetings remain available only through their invitation links.</p></div><Link className="button button-primary" to="/meetings">Explore Meetings <ArrowRight size={16}/></Link></div>
        )}
      </section>

      <section className="tip-strip"><div className="tip-icon"><ShieldCheck size={18}/></div><div><strong>A better gathering starts with a simple link.</strong><p>Share the meeting invitation in your choir's WhatsApp group. Guests can join without creating an account.</p></div><ArrowDownRight size={19} className="tip-arrow"/></section>
    </div>
  );
}

function MeetingCard({ meeting }: { meeting: Meeting }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}/share/${encodeURIComponent(meeting.slug)}`;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Copy this invitation from the meeting details page." } }));
    }
  }
  return (
    <article className="meeting-card">
      <Link to={`/meeting/${meeting.slug}`} className="meeting-cover">
        <img className="meeting-cover-img" src={meetingImage(meeting)} alt="" loading="lazy" decoding="async" draggable={false}/>
        <span className={`meeting-status ${meeting.status === "live" ? "meeting-status-live" : ""}`}><span/>{getMeetingStateLabel(meeting)}</span>
        <span className="cover-open"><ArrowRight size={16}/></span>
      </Link>
      <div className="meeting-card-body">
        <div className="meeting-date"><CalendarDays size={14}/><span>{formatDate(meeting.startsAt, { weekday: "short", year: undefined }, meeting.timezone)}</span><i>·</i><span>{formatTime(meeting.startsAt, meeting.timezone)}</span></div>
        <Link to={`/meeting/${meeting.slug}`} className="meeting-title-link"><h3>{meeting.title}</h3></Link>
        <p className="meeting-description">{meeting.description || "A time to connect, pray, and grow together."}</p>
        <div className="meeting-card-bottom"><span className="meeting-duration"><Clock3 size={14}/>{meeting.durationMinutes} min</span><div className="meeting-card-actions"><button className="icon-button icon-button-bordered" onClick={() => void copyLink()} title="Copy invitation link" aria-label="Copy invitation link">{copied ? <Check size={15}/> : <Copy size={15}/>}</button><Link className="button button-primary button-join-small" to={`/meeting/${meeting.slug}`}>{meeting.status === "live" ? "Join now" : "Details"}<ArrowRight size={14}/></Link></div></div>
      </div>
    </article>
  );
}

function MeetingsPage() {
  const { user, meetings, publicMeetings, loadingMeetings, openSchedule, refreshMeetings } = useAppContext();
  // Everything the person can see: their own meetings plus every public gathering, without duplicates.
  const visible = [...(user ? meetings : []), ...publicMeetings].filter((meeting) => meeting.meetingType === "prayer").filter((meeting, index, array) => array.findIndex((other) => other.slug === meeting.slug) === index);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">(() => {
    const requested = new URLSearchParams(window.location.search).get("filter");
    return requested === "past" || requested === "all" ? requested : "upcoming";
  });
  const list = visible.filter((meeting) => {
    if (filter === "upcoming") return meeting.status === "scheduled" || meeting.status === "live";
    if (filter === "past") return meeting.status === "ended" || meeting.status === "cancelled";
    return true;
  }).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  useEffect(() => { void refreshMeetings(); }, [refreshMeetings]);
  return (
    <div className="meetings-page page-enter">
      <div className="page-title-row"><div><p className="eyebrow"><span className="eyebrow-dot"/> YOUR CALENDAR, TOGETHER</p><h1>Meetings & Online Prayers</h1><p className="welcome-copy">Discover public Online Prayers. Private meetings are opened through their invitation links.</p></div>{(user?.canCreateMeetings || user?.isAdmin) && <button className="button button-primary" onClick={() => openSchedule(false)}><Plus size={17}/> Create a gathering</button>}</div>
      <div className="filter-bar"><div className="segmented-filter">{(["upcoming", "past", "all"] as const).map((value) => <button key={value} className={filter === value ? "filter-active" : ""} onClick={() => setFilter(value)}>{value === "upcoming" ? "Upcoming" : value === "past" ? "Past meetings" : "All meetings"}</button>)}</div><span className="meeting-count">{list.length} {list.length === 1 ? "meeting" : "meetings"}</span></div>
      {loadingMeetings ? <div className="loading-surface"><LoaderCircle className="spin" size={24}/><span>Loading meetings…</span></div> : list.length ? <div className="meeting-card-grid">{list.map((meeting) => <MeetingCard key={meeting.slug} meeting={meeting}/>)}</div> : <div className="empty-state empty-large"><div className="empty-icon"><CalendarDays size={23}/></div><div><h3>{filter === "past" ? "No past meetings yet" : "A fresh page for your next gathering"}</h3><p>Public Online Prayers will appear here. Ordinary Meetings are private and can only be opened using their invitation link.</p></div><Link className="button button-primary" to="/recordings"><AudioLines size={16}/> Recorded Meetings</Link></div>}
    </div>
  );
}

function MediaToggle({ on, onChange, onIcon, offIcon, onLabel, offLabel, onHint, offHint }: { on: boolean; onChange: (value: boolean) => void; onIcon: ReactNode; offIcon: ReactNode; onLabel: string; offLabel: string; onHint: string; offHint: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={on ? onLabel : offLabel} className={`toggle-row toggle-row-switch ${on ? "is-on" : "is-off"}`} onClick={() => onChange(!on)}>
      <span className="toggle-icon"><span className="toggle-icon-swap" key={on ? "on" : "off"}>{on ? onIcon : offIcon}</span></span>
      <span><b>{on ? onLabel : offLabel}</b><small>{on ? onHint : offHint}</small></span>
      <span className="switch" aria-hidden="true"><span className="switch-knob"/></span>
    </button>
  );
}

function MeetingPage() {
  const { slug = "" } = useParams();
  const { user, meetings: knownMeetings, publicMeetings: knownPublic, openAuth, completeAuth, signOut } = useAppContext();
  const cacheKey = `meeting:${user?.id ?? "guest"}:${slug}`;
  const [meeting, setMeeting] = useState<Meeting | null>(() => readCache<Meeting>(cacheKey)?.value ?? [...knownMeetings, ...knownPublic].find((item) => item.slug === slug) ?? null);
  const [cameraOn, setCameraOn] = useState(false);
  const [guestName, setGuestName] = useState(() => getGuestProfile(slug)?.displayName || "");
  const [micOn, setMicOn] = useState(true);
  const [loading, setLoading] = useState(() => !readCache(cacheKey) && ![...knownMeetings, ...knownPublic].some((item) => item.slug === slug));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [mediaPrompt, setMediaPrompt] = useState<{ kind: MediaKind; state: MicPromptState } | null>(null);
  const [pastNotesOpen, setPastNotesOpen] = useState(false);
  const [pastNotes, setPastNotes] = useState<MeetingNotesPayload | null>(null);
  const [pastNotesLoading, setPastNotesLoading] = useState(false);
  const [pastNotesError, setPastNotesError] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const serverClockOffsetRef = useRef(0);
  const [pastRecording, setPastRecording] = useState<{ recording: { id: string; meetingTitle: string; durationSeconds: number }; playbackUrl: string; expiresAt: string } | null>(null);
  const [pastRecordingLoading, setPastRecordingLoading] = useState(false);
  const [pastRecordingError, setPastRecordingError] = useState("");
  const mediaRetryRef = useRef(0);
  const enteringRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    // Show what we already know instantly; the fresh copy swaps in quietly when it arrives.
    const known = readCache<Meeting>(cacheKey)?.value ?? [...knownMeetings, ...knownPublic].find((item) => item.slug === slug) ?? null;
    // After signing in the cache key changes; keep showing the invitation we already have (no loading screen, no flash) and refresh it quietly.
    if (known) { setMeeting(known); setLoading(false); } else if (!meeting) setLoading(true);
    api.meeting(slug).then(({ meeting: result }) => {
      if (cancelled) return;
      setMeeting(result);
      if (result.serverNow) {
        const serverNow = new Date(result.serverNow).getTime();
        if (Number.isFinite(serverNow)) {
          serverClockOffsetRef.current = serverNow - Date.now();
          setClockNow(serverNow);
        }
      }
      setError("");
      writeCache(cacheKey, result);
    }).catch((cause: unknown) => {
      if (!cancelled && !known) setError(cause instanceof Error ? cause.message : "Could not load this meeting.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, cacheKey]);

  // While a gathering is still scheduled, quietly watch for the host starting it early so waiting people see the Join button right away.
  const waitingForStart = meeting?.status === "scheduled";
  useEffect(() => {
    if (!waitingForStart) return;
    let cancelled = false;
    const poll = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      api.meeting(slug).then(({ meeting: result }) => {
        if (cancelled) return;
        if (result.status !== "scheduled") { setMeeting(result); writeCache(cacheKey, result); }
      }).catch(() => undefined);
    }, 5000);
    return () => { cancelled = true; window.clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForStart, slug, cacheKey]);

  useEffect(() => { if (user?.picture) void preloadPhoto(user.picture, 512); }, [user?.picture]);
  useEffect(() => {
    const tick = window.setInterval(() => setClockNow(Date.now() + serverClockOffsetRef.current), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // An ended gathering may have a synchronized audio-only recording. The invitation
  // slug is the existing bearer-share permission for a private Meeting.
  useEffect(() => {
    if (!meeting || (meeting.status !== "ended" && meeting.status !== "cancelled")) return;
    let cancelled = false;
    let retryTimer = 0;
    let attempts = 0;
    setPastRecordingLoading(true);
    setPastRecordingError("");
    setPastRecording(null);
    const checkRecording = async () => {
      let willRetry = false;
      try {
        const result = await api.meetingRecording(slug);
        if (cancelled) return;
        if (result.pending && attempts < 36) {
          attempts += 1;
          willRetry = true;
          retryTimer = window.setTimeout(() => void checkRecording(), 5_000);
          return;
        }
        if (result.recording && result.playbackUrl && result.expiresAt) {
          setPastRecording({ recording: result.recording, playbackUrl: result.playbackUrl, expiresAt: result.expiresAt });
          setPastRecordingError("");
        } else if (result.pending) {
          setPastRecordingError("The audio is still being processed. Open this invitation again shortly to listen.");
        } else {
          setPastRecordingError("No completed audio recording is available for this gathering.");
        }
      } catch (cause) {
        if (!cancelled) setPastRecordingError(cause instanceof Error ? cause.message : "No audio recording is available.");
      } finally {
        if (!cancelled && !willRetry) setPastRecordingLoading(false);
      }
    };
    void checkRecording();
    return () => { cancelled = true; window.clearTimeout(retryTimer); };
  }, [slug, meeting?.status]);

  // Ended meetings keep their shared notes available to their recorded members.
  useEffect(() => {
    if (!pastNotesOpen || !meeting || (meeting.status !== "ended" && meeting.status !== "cancelled")) return;
    let cancelled = false;
    setPastNotesLoading(true);
    setPastNotesError("");
    api.meetingNotes(slug).then(({ note }) => {
      if (!cancelled) setPastNotes(note);
    }).catch((cause) => {
      if (!cancelled) setPastNotesError(cause instanceof Error ? cause.message : "Could not load meeting notes.");
    }).finally(() => { if (!cancelled) setPastNotesLoading(false); });
    return () => { cancelled = true; };
  }, [pastNotesOpen, slug, meeting?.status]);

  // The browser is only asked after the person pressed Allow in our own dialog.
  async function askBrowser(kind: MediaKind) {
    const attempt = ++mediaRetryRef.current;
    setMediaPrompt({ kind, state: { phase: "waiting" } });
    const result = await requestMediaAccess(kind);
    if (attempt !== mediaRetryRef.current) return;
    if (result.phase === "granted") { setMediaPrompt({ kind, state: { phase: "granted" } }); await continueJoin(micOn, cameraOn); }
    else setMediaPrompt({ kind, state: result });
  }

  // Walks through whatever still needs permission (microphone, then camera) with our dialog first; once all is allowed it goes straight into the room.
  async function continueJoin(audio: boolean, video: boolean) {
    if (audio && !(await mediaAlreadyAllowed("microphone"))) { setMediaPrompt({ kind: "microphone", state: { phase: "ask" } }); return; }
    if (video && !(await mediaAlreadyAllowed("camera"))) { setMediaPrompt({ kind: "camera", state: { phase: "ask" } }); return; }
    setMediaPrompt((current) => current && current.state.phase === "granted" ? current : null);
    await enterRoom(audio, video);
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!meeting) return;
    if (!meeting.isOwner && meeting.status === "scheduled" && clockNow < new Date(meeting.startsAt).getTime()) {
      setError(`Not Yet Open. Please return at ${formatTime(meeting.startsAt, meeting.timezone)}.`);
      return;
    }
    if (!user && !getGuestProfile(slug)) { setError("Continue with Google or enter your first and last name to join as a guest."); return; }
    if (joining || mediaPrompt) return;
    await continueJoin(micOn, cameraOn);
  }

  async function enterRoom(audio: boolean, video: boolean) {
    if (!meeting || (!user && !getGuestProfile(slug)) || enteringRef.current) return;
    if (!meeting.isOwner && meeting.status === "scheduled" && Date.now() + serverClockOffsetRef.current < new Date(meeting.startsAt).getTime()) {
      setError("Not Yet Open. This gathering becomes available at its scheduled start time.");
      return;
    }
    if (activeRoomSlugInApp) {
      if (activeRoomSlugInApp === slug) navigate(`/room/${encodeURIComponent(slug)}`);
      else window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Leave your current meeting before joining another one." } }));
      return;
    }
    enteringRef.current = true;
    setJoining(true); setError("");
    try {
      const result = await api.join(slug);
      const session: JoinSession = { ...result, audio, video };
      sessionStorage.setItem(`meet-session:${slug}`, JSON.stringify(session));
      registerSession(session);
      // Everything is made ready here, on the meeting page: we connect to the room, load every photo, and wait until everyone already inside is visible and audible.
      // Only then do we move to the room page, which receives the finished, connected room.
      preparedRooms.get(slug)?.disconnect().catch(() => { /* Old attempt already closed. */ });
      preparedRooms.delete(slug);
      const room = new Room(ROOM_OPTIONS);
      try {
        await Promise.all([
          room.connect(result.serverUrl, result.token).then(() => { preventLiveKitFreezeDisconnect(room); }),
          ...(user?.picture ? [preloadPhoto(user.picture, 512)] : []), ...(result.participants ?? []).filter((person) => person.picture).map((person) => preloadPhoto(person.picture, 512)),
        ]);
        await Promise.all([
          room.localParticipant.setMicrophoneEnabled(audio).catch(() => { /* The room page asks again and shows the troubleshooting dialog. */ }),
          room.localParticipant.setCameraEnabled(video).catch(() => { /* Same as above. */ }),
        ]);
        await waitRoomReady(room, (result.participants ?? []).map((person) => person.identity), 10_000);
        if (!aliveRef.current) { await room.disconnect().catch(() => { /* Page was left. */ }); return; }
        preparedRooms.set(slug, room);
      } catch {
        // If anything fails here the room page still connects on its own, exactly as before.
        await room.disconnect().catch(() => { /* Nothing to close. */ });
      }
      window.dispatchEvent(new CustomEvent("meet-room-opened", { detail: { slug } }));
      navigate(`/room/${encodeURIComponent(slug)}`);
    } catch (cause) {
      setMediaPrompt(null);
      setError(cause instanceof Error ? cause.message : "Could not join this meeting.");
    } finally { enteringRef.current = false; setJoining(false); }
  }

  async function continueAsGuest() {
    if (!meeting) return;
    setError("");
    try {
      const result = await api.guestSession(slug, guestName);
      saveGuestAuthToken(result.token, { guestId: result.guestId, displayName: result.displayName, meetingSlug: slug });
      await continueJoin(micOn, cameraOn);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare your guest access.");
    }
  }

  async function googleCredential(credential: string) {
    setError("");
    try {
      const result = await api.googleSignIn(credential);
      // Have the profile photo ready first so the signed-in state appears instantly, with no spinner and no page reload.
      await preloadPhotoBriefly(result.user.picture, 512, 1200);
      completeAuth(result.user, result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in with Google.");
    }
  }

  async function share() {
    const url = `${window.location.origin}/share/${encodeURIComponent(slug)}`;
    try {
      if (navigator.share) await navigator.share({ title: meeting?.title || "MEET ENIHAKOLE", text: "Join our online gathering.", url });
      else { await navigator.clipboard.writeText(url); window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Invitation link copied." } })); }
    } catch { /* Share sheet dismissed. */ }
  }

  if (loading) return <StandaloneLoading label="Opening your invitation…"/>;
  if (!meeting) return <StandaloneError message={error || "This meeting could not be found."}/>;
  const ended = meeting.status === "ended" || meeting.status === "cancelled";
  const opensAt = new Date(meeting.startsAt).getTime();
  // The host may always start their own gathering early; everyone else waits for the scheduled time.
  const notYetOpen = !meeting.isOwner && meeting.status === "scheduled" && Number.isFinite(opensAt) && clockNow < opensAt;

  return (
    <div className="meeting-landing">
      <header className="landing-topbar"><Link className="brand-lockup" to="/"><span className="brand-mark"><AudioLines size={22}/></span><span className="brand-words"><strong>MEET</strong><b>ENIHAKOLE</b><small>GATHER IN FAITH</small></span></Link><div className="landing-topbar-actions"><ThemeToggle/><InstallPwaButton inline/></div></header>
      <main className="landing-layout">
        <section className="join-panel">
          <div className="join-cover join-cover-thumb"><img className="join-cover-img" src={meetingImage(meeting)} alt={meeting.title} decoding="async" fetchPriority="high" draggable={false}/><button type="button" className="thumb-share-button" onClick={share} aria-label="Share invitation"><Share2 size={15}/><span>Share invitation</span></button></div>
          <form className="join-form" onSubmit={join}>
            <div className="join-form-heading"><h2>{ended ? "This gathering has ended" : notYetOpen ? "Not Yet Open" : meeting.status === "live" ? "Join the gathering" : meeting.isOwner ? "Your gathering is ready" : "You're in the right place"}</h2><p>{ended ? "This invitation is now closed. Available audio and notes are below." : notYetOpen ? `This gathering opens at ${formatTime(meeting.startsAt, meeting.timezone)}. Please check again when it becomes available.` : meeting.status === "live" ? "Enter your details and come on in." : "The room becomes available automatically at its scheduled start time."}</p></div>
            {user && !ended && <div className="join-identity"><ProfilePhoto src={user.picture} name={user.displayName} className="join-identity-photo"/><span><b>{user.displayName}</b><small>{user.email}</small></span><button type="button" className="error-link" onClick={signOut}><LogOut size={12}/> Sign out</button></div>}
            {!user && !ended && <div className="join-google"><p>Continue with Google (recommended) or join with your name as a temporary guest. Guest access is limited to this meeting.</p><GoogleContinueButton oneTap onCredential={(credential) => void googleCredential(credential)}/>{!getGuestProfile(slug) ? <div className="guest-access-form"><div className="guest-access-divider"><span>OR</span></div><label htmlFor="guest-full-name">Continue as Guest</label><input id="guest-full-name" value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="First and last name" autoComplete="name" maxLength={80}/><small>Use your full name. No account or email is required.</small><button type="button" className="button button-soft button-full" onClick={() => void continueAsGuest()} disabled={joining || guestName.trim().split(/\s+/).filter(Boolean).length < 2}>{joining ? "Preparing guest access…" : "Continue as Guest"}</button></div> : <div className="join-identity guest-identity"><ProfilePhoto name={getGuestProfile(slug)?.displayName || guestName} className="join-identity-photo"/><span><b>{getGuestProfile(slug)?.displayName}</b><small>Temporary guest · this meeting only</small></span></div>}</div>}
            {!ended && <div className="join-preferences"><MediaToggle on={cameraOn} onChange={setCameraOn} onIcon={<Video size={16}/>} offIcon={<VideoOff size={16}/>} onLabel="Camera is on" offLabel="Camera is off" onHint="Join with video" offHint="Join without video"/><MediaToggle on={micOn} onChange={setMicOn} onIcon={<Mic size={16}/>} offIcon={<MicOff size={16}/>} onLabel="Microphone is on" offLabel="Microphone is off" onHint="Join with audio" offHint="Join muted"/></div>}
            {error && <div className="inline-error" role="alert">{error}{error.includes("Sign in") && <button type="button" className="error-link" onClick={openAuth}>Sign in</button>}</div>}
            {ended ? <div className="meeting-ended-actions"><Link to="/meetings" className="button button-soft button-full"><ArrowLeft size={16}/> Back to meetings</Link>{(meeting.isOwner || meeting.isParticipant) && <button type="button" className="button button-primary button-full" onClick={() => setPastNotesOpen(true)}><FileText size={16}/> View meeting notes</button>}{pastRecordingLoading && <div className="meeting-audio-loading"><LoaderCircle size={17} className="spin"/> Checking for an audio recording…</div>}{pastRecording && <section className="meeting-ended-audio"><div><AudioLines size={20}/><span><b>Audio recording</b><small>{pastRecording.recording.meetingTitle}</small></span></div><AudioRecordingPlayer src={pastRecording.playbackUrl} title={pastRecording.recording.meetingTitle}/><small>Available until {formatDate(pastRecording.expiresAt)}</small></section>}{pastRecordingError && !pastRecordingLoading && !pastRecording && <p className="meeting-audio-unavailable">{pastRecordingError}</p>}</div> : (user || getGuestProfile(slug)) && <><button className={`button button-primary button-full join-submit ${notYetOpen ? "join-submit-locked" : ""}`} type="submit" disabled={joining || notYetOpen}>{joining ? <LoaderCircle size={17} className="spin"/> : notYetOpen ? <Clock3 size={17}/> : meeting.isOwner ? <Video size={17}/> : <DoorOpen size={17}/>} {joining ? "Joining…" : notYetOpen ? "Not Yet Open" : meeting.status === "scheduled" ? "Open gathering" : "Join gathering"}<ArrowRight size={16}/></button>{notYetOpen && <div className="meeting-not-yet-open" role="status"><Clock3 size={16}/><span><b>Opens {formatDate(meeting.startsAt, { weekday: "short" }, meeting.timezone)}</b><small>{formatTime(meeting.startsAt, meeting.timezone)} · {meeting.timezone || "Scheduled time"}</small></span></div>}</>}
            <p className="join-footnote"><ShieldCheck size={13}/> Your camera and microphone are only requested when you enter the room.</p>
          </form>
        </section>
        <section className="landing-details">
          <p className="eyebrow"><span className={`eyebrow-dot ${meeting.status === "live" ? "eyebrow-dot-live" : ""}`}/>{meeting.status === "live" ? "THE GATHERING IS LIVE" : ended ? "GATHERING CLOSED" : "YOU'RE INVITED"}</p>
          <h1>{meeting.title}</h1>
          <p className="landing-description">{meeting.description || "Join ENIHAKOLE CHOIR for a time to pray, connect, and lift our voices together."}</p>
          <div className="host-row"><span className="host-avatar"><AudioLines size={19}/></span><div><small>HOSTED BY</small><strong>{meeting.ownerName}</strong></div><span className="verified-host"><ShieldCheck size={14}/> Host</span></div>
          <div className="meeting-detail-list"><div><span className="detail-icon"><CalendarDays size={18}/></span><span><b>{formatDate(meeting.startsAt, { weekday: "long", year: "numeric" }, meeting.timezone)}</b><small>{formatTime(meeting.startsAt, meeting.timezone)} · {meeting.timezone || "Meeting time"}</small></span></div><div><span className="detail-icon"><Clock3 size={18}/></span><span><b>{meeting.durationMinutes} minutes</b><small>Planned gathering time</small></span></div><div><span className="detail-icon"><Users size={18}/></span><span><b>Join from anywhere</b><small>Phone, tablet, or computer</small></span></div></div>
          <button className="landing-share-link" onClick={share}><Link2 size={16}/> Share this invitation <ArrowRight size={15}/></button>
        </section>
      </main>
      <footer className="landing-footer"><span>© {new Date().getFullYear()} MEET ENIHAKOLE</span><span>Built for togetherness.</span></footer>
      {mediaPrompt && <MediaPermissionModal
        kind={mediaPrompt.kind}
        state={mediaPrompt.state}
        skipLabel={mediaPrompt.kind === "camera" ? "Join without camera" : "Join without microphone"}
        grantedLabel="Joining…"
        onRetry={() => { void askBrowser(mediaPrompt.kind); }}
        onGranted={() => { const kind = mediaPrompt.kind as MediaKind; mediaAllowed[kind] = true; mediaRetryRef.current++; setMediaPrompt({ kind, state: { phase: "granted" } }); void continueJoin(micOn, cameraOn); }}
        onSkip={() => { mediaRetryRef.current++; if (mediaPrompt.kind === "camera") { setCameraOn(false); void continueJoin(micOn, false); } else { setMicOn(false); void continueJoin(false, cameraOn); } }}
        onClose={() => { mediaRetryRef.current++; setMediaPrompt(null); }}
      />}
      {pastNotesOpen && <div className="meeting-notes-archive-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPastNotesOpen(false); }}><section className="meeting-notes-archive" role="dialog" aria-modal="true" aria-labelledby="past-meeting-notes-title"><header><div><span className="section-overline">MEETING ARCHIVE</span><h2 id="past-meeting-notes-title">{pastNotes?.title || "Meeting notes"}</h2><p>{meeting.title} · {formatDate(meeting.startedAt || meeting.startsAt)}</p></div><button type="button" className="room-icon-button" onClick={() => setPastNotesOpen(false)} aria-label="Close meeting notes"><X size={18}/></button></header>{pastNotesLoading ? <div className="meeting-notes-archive-state"><LoaderCircle size={22} className="spin"/> Loading saved notes…</div> : pastNotesError ? <div className="meeting-notes-archive-state meeting-notes-archive-error" role="alert">{pastNotesError}<button type="button" onClick={() => { setPastNotesOpen(false); window.setTimeout(() => setPastNotesOpen(true), 0); }}>Try again</button></div> : <><article className="meeting-notes-archive-content" dangerouslySetInnerHTML={{ __html: pastNotes?.contentHtml || "<p>No notes were saved for this meeting.</p>" }}/><footer><span>Last saved {pastNotes?.updatedAt ? formatDate(pastNotes.updatedAt) : "—"}{pastNotes?.updatedByName ? ` · ${pastNotes.updatedByName}` : ""}</span><button type="button" className="button button-primary button-small" onClick={() => downloadMeetingNotesPdf(meeting.title, meeting.startedAt || meeting.startsAt, pastNotes?.title || "Meeting notes", pastNotes?.contentHtml || "")}><Download size={15}/> Export PDF</button></footer></>}</section></div>}
    </div>
  );
}

type MediaKind = "microphone" | "camera";
type MicPromptState = { phase: "ask" } | { phase: "waiting" } | { phase: "granted" } | { phase: "blocked" | "unavailable" | "busy" | "unsupported"; message: string };
// Remembers what the person already allowed in this tab, for browsers that cannot report permission state.
const mediaAllowed: Record<MediaKind, boolean> = { microphone: false, camera: false };

async function queryMediaPermission(kind: MediaKind): Promise<PermissionState | null> {
  try { return (await navigator.permissions.query({ name: kind as PermissionName })).state; } catch { return null; }
}
async function mediaAlreadyAllowed(kind: MediaKind): Promise<boolean> {
  const permission = await queryMediaPermission(kind);
  if (permission === "granted") return true;
  if (permission === "denied") return false;
  return mediaAllowed[kind];
}
function mediaFailure(phase: "blocked" | "unavailable" | "busy" | "unsupported", kind: MediaKind): MicPromptState {
  const noun = kind === "camera" ? "camera" : "microphone";
  if (phase === "unsupported") return { phase, message: window.isSecureContext ? `This browser can't use a ${noun} here. Try Chrome, Edge, Firefox or Safari.` : `The ${noun} needs a secure (https) link.` };
  if (phase === "unavailable") return { phase, message: `No ${noun} found. Plug one in, then try again.` };
  if (phase === "busy") return { phase, message: `Your ${noun} is in use by another app. Close it, then try again.` };
  return { phase, message: `${noun[0].toUpperCase()}${noun.slice(1)} is blocked for this site.` };
}

// Opens the device once so the browser shows its own permission prompt, then releases it right away (LiveKit opens it again inside the room).
// Only ever called after the person pressed Allow in our dialog.
async function requestMediaAccess(kind: MediaKind): Promise<MicPromptState> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return mediaFailure("unsupported", kind);
  try {
    const stream = await media.getUserMedia(kind === "camera" ? { video: true } : { audio: { echoCancellation: true, noiseSuppression: true } });
    stream.getTracks().forEach((track) => track.stop());
    mediaAllowed[kind] = true;
    return { phase: "granted" };
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : "";
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return mediaFailure("unavailable", kind);
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return mediaFailure("busy", kind);
    return mediaFailure("blocked", kind);
  }
}

function MediaPermissionModal({ kind, state, skipLabel, grantedLabel, onRetry, onGranted, onSkip, onClose }: { kind: MediaKind; state: MicPromptState; skipLabel: string; grantedLabel: string; onRetry: () => void; onGranted: () => void; onSkip: () => void; onClose: () => void }) {
  const isCamera = kind === "camera";
  const noun = isCamera ? "camera" : "microphone";
  const Noun = isCamera ? "Camera" : "Microphone";
  const asking = state.phase === "ask";
  const waiting = state.phase === "waiting";
  const granted = state.phase === "granted";
  const failed = !asking && !waiting && !granted;
  const failure = failed ? (state as { phase: string; message: string }) : null;
  const grantedRef = useRef(onGranted);
  const closeRef = useRef(onClose);
  grantedRef.current = onGranted;
  closeRef.current = onClose;

  // While access is blocked, keep watching: the moment the person allows it (in the address bar or settings) we continue on our own.
  // We only look at the permission state here, so the browser is never asked again behind the person's back.
  useEffect(() => {
    if (!failed) return;
    let stopped = false;
    let status: PermissionStatus | null = null;
    const onChange = () => { if (!stopped && status?.state === "granted") grantedRef.current(); };
    navigator.permissions?.query({ name: kind as PermissionName }).then((result) => { if (stopped) return; status = result; if (result.state === "granted") grantedRef.current(); else result.addEventListener("change", onChange); }).catch(() => { /* Permissions API is not available in every browser. */ });
    const timer = window.setInterval(() => {
      if (stopped || document.hidden) return;
      void queryMediaPermission(kind).then((permission) => {
        if (stopped || permission !== "granted") return;
        void requestMediaAccess(kind).then((result) => { if (!stopped && result.phase === "granted") grantedRef.current(); });
      });
    }, 2500);
    return () => { stopped = true; window.clearInterval(timer); status?.removeEventListener("change", onChange); };
  }, [failed, kind]);

  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !granted) closeRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.classList.remove("modal-open"); document.removeEventListener("keydown", onKey); };
  }, [granted]);

  const help = failure?.phase === "blocked" ? "Tap the lock icon by the address bar, set " + Noun + " to Allow, then press Try again."
    : failure?.phase === "busy" ? "Close other apps using it (like Zoom or Teams), then press Try again."
    : failure?.phase === "unavailable" ? "Check your device settings or plug one in, then press Try again." : "";

  return (
    <div className="modal-backdrop mic-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !granted) onClose(); }}>
      <section className="modal-panel modal-panel-narrow mic-modal" role="dialog" aria-modal="true" aria-labelledby="mic-modal-title">
        {!granted && <button type="button" className="icon-button modal-close mic-modal-close" onClick={onClose} aria-label="Close"><X size={17}/></button>}
        <div className="mic-modal-body">
          <div className={`mic-orb ${failed ? "mic-orb-off" : ""}`} aria-hidden="true">
            <span className="mic-orb-glow"/><span className="mic-orb-ring"/><span className="mic-orb-core">{failed ? (isCamera ? <VideoOff size={34} strokeWidth={1.9}/> : <MicOff size={34} strokeWidth={1.9}/>) : (isCamera ? <Video size={34} strokeWidth={1.9}/> : <Mic size={34} strokeWidth={1.9}/>)}</span>
          </div>
          <p className="section-overline">{granted ? "ALL SET" : "ONE QUICK STEP"}</p>
          <h2 id="mic-modal-title">{granted ? `${Noun} ready` : failed ? `We can't ${isCamera ? "see" : "hear"} you yet` : `Allow your ${noun}`}</h2>
          <p className="mic-modal-text">{granted ? "Taking you in." : failure ? failure.message : `Tap Allow, then confirm in your browser so your choir can ${isCamera ? "see" : "hear"} you.`}</p>
          {help && <p className="mic-modal-help">{help}</p>}
          {waiting && <p className="mic-modal-status" role="status"><LoaderCircle size={14} className="spin"/> Waiting…</p>}
          {failed && <p className="mic-modal-status mic-modal-status-soft" role="status"><LoaderCircle size={14} className="spin"/> Checking…</p>}
        </div>
        <div className="mic-modal-actions modal-footer-fixed">
          <button type="button" className="button button-primary button-full" onClick={onRetry} disabled={waiting || granted}>{waiting || granted ? <LoaderCircle size={16} className="spin"/> : isCamera ? <Video size={16}/> : <Mic size={16}/>} {failed ? "Try again" : granted ? grantedLabel : `Allow ${noun}`}</button>
          {!granted && <button type="button" className="button button-soft button-full" onClick={onSkip}>{skipLabel}</button>}
        </div>
      </section>
    </div>
  );
}

function MeetingRoomPage({ slug, isActive }: { slug: string; isActive: boolean }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<JoinSession | null>(() => readStoredSession(slug));
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [meetingEnded, setMeetingEnded] = useState(false);
  // A room that was already connected and fully loaded on the meeting page;
  // the app-level host keeps it mounted while other SPA routes are displayed.
  const [preparedRoom] = useState<Room | null>(() => { const room = preparedRooms.get(slug); return room && room.state === ConnectionState.Connected ? room : null; });

  useEffect(() => {
    try {
      const stored = readStoredSession(slug);
      if (stored) setSession(stored);
    } catch { setSession(null); }
  }, [slug]);

  useEffect(() => {
    if (!isActive) setConfirmEnd(false);
  }, [isActive]);

  useEffect(() => {
    if ((!isActive && meetingEnded) || (!isActive && !session)) {
      window.dispatchEvent(new CustomEvent("meet-room-closed", { detail: { slug } }));
    }
  }, [isActive, meetingEnded, session, slug]);

  function leaveRoom() {
    window.dispatchEvent(new CustomEvent("meet-room-closed", { detail: { slug } }));
    navigate(`/meeting/${encodeURIComponent(slug)}`);
  }

  // The host pressed End for everyone: ask first with our own confirmation, never the browser box.
  function endForEveryone() {
    if (!session || session.role !== "host" || ending) return;
    setConfirmEnd(true);
  }
  function showEnded() {
    sessionStorage.removeItem(`meet-session:${slug}`);
    preparedRooms.delete(slug);
    setConfirmEnd(false);
    setMeetingEnded(true);
  }
  async function confirmEndForEveryone() {
    if (!session || session.role !== "host") return;
    setEnding(true); setEndError("");
    try {
      await api.endMeeting(slug);
      window.dispatchEvent(new CustomEvent("meet-meeting-changed", { detail: { slug, patch: { status: "ended", endedAt: new Date().toISOString() } } }));
      showEnded();
    } catch (cause) {
      setConfirmEnd(false);
      setEndError(cause instanceof Error ? cause.message : "Could not end the meeting.");
    } finally { setEnding(false); }
  }
  // The room closed under us. If the host ended the meeting, show the ended screen.
  function handleRoomDisconnected(reason?: DisconnectReason) {
    if (reason === DisconnectReason.ROOM_DELETED) { showEnded(); return; }
    setDisconnected(true);
    void api.meeting(slug).then(({ meeting }) => { if (meeting.status === "ended" || meeting.status === "cancelled") showEnded(); }).catch(() => { /* Keep the normal disconnected notice. */ });
  }

  if (meetingEnded) {
    if (!isActive) return null;
    const isPrayer = session?.meeting.meetingType === "prayer";
    const returnTo = isPrayer ? "/meetings?filter=past" : `/meeting/${encodeURIComponent(slug)}`;
    return <MeetingEndedScreen title={session?.meeting.title ?? ""} isHost={session?.role === "host"} destinationLabel={isPrayer ? "completed Online Prayers" : "this meeting's recording and notes"} onBack={() => { window.dispatchEvent(new CustomEvent("meet-room-closed", { detail: { slug } })); navigate(returnTo); }}/>;
  }
  if (!session) {
    if (!isActive) return null;
    return <StandaloneError message="Your room session is missing or expired. Open the invitation again to rejoin." action={<Link className="button button-primary" to={`/meeting/${slug}`}>Return to meeting</Link>}/>;
  }

  return (
    <LiveKitRoom
      room={preparedRoom ?? undefined}
      token={session.token}
      serverUrl={session.serverUrl}
      connect={true}
      audio={session.audio}
      video={session.video}
      options={ROOM_OPTIONS}
      onDisconnected={handleRoomDisconnected}
      onMediaDeviceFailure={(failure, kind) => window.dispatchEvent(new CustomEvent("meet-media-failure", { detail: { failure, kind } }))}
    >
      {!isActive && <BackgroundMeetingDock title={session.meeting.title} disconnected={disconnected} onReturn={() => navigate(`/room/${encodeURIComponent(slug)}`)} onLeave={leaveRoom}/>}
      <div className={`conference-page ${!isActive ? "conference-page-audio-host" : ""}`} aria-hidden={!isActive}>
        {endError && <div className="room-alert" role="alert">{endError}</div>}
        {disconnected && <div className="room-alert" role="status">You have disconnected from the call. <button onClick={leaveRoom}>Return to meeting</button></div>}
        <main className="conference-main">
          <div className="conference-stage">
            <ConferenceWorkspace meeting={session.meeting} role={session.role} onLeave={leaveRoom} onEndForEveryone={() => endForEveryone()} ending={ending} isActive={isActive}/>
            {!preparedRoom && <RoomReadyOverlay expected={(session.participants ?? []).map((person) => person.identity)}/>}
          </div>
          {confirmEnd && <ConfirmEndModal busy={ending} onCancel={() => setConfirmEnd(false)} onConfirm={() => void confirmEndForEveryone()}/>}
        </main>
      </div>
    </LiveKitRoom>
  );
}

function BackgroundMeetingDock({ title, disconnected, onReturn, onLeave }: { title: string; disconnected: boolean; onReturn: () => void; onLeave: () => void }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const [micBusy, setMicBusy] = useState(false);
  async function toggleMicrophone() {
    if (micBusy) return;
    setMicBusy(true);
    try { await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled); }
    catch { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Could not change microphone state. Return to the call and check permission." } })); }
    finally { setMicBusy(false); }
  }
  return <aside className="background-meeting-dock" role="region" aria-label="Active meeting controls">
    <span className="background-meeting-indicator" aria-hidden="true"/>
    <div className="background-meeting-copy"><strong>{disconnected ? "Connection interrupted" : "Meeting continues"}</strong><span>{title} · {participants.length} participants</span></div>
    <button type="button" className="background-meeting-action" onClick={() => void toggleMicrophone()} disabled={micBusy} aria-label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"} title={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}>{isMicrophoneEnabled ? <Mic size={16}/> : <MicOff size={16}/>}</button>
    <button type="button" className="background-meeting-return" onClick={onReturn}>Return to call</button>
    <button type="button" className="background-meeting-leave" onClick={onLeave}>Leave</button>
  </aside>;
}


/** Our own confirmation for ending a meeting. It is drawn inside the fullscreen room when the room is fullscreen, so it is always visible. */
function ConfirmEndModal({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const host = document.fullscreenElement ?? document.querySelector(".conference-fullscreen-target.is-pseudo-fullscreen") ?? document.body;
  return createPortal(
    <div className="modal-backdrop confirm-end-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="modal-panel modal-panel-narrow confirm-end-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-end-title" aria-describedby="confirm-end-text">
        <div className="confirm-end-icon" aria-hidden="true"><DoorOpen size={26}/></div>
        <h2 id="confirm-end-title">End this meeting for everyone?</h2>
        <p id="confirm-end-text">Everyone in the room will be disconnected right away and the meeting will be closed. This cannot be undone.</p>
        <div className="confirm-end-actions">
          <button type="button" className="button button-soft" onClick={onCancel} disabled={busy} autoFocus>Keep meeting open</button>
          <button type="button" className="button button-danger" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <X size={16}/>} {busy ? "Ending…" : "End for everyone"}</button>
        </div>
      </section>
    </div>,
    host,
  );
}

/** Shown to everyone the moment the meeting is ended. */
function MeetingEndedScreen({ title, isHost, destinationLabel, onBack }: { title: string; isHost: boolean; destinationLabel: string; onBack: () => void }) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    const timer = window.setTimeout(() => onBackRef.current(), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="meeting-ended-page" role="status" aria-live="polite">
    <div className="meeting-ended-card">
      <span className="meeting-ended-icon"><DoorOpen size={30}/></span>
      <p className="eyebrow"><span className="eyebrow-dot"/> GATHERING CLOSED</p>
      <h1>This meeting has ended</h1>
      {title && <p className="meeting-ended-title">{title}</p>}
      <p className="meeting-ended-text">{isHost ? "You ended this meeting for everyone. Thank you for hosting." : "The host has ended this meeting for everyone. Thank you for joining."}</p>
      <p className="meeting-ended-text">Returning to {destinationLabel}…</p>
      <button type="button" className="button button-primary button-full" onClick={onBack}><ArrowLeft size={16}/> Continue now</button>
    </div>
  </div>;
}

const ROOM_OPTIONS: RoomOptions = {
  // Adaptive Stream selects a receiver layer from the rendered tile size;
  // Dynacast prevents the SFU requesting layers that nobody currently needs.
  adaptiveStream: true,
  dynacast: true,
  // Do not treat pagehide/beforeunload as an explicit leave. Browsers may
  // freeze and later restore a page from BFCache; LiveKit reconnect logic
  // remains responsible for transport recovery when the OS interrupts it.
  // A full tab/browser termination still ends the web runtime and cannot be
  // kept alive by this option.
  disconnectOnPageLeave: false,
  // Auto starts at 720p. The quality controller can restart this same camera
  // track at 360p/480p/1080p without replacing the LiveKit room or track.
  videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
  // Voice path tuned for minimum delay: mono capture with the lowest capture latency hint, no pre-processing buffering beyond the browser's own echo/noise handling.
  audioCaptureDefaults: { channelCount: 1, latency: 0, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  publishDefaults: {
    // DTX pauses sending during silence and costs the first syllable a restart delay; keeping the stream continuous makes speech start instantly. RED adds redundancy so a lost packet never needs a resend wait.
    dtx: false, red: true, forceStereo: false,
    audioPreset: { maxBitrate: 32_000, priority: "high" },
    // Reserve enough encoder headroom for genuine 1080p when a user selects
    // Full HD or Auto detects sustainable bandwidth. Camera capture still
    // determines the real source resolution; this does not upscale video.
    videoEncoding: VideoPresets.h1080.encoding,
    // Let the browser balance frame rate and resolution during brief network
    // pressure; the app's sustained-signal controller handles larger changes.
    degradationPreference: "balanced",
    screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 15 },
    // Three useful spatial layers: 1080p primary, plus 720p and 360p.
    // Each receiver independently requests the layer it can sustain.
    simulcast: true,
    videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h720],
  },
};
// Rooms that were connected and fully loaded on the meeting page, waiting to be shown by the room page.
const preparedRooms = new Map<string, Room>();

/** Resolves once everyone who was already here is present with their photo loaded and their audio/video subscribed (or when the time limit is reached). */
function waitRoomReady(room: Room, expected: string[], maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const photoTasks = new Map<string, Promise<void>>();
    const photoDone = new Set<string>();
    const wantPhoto = (identity: string, metadata?: string) => {
      const picture = participantPicture(metadata, identity);
      const key = `${identity}|${picture}`;
      if (!picture || photoTasks.has(key)) return;
      photoTasks.set(key, preloadPhoto(picture, 512).then(() => { photoDone.add(key); }));
    };
    const finish = () => { window.clearInterval(timer); resolve(); };
    const evaluate = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > maxMs || room.state !== ConnectionState.Connected) { finish(); return; }
      const local = room.localParticipant;
      wantPhoto(local.identity, local.metadata);
      const remotes = Array.from(room.remoteParticipants.values());
      remotes.forEach((participant) => wantPhoto(participant.identity, participant.metadata));
      const everyoneHere = expected.filter((identity) => identity !== local.identity).every((identity) => room.remoteParticipants.has(identity));
      const photosReady = photoTasks.size === photoDone.size;
      const voicesReady = remotes.every((participant) => {
        const mic = participant.getTrackPublication(Track.Source.Microphone);
        const cam = participant.getTrackPublication(Track.Source.Camera);
        const micOk = !mic || mic.isMuted || (mic.isSubscribed && Boolean(mic.track));
        const camOk = !cam || cam.isMuted || (cam.isSubscribed && Boolean(cam.track));
        return micOk && camOk;
      });
      if ((everyoneHere || elapsed > 5000) && photosReady && (voicesReady || elapsed > 6500)) finish();
    };
    const timer = window.setInterval(evaluate, 120);
    evaluate();
  });
}

/** Covers the room until everyone who was already here is shown with their photo and voice, so you arrive in a fully drawn room. */
function RoomReadyOverlay({ expected }: { expected: string[] }) {
  const room = useRoomContext();
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(false);
  const expectedKey = expected.join("|");

  useEffect(() => {
    let finished = false;
    const startedAt = Date.now();
    let connectedAt = 0;
    const photoTasks = new Map<string, Promise<void>>();
    const photoDone = new Set<string>();
    const wantPhoto = (identity: string, metadata?: string) => {
      const picture = participantPicture(metadata, identity);
      const key = `${identity}|${picture}`;
      if (!picture || photoTasks.has(key)) return;
      photoTasks.set(key, preloadPhoto(picture, 512).then(() => { photoDone.add(key); }));
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearInterval(timer);
      // One more frame so the cards are painted underneath before the cover fades away.
      requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    };
    const evaluate = () => {
      if (finished) return;
      const elapsed = Date.now() - startedAt;
      if (room.state !== ConnectionState.Connected) { if (elapsed > 15000 || (room.state === ConnectionState.Disconnected && elapsed > 6000)) finish(); return; }
      if (!connectedAt) connectedAt = Date.now();
      const sinceConnected = Date.now() - connectedAt;
      const local = room.localParticipant;
      wantPhoto(local.identity, local.metadata);
      const remotes = Array.from(room.remoteParticipants.values());
      remotes.forEach((participant) => wantPhoto(participant.identity, participant.metadata));
      const everyoneHere = expected.filter((identity) => identity !== local.identity).every((identity) => room.remoteParticipants.has(identity));
      const photosReady = photoTasks.size === photoDone.size;
      const voicesReady = remotes.every((participant) => {
        const mic = participant.getTrackPublication(Track.Source.Microphone);
        const cam = participant.getTrackPublication(Track.Source.Camera);
        const micOk = !mic || mic.isMuted || (mic.isSubscribed && Boolean(mic.track));
        const camOk = !cam || cam.isMuted || (cam.isSubscribed && Boolean(cam.track));
        return micOk && camOk;
      });
      if ((everyoneHere || sinceConnected > 5000) && photosReady && (voicesReady || sinceConnected > 6500)) finish();
      else if (sinceConnected > 9000) finish();
    };
    const timer = window.setInterval(evaluate, 120);
    evaluate();
    return () => { finished = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, expectedKey]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setGone(true), 400);
    return () => window.clearTimeout(timer);
  }, [ready]);

  if (gone) return null;
  return <div className={`room-ready-overlay ${ready ? "room-ready-overlay-out" : ""}`} role="status" aria-live="polite" aria-hidden={ready}>
    <LoaderCircle size={22} className="spin room-ready-spinner"/>
  </div>;
}

type RoomSignal = { kind: "hand"; raised: boolean } | { kind: "reaction"; emoji: string; id: string };
type MeetingRecordingState = { id: string; status: string; hostName: string; consents: Array<{ displayName: string; identity: string; decision: string }>; myDecision: string; startedAt: string | null; endedAt: string | null; uploadProgressPercent: number; lastError: string; canRetry: boolean };
type FloatingReaction = { id: string; emoji: string; name: string; x: number; rise: number; scale: number };
type DirectContact = { userId: string; identity: string; name: string; picture: string };
type PrivateDataSignal =
  | { kind: "private-message"; recipientUserId: string; message: PrivateMessage }
  | { kind: "moderator-request"; recipientUserId: string; media: "microphone" | "camera"; hostName: string }
  | { kind: "moderator-media-control"; recipientUserId: string; media: "microphone" | "camera"; action: "disable"; hostName: string };
const REACTION_LIFETIME = 5000;
const PRIVATE_MESSAGE_TOPIC = "meet-enihakole-private";
/** Reactions use a fixed horizontal launch point and a vertical-only travel distance. */
function makeReaction(id: string, emoji: string, name: string): FloatingReaction {
  return { id, emoji, name, x: 12 + Math.random() * 76, rise: 65, scale: 0.9 + Math.random() * 0.35 };
}
function reactionKind(emoji: string): string {
  if (emoji === "👏") return "clap"; if (emoji === "🙌") return "wave"; if (emoji === "❤️" || emoji === "💛") return "beat";
  if (emoji === "🎉") return "pop"; if (emoji === "✨") return "twinkle"; if (emoji === "🕊️") return "flap"; if (emoji === "👍") return "thumb";
  return "float";
}
// Anything a person can press: a tap on these must keep doing its own job and never toggle fullscreen.
const INTERACTIVE_SELECTOR = ".screen-annotate-layer.is-drawing, .screen-annotate-toolbar, button, a, input, textarea, select, label, summary, [role='button'], [role='dialog'], [data-popover], .room-device-menu, .reaction-picker, .messages-modal-backdrop, .room-alert, .room-message-toast, .room-presence-stack, .modal-backdrop";
const PARTICIPANTS_PER_SCREEN = 6;
const REACTION_SET = ["🙏", "❤️", "👏", "🙌", "😊", "🎉", "✨", "💛", "🕊️", "👍"];

// People we already know about before the room connects (from the join response and our own token), so names and photos are there from the first frame.
const knownPeople = new Map<string, { name: string; picture: string }>();
function registerSession(session: JoinSession) {
  session.participants?.forEach((person) => knownPeople.set(person.identity, { name: person.name, picture: person.picture }));
  try {
    const payload = JSON.parse(atob(session.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; name?: string; metadata?: string };
    if (payload.sub) {
      let picture = ""; try { picture = JSON.parse(payload.metadata || "{}").picture || ""; } catch { /* No photo. */ }
      knownPeople.set(payload.sub, { name: payload.name || "", picture });
    }
  } catch { /* Token is still used as-is by LiveKit. */ }
}
function readStoredSession(slug: string): JoinSession | null {
  try {
    const raw = sessionStorage.getItem(`meet-session:${slug}`);
    if (!raw) return null;
    const stored = JSON.parse(raw) as JoinSession;
    registerSession(stored);
    return stored;
  } catch { return null; }
}
function participantUserId(participant: Participant | undefined | null): string {
  if (!participant) return "";
  try {
    const value = JSON.parse(participant.metadata || "{}").userId;
    return typeof value === "string" ? value : "";
  } catch { return ""; }
}
function participantName(participant: Participant): string {
  if (participant.name) return participant.name;
  try { const fromMeta = JSON.parse(participant.metadata || "{}").displayName; if (typeof fromMeta === "string" && fromMeta) return fromMeta; } catch { /* Fall through. */ }
  return knownPeople.get(participant.identity)?.name || "";
}

function participantPicture(metadata?: string, identity?: string): string {
  try {
    const picture = JSON.parse(metadata || "{}").picture;
    if (typeof picture === "string" && picture.startsWith("https://")) return picture;
  } catch { /* Fall back to what we knew before connecting. */ }
  return (identity && knownPeople.get(identity)?.picture) || "";
}

function ParticipantAvatar({ trackRef, participant }: { trackRef: Parameters<typeof useIsMuted>[0]; participant: Participant }) {
  const muted = useIsMuted(trackRef);
  const { speaking } = useVoiceActivity(participant);
  const videoOn = isTrackReference(trackRef) && Boolean(trackRef.publication?.track) && !muted;
  // Camera-on participants use the animated card border as their active-speaker cue;
  // the audio waveform remains reserved for camera-off avatar cards.
  if (videoOn) return null;
  return <div className="participant-avatar" aria-hidden="true"><div className="participant-avatar-stack"><VoiceRing participant={participant} speaking={speaking}/><ProfilePhoto src={participantPicture(participant.metadata, participant.identity)} name={participantName(participant)} className="participant-avatar-photo" size={512}/></div></div>;
}

let toneContext: AudioContext | null = null;
/** Soft two-note chime for incoming chat messages (synthesised, no audio file needed). */
function playMessageTone() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    toneContext ??= new Ctx();
    const ctx = toneContext;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + 0.02;
    [[880, 0], [1318.5, 0.13]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.28, start + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + delay); osc.stop(start + delay + 0.45);
    });
  } catch { /* Audio can be blocked until the person interacts with the page. */ }
}

/** Short synthesised chime when someone joins (rising) or leaves (falling). */
function playPresenceTone(kind: "joined" | "left") {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    toneContext ??= new Ctx();
    const ctx = toneContext;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + 0.02;
    const notes: Array<[number, number]> = kind === "joined" ? [[523.25, 0], [783.99, 0.12], [1046.5, 0.24]] : [[783.99, 0], [587.33, 0.13], [392, 0.26]];
    notes.forEach(([freq, delay]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.24, start + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.38);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + delay); osc.stop(start + delay + 0.42);
    });
  } catch { /* Audio can be blocked until the person interacts with the page. */ }
}

let ringContext: AudioContext | null = null;
/** Local voice meter: reads the host's own microphone directly (Web Audio) so their waveform reacts instantly instead of waiting for LiveKit's audio-level round trip. Remote participants are untouched. */
const localVoice = {
  level: 0, speaking: false, active: false, analyser: null as AnalyserNode | null,
  listeners: new Set<() => void>(), refs: 0, stop: null as null | (() => void),
};
const emitLocalVoice = () => localVoice.listeners.forEach((listener) => listener());
const localVoiceSnapshot = () => (localVoice.active ? (localVoice.speaking ? 2 : 1) : 0);
const subscribeLocalVoice = (listener: () => void) => { localVoice.listeners.add(listener); return () => { localVoice.listeners.delete(listener); }; };

function startLocalVoice(participant: Participant): () => void {
  let source: MediaStreamAudioSourceNode | null = null;
  let trackId = ""; let frame = 0; let alive = true; let lastCheck = 0; let lastLoud = 0; let floor = 0.004;
  let buf = new Uint8Array(256);
  const setState = (active: boolean, speaking: boolean) => {
    if (localVoice.active === active && localVoice.speaking === speaking) return;
    localVoice.active = active; localVoice.speaking = speaking; emitLocalVoice();
  };
  const detach = () => {
    try { source?.disconnect(); localVoice.analyser?.disconnect(); } catch { /* already disconnected */ }
    source = null; trackId = ""; localVoice.analyser = null; localVoice.level = 0;
  };
  const attach = (): boolean => {
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    const track = publication?.track?.mediaStreamTrack;
    if (!publication || publication.isMuted || !track || track.readyState !== "live") { detach(); return false; }
    if (track.id === trackId && localVoice.analyser) return true;
    detach();
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return false;
      ringContext ??= new Ctx();
      if (ringContext.state === "suspended") void ringContext.resume();
      source = ringContext.createMediaStreamSource(new MediaStream([track]));
      const analyser = ringContext.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser); // analysis only: never routed to the speakers
      localVoice.analyser = analyser; trackId = track.id; buf = new Uint8Array(analyser.fftSize);
      return true;
    } catch { detach(); return false; }
  };
  const tick = (now: number) => {
    if (!alive) return;
    if (now - lastCheck > 500) { lastCheck = now; attach(); }
    const analyser = localVoice.analyser;
    if (!analyser || !ringContext || ringContext.state !== "running") {
      if (ringContext?.state === "suspended") void ringContext.resume();
      localVoice.level = 0; setState(false, false);
      frame = window.requestAnimationFrame(tick); return;
    }
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const raw = Math.sqrt(sum / buf.length);
    localVoice.level += (raw - localVoice.level) * (raw > localVoice.level ? 0.7 : 0.15); // fast attack, gentle release
    const threshold = Math.max(0.012, floor * 3.5);
    let speaking = localVoice.speaking;
    if (localVoice.level > threshold) { lastLoud = now; speaking = true; }
    else if (now - lastLoud > 350) { speaking = false; floor += (raw - floor) * 0.02; } // adapt to room noise only while quiet
    setState(true, speaking);
    frame = window.requestAnimationFrame(tick);
  };
  const begin = () => { if (!alive || frame) return; frame = window.requestAnimationFrame(tick); };
  const pause = () => { window.cancelAnimationFrame(frame); frame = 0; localVoice.level = 0; setState(false, false); }; // hidden tab: fall back to LiveKit
  const onVisibility = () => { if (document.hidden) pause(); else { lastCheck = 0; begin(); } };
  const onTracksChanged = () => { lastCheck = 0; attach(); };
  const events = [ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted, ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished] as const;
  events.forEach((event) => participant.on(event, onTracksChanged));
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) begin();
  return () => {
    alive = false; window.cancelAnimationFrame(frame); frame = 0;
    events.forEach((event) => participant.off(event, onTracksChanged));
    document.removeEventListener("visibilitychange", onVisibility);
    detach(); localVoice.speaking = false; localVoice.active = false; emitLocalVoice();
  };
}

/** Speaking state for a participant. For the local participant it comes from the local microphone analyser (instant); for everyone else, and whenever the analyser is unavailable, it is LiveKit's value. */
function useVoiceActivity(participant: Participant | undefined): { speaking: boolean; live: boolean } {
  const isLocal = Boolean(participant?.isLocal);
  useEffect(() => {
    if (!participant || !participant.isLocal) return;
    if (++localVoice.refs === 1) localVoice.stop = startLocalVoice(participant);
    return () => { if (--localVoice.refs === 0) { localVoice.stop?.(); localVoice.stop = null; } };
  }, [participant, isLocal]);
  const snapshot = useSyncExternalStore(subscribeLocalVoice, localVoiceSnapshot, localVoiceSnapshot);
  if (isLocal && snapshot > 0) return { speaking: snapshot === 2, live: true };
  return { speaking: Boolean(participant?.isSpeaking), live: false };
}
/** Current voice level (0..1) driving the animations: local analyser for the host's own tile, LiveKit's audioLevel otherwise. */
const voiceLevel = (participant: Participant) => (participant.isLocal && localVoice.active ? localVoice.level : participant.audioLevel);

/** Real-time frequency analyser for a participant's microphone track (null until the track is available). */
function createMicAnalyser(participant: Participant): { analyser: AnalyserNode; trackId: string; source: MediaStreamAudioSourceNode } | null {
  try {
    const track = participant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (!track || track.readyState !== "live") return null;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    ringContext ??= new Ctx();
    if (ringContext.state === "suspended") void ringContext.resume();
    const source = ringContext.createMediaStreamSource(new MediaStream([track]));
    const analyser = ringContext.createAnalyser();
    analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser); // analysis only: never connected to the speakers, so nothing is heard twice
    return { analyser, trackId: track.id, source };
  } catch { return null; }
}

const RING_BARS = 72;
/** Circular voice spectrum around the profile photo (like a music visualiser). Drawn only while the person is speaking and driven by their live voice volume. */
function VoiceRing({ participant, speaking }: { participant: Participant; speaking: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speakingRef = useRef(speaking);
  const runningRef = useRef(false);
  const startRef = useRef<() => void>(() => {});
  speakingRef.current = speaking;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bars = new Float32Array(RING_BARS);
    const targets = new Float32Array(RING_BARS);
    let mic: ReturnType<typeof createMicAnalyser> = null;
    let lastMicCheck = 0;
    let data = new Uint8Array(128);
    let presence = 0; let frame = 0; let alive = true;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const releaseMic = () => { try { mic?.source.disconnect(); mic?.analyser.disconnect(); } catch { /* already disconnected */ } mic = null; };
    const draw = (now: number) => {
      if (!alive) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = canvas.clientWidth;
      if (size < 8) { frame = window.requestAnimationFrame(draw); return; }
      if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
      const isSpeaking = speakingRef.current;
      presence += ((isSpeaking ? 1 : 0) - presence) * (isSpeaking ? (participant.isLocal && localVoice.active ? 0.6 : 0.22) : 0.12);
      // (Re)connect to the live microphone track when it appears or changes.
      const localLive = participant.isLocal && localVoice.active && Boolean(localVoice.analyser);
      const currentTrack = participant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (localLive) { if (mic) releaseMic(); } // the host's own analyser is shared and always ready: no connect delay
      else if (isSpeaking && now - lastMicCheck > 400) {
        lastMicCheck = now;
        if (mic && (!currentTrack || mic.trackId !== currentTrack.id)) releaseMic();
        if (!mic) { mic = createMicAnalyser(participant); if (mic) data = new Uint8Array(mic.analyser.frequencyBinCount); }
      }
      const analyser = localLive ? localVoice.analyser : mic?.analyser ?? null;
      const level = isSpeaking ? Math.min(1, voiceLevel(participant) * 2.2) : 0;
      let spectrumEnergy = 0;
      if (analyser && isSpeaking) {
        if (data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data); for (let i = 2; i < 30; i++) spectrumEnergy += data[i]; spectrumEnergy /= 28 * 255;
      }
      const half = RING_BARS / 2;
      for (let i = 0; i < RING_BARS; i++) {
        const k = i <= half ? i : RING_BARS - i; // mirrored: lows at the top, highs at the bottom
        const position = k / half;
        let target = 0;
        if (isSpeaking) {
          if (analyser && spectrumEnergy > 0.004) {
            const bin = 2 + Math.floor(position * 26);
            target = (data[bin] / 255) * (1 + position * 1.5) * 1.25;
          } else {
            // Fallback when the browser gives no spectrum: shape LiveKit's audio level into a lively, natural-looking ring.
            const wobble = 0.55 + 0.45 * Math.sin(now / 130 + i * 0.9) * Math.sin(now / 310 + i * 0.35);
            target = level * wobble * (1 - position * 0.35);
          }
        }
        targets[i] = Math.max(0, Math.min(1, target));
      }
      for (let i = 0; i < RING_BARS; i++) {
        const smooth = (targets[(i + RING_BARS - 1) % RING_BARS] + targets[i] * 2 + targets[(i + 1) % RING_BARS]) / 4;
        const rate = reduceMotion ? 1 : smooth > bars[i] ? (localLive ? 0.85 : 0.55) : 0.14;
        bars[i] += (smooth - bars[i]) * rate;
      }
      const w = canvas.width; const c = w / 2;
      ctx.clearRect(0, 0, w, w);
      if (presence > 0.01) {
        const photoRadius = w * 0.32; // the photo fills 64% of the canvas width
        const innerRadius = photoRadius + w * 0.045;
        const maxLength = c - innerRadius - w * 0.012;
        const dot = Math.max(1.5 * dpr, w * 0.011);
        ctx.globalAlpha = Math.min(1, presence);
        ctx.fillStyle = "#f1d79b"; ctx.strokeStyle = "#f1d79b"; ctx.lineCap = "round";
        ctx.lineWidth = Math.max(1.6 * dpr, (2 * Math.PI * innerRadius / RING_BARS) * 0.52);
        ctx.beginPath();
        for (let i = 0; i < RING_BARS; i++) {
          const angle = -Math.PI / 2 + (i / RING_BARS) * Math.PI * 2;
          const length = dot + Math.pow(bars[i], 0.9) * (maxLength - dot);
          const cos = Math.cos(angle); const sin = Math.sin(angle);
          ctx.moveTo(c + cos * innerRadius, c + sin * innerRadius);
          ctx.lineTo(c + cos * (innerRadius + length), c + sin * (innerRadius + length));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // Stop drawing completely once the person has been quiet and the ring has faded out.
      if (!isSpeaking && presence <= 0.01) { ctx.clearRect(0, 0, w, w); runningRef.current = false; releaseMic(); return; }
      frame = window.requestAnimationFrame(draw);
    };
    startRef.current = () => { if (runningRef.current || !alive) return; runningRef.current = true; frame = window.requestAnimationFrame(draw); };
    if (speakingRef.current) startRef.current();
    return () => { alive = false; runningRef.current = false; window.cancelAnimationFrame(frame); releaseMic(); };
  }, [participant]);
  useEffect(() => { if (speaking) startRef.current(); }, [speaking]);
  return <canvas ref={canvasRef} className="voice-ring" aria-hidden="true"/>;
}

/** Shown only while a participant's microphone is off; nothing at all is shown while it is on. */
function MicOffBadge({ participant }: { participant: Participant }) {
  const [micOn, setMicOn] = useState(participant.isMicrophoneEnabled);
  useEffect(() => {
    const update = () => setMicOn(participant.isMicrophoneEnabled);
    const events = [ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted, ParticipantEvent.TrackPublished, ParticipantEvent.TrackUnpublished, ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished, ParticipantEvent.TrackSubscribed, ParticipantEvent.TrackUnsubscribed] as const;
    update();
    events.forEach((name) => participant.on(name, update));
    return () => { events.forEach((name) => participant.off(name, update)); };
  }, [participant]);
  if (micOn) return null;
  return <span className="mic-off-badge" title="Microphone is off" aria-label="Microphone is off"><MicOff size={13}/></span>;
}

function ShareRedirect() {
  // Fallback for shared links that reach the SPA directly (dev server, cached shell): go straight to the meeting page.
  const { slug = "" } = useParams();
  return <Navigate to={`/meeting/${encodeURIComponent(slug)}`} replace />;
}

/**
 * LiveKit 2.22.x installs a private `onPageLeave` callback for the Chromium
 * Page Lifecycle `freeze` event even when disconnectOnPageLeave is false.
 * There is no public opt-out for that one listener in this SDK line. Remove it
 * only when the callback exists; LiveKit continues to own ICE/signaling recovery.
 */
function preventLiveKitFreezeDisconnect(room: Room) {
  const internalRoom = room as unknown as { onPageLeave?: EventListener };
  const pageLeaveHandler = internalRoom.onPageLeave;
  if (typeof pageLeaveHandler === "function") window.removeEventListener("freeze", pageLeaveHandler);
}

/**
 * Keeps an active LiveKit call usable when the browser backgrounds the page.
 * WebRTC media capture and active real-time connections receive browser-managed
 * treatment, but a page can still be suspended or terminated by the OS. We do
 * not use silent audio or held locks as artificial keep-alives because neither
 * can guarantee background execution and both waste device resources.
 */
function useBackgroundCall(room: ReturnType<typeof useRoomContext>, title: string, onLeave: () => void) {
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;

  useEffect(() => {
    let active = true;
    let audioResumeInFlight: Promise<void> | null = null;
    let audioStartInFlight: Promise<void> | null = null;
    let lastAudioStartAt = 0;
    let lastMicTrack: MediaStreamTrack | null = null;
    let micRecoveryAttemptedForTrack = false;
    const nav = navigator as Navigator & {
      audioSession?: {
        type: string;
        state?: string;
        addEventListener?: (type: string, listener: () => void) => void;
        removeEventListener?: (type: string, listener: () => void) => void;
      };
    };
    const audioSession = nav.audioSession;
    const previousAudioSessionType = audioSession?.type;

    // LiveKit 2.22.x registers the same private page-leave callback for the
    // Chromium Page Lifecycle `freeze` event even when disconnectOnPageLeave
    // is false. Remove only that SDK-installed freeze callback so a sleeping
    // tab can resume through LiveKit's normal reconnect path. This is guarded
    // by runtime feature detection because the callback is not public API.
    const removeSdkFreezeDisconnect = () => preventLiveKitFreezeDisconnect(room);
    removeSdkFreezeDisconnect();
    room.on(RoomEvent.Connected, removeSdkFreezeDisconnect);
    room.on(RoomEvent.Reconnected, removeSdkFreezeDisconnect);

    // Supported by some browsers (notably Safari versions); ignored elsewhere.
    try { if (audioSession) audioSession.type = "play-and-record"; } catch { /* Optional platform integration. */ }

    // Media Session metadata/actions may be exposed on lock screens. They are
    // an integration only, not a background-execution guarantee.
    const session = navigator.mediaSession;
    if (session) {
      const setHandler = (action: string, handler: (() => void) | null) => {
        try { (session.setActionHandler as (name: string, callback: (() => void) | null) => void).call(session, action, handler); }
        catch { /* This browser does not implement the optional action. */ }
      };
      try {
        if (typeof MediaMetadata !== "undefined") {
          session.metadata = new MediaMetadata({
            title,
            artist: "MEET ENIHAKOLE",
            album: "Live gathering",
            artwork: [
              { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
              { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            ],
          });
        }
        session.playbackState = room.state === ConnectionState.Connected ? "playing" : "none";
      } catch { /* Metadata is cosmetic and not available in every browser. */ }
      setHandler("hangup", () => leaveRef.current());
      setHandler("togglemicrophone", () => {
        void room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled).catch(() => undefined);
      });
    }

    const resumeAudio = () => {
      if (!active || document.visibilityState === "hidden" || audioResumeInFlight || audioSession?.state === "interrupted") return;
      audioResumeInFlight = (async () => {
        // Wait for the platform to release an active audio interruption, then
        // reopen Web Audio contexts the browser suspended in the background.
        // LiveKit owns its signaling/ICE reconnection and media retransmission.
        if (toneContext?.state === "suspended") await toneContext.resume().catch(() => undefined);
        if (!active) return;
        if (ringContext?.state === "suspended") await ringContext.resume().catch(() => undefined);
        if (!active) return;

        // Some mobile browsers end an active capture track during an OS audio
        // interruption. Restart only an ended track that the user had left on;
        // never toggle a muted microphone or silently override the user's choice.
        const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const localTrack = publication?.track as {
          mediaStreamTrack?: MediaStreamTrack;
          restartTrack?: () => Promise<void>;
        } | undefined;
        const mediaTrack = localTrack?.mediaStreamTrack ?? null;
        if (mediaTrack !== lastMicTrack) {
          lastMicTrack = mediaTrack;
          micRecoveryAttemptedForTrack = false;
        }
        if (
          room.localParticipant.isMicrophoneEnabled &&
          mediaTrack?.readyState === "ended" &&
          typeof localTrack?.restartTrack === "function" &&
          !micRecoveryAttemptedForTrack
        ) {
          // Avoid repeated permission/restart attempts for the same failed capture.
          micRecoveryAttemptedForTrack = true;
          await localTrack.restartTrack().catch(async () => {
            // Mark the failed capture as off so the in-room control and status
            // indicator cannot imply that audio is still being transmitted.
            await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
            window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Your microphone stopped in the background and is now off. Tap Unmute to request access again." } }));
          });
        }
      })().finally(() => { audioResumeInFlight = null; });
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") resumeAudio();
    };
    const onRoomRestored = () => {
      if (session) { try { session.playbackState = "playing"; } catch { /* Optional media integration. */ } }
      resumeAudio();
    };
    const onRoomDisconnected = () => {
      if (session) { try { session.playbackState = "none"; } catch { /* Optional media integration. */ } }
    };
    const onUserGesture = () => {
      // LiveKit documents startAudio() as a user-gesture operation when the
      // browser has blocked remote playback; do not call it from a timer.
      // Coalesce rapid taps/keys instead of repeatedly restarting its audio sink.
      if (!audioStartInFlight && Date.now() - lastAudioStartAt > 1000) {
        lastAudioStartAt = Date.now();
        audioStartInFlight = room.startAudio().catch(() => undefined).finally(() => { audioStartInFlight = null; });
      }
      resumeAudio();
    };
    const onAudioSessionStateChange = () => {
      if (audioSession?.state === "active") resumeAudio();
    };

    document.addEventListener("visibilitychange", onVisible);
    // A real input gesture can unlock remote audio playback after an OS or
    // browser interruption. The audio start call runs synchronously in-event.
    document.addEventListener("pointerdown", onUserGesture, true);
    document.addEventListener("keydown", onUserGesture, true);
    audioSession?.addEventListener?.("statechange", onAudioSessionStateChange);
    // `resume` is part of Chromium's Page Lifecycle API. The other events cover
    // Safari/iOS and normal tab/window restoration without assuming support.
    document.addEventListener("resume", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    room.on(RoomEvent.Connected, onRoomRestored);
    room.on(RoomEvent.Reconnected, onRoomRestored);
    room.on(RoomEvent.Disconnected, onRoomDisconnected);

    if (document.visibilityState === "visible") resumeAudio();

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onUserGesture, true);
      document.removeEventListener("keydown", onUserGesture, true);
      audioSession?.removeEventListener?.("statechange", onAudioSessionStateChange);
      document.removeEventListener("resume", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      room.off(RoomEvent.Connected, onRoomRestored);
      room.off(RoomEvent.Reconnected, onRoomRestored);
      room.off(RoomEvent.Disconnected, onRoomDisconnected);
      room.off(RoomEvent.Connected, removeSdkFreezeDisconnect);
      room.off(RoomEvent.Reconnected, removeSdkFreezeDisconnect);
      if (session) {
        const clearHandler = (action: string) => {
          try { (session.setActionHandler as (name: string, callback: null) => void).call(session, action, null); }
          catch { /* Optional action. */ }
        };
        clearHandler("hangup");
        clearHandler("togglemicrophone");
        try { session.metadata = null; session.playbackState = "none"; } catch { /* Ignore unsupported cleanup. */ }
      }
      if (audioSession && previousAudioSessionType !== undefined) {
        try { audioSession.type = previousAudioSessionType; } catch { /* Optional platform integration. */ }
      }
    };
  }, [room, title]);
}

type AnnotationArrow = { id: string; x1: number; y1: number; x2: number; y2: number };
type AnnotationMessage =
  | { k: "arrow"; arrow: AnnotationArrow }
  | { k: "pointer"; x: number; y: number; on: boolean }
  | { k: "remove"; id: string }
  | { k: "clear" }
  | { k: "visible"; on: boolean }
  | { k: "sync"; arrows: AnnotationArrow[]; visible: boolean; pointer?: { x: number; y: number } | null }
  | { k: "hello" };
type AnnotationTool = "off" | "pointer" | "arrow";
const ANNOTATION_TOPIC = "meet-enihakole-annotate";
/** Realtime channel (LiveKit data channel) that keeps every participant's notes in step while anyone types. */
const NOTES_TOPIC = "meet-enihakole-notes";
type NotesCache = { title: string; html: string; revision: number; updatedByName: string };
/** Caret position as plain-text offsets so a remote update can be applied without throwing the cursor back to the start. */
function readCaretOffsets(editor: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  const measure = (node: Node, offset: number) => { const probe = document.createRange(); probe.selectNodeContents(editor); probe.setEnd(node, offset); return probe.toString().length; };
  return { start: measure(range.startContainer, range.startOffset), end: measure(range.endContainer, range.endOffset) };
}
function restoreCaretOffsets(editor: HTMLElement, offsets: { start: number; end: number }) {
  const selection = window.getSelection();
  if (!selection) return;
  const locate = (target: number) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = target; let node = walker.nextNode();
    while (node) { const length = node.textContent?.length ?? 0; if (remaining <= length) return { node, offset: remaining }; remaining -= length; node = walker.nextNode(); }
    return { node: editor, offset: editor.childNodes.length };
  };
  try {
    const from = locate(offsets.start); const to = locate(offsets.end);
    const range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    selection.removeAllRanges(); selection.addRange(range);
  } catch { /* A caret that cannot be restored is harmless. */ }
}
const MAX_ANNOTATION_ARROWS = 30;
const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
function cleanArrow(raw: unknown): AnnotationArrow | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || a.id.length > 64) return null;
  return { id: a.id, x1: unit(a.x1), y1: unit(a.y1), x2: unit(a.x2), y2: unit(a.y2) };
}
/** The arrow as drawing parts (shaft + head) in pixels, for a drawing area of width w and height h. */
function arrowShape(a: AnnotationArrow, w: number, h: number) {
  const x1 = a.x1 * w, y1 = a.y1 * h, x2 = a.x2 * w, y2 = a.y2 * h;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.min(30, Math.max(14, Math.min(w, h) * 0.04));
  const spread = Math.PI / 7;
  const bx = x2 - Math.cos(angle) * head * 0.8, by = y2 - Math.sin(angle) * head * 0.8;
  const left = `${x2 - Math.cos(angle - spread) * head},${y2 - Math.sin(angle - spread) * head}`;
  const right = `${x2 - Math.cos(angle + spread) * head},${y2 - Math.sin(angle + spread) * head}`;
  return { x1, y1, bx, by, points: `${x2},${y2} ${left} ${right}` };
}
function AnnotationArrowShape({ arrow, w, h, draft }: { arrow: AnnotationArrow; w: number; h: number; draft?: boolean }) {
  const shape = arrowShape(arrow, w, h);
  return <g className={draft ? "annotate-arrow annotate-arrow-draft" : "annotate-arrow"}>
    <line x1={shape.x1} y1={shape.y1} x2={shape.bx} y2={shape.by} className="annotate-arrow-outline" strokeLinecap="round"/>
    <polygon points={shape.points} className="annotate-arrow-outline" strokeLinejoin="round"/>
    <line x1={shape.x1} y1={shape.y1} x2={shape.bx} y2={shape.by} className="annotate-arrow-line" strokeLinecap="round"/>
    <polygon points={shape.points} className="annotate-arrow-head" strokeLinejoin="round"/>
  </g>;
}

/** The big shared screen. The presenter gets pointer / arrow tools drawn over it; everyone else sees them live, exactly where the presenter put them. */
function ScreenShareStage({ screenShare, onStop, onSwitch }: { screenShare: TrackReference; onStop: () => void; onSwitch: () => void }) {
  const room = useRoomContext();
  const isPresenter = screenShare.participant.isLocal;
  const presenterId = screenShare.participant.identity;
  const presenterName = participantName(screenShare.participant) || "Someone";
  const [tool, setTool] = useState<AnnotationTool>("off");
  const [arrows, setArrows] = useState<AnnotationArrow[]>([]);
  const [visible, setVisible] = useState(true);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<AnnotationArrow | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const arrowsRef = useRef(arrows);
  const visibleRef = useRef(visible);
  const pointerRef = useRef(pointer);
  const lastPointerSend = useRef(0);
  const drawing = useRef(false);
  arrowsRef.current = arrows;
  visibleRef.current = visible;
  pointerRef.current = pointer;

  const send = useCallback((message: AnnotationMessage, reliable = true, to?: string[]) => {
    try {
      void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable, topic: ANNOTATION_TOPIC, ...(to ? { destinationIdentities: to } : {}) }).catch(() => { /* A dropped pointer update is harmless. */ });
    } catch { /* Room may be reconnecting. */ }
  }, [room]);

  // Where the shared picture really is inside the box (it is letterboxed), so a point means the same spot on every screen and device.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let video: HTMLVideoElement | null = null;
    const measure = () => {
      const dims = screenShare.publication?.dimensions;
      const vw = (video && video.videoWidth) || dims?.width || 0;
      const vh = (video && video.videoHeight) || dims?.height || 0;
      const w = view.clientWidth, h = view.clientHeight;
      if (!vw || !vh || !w || !h) {
        setBox((current) => current ? null : current);
        return;
      }
      const ratio = vw / vh;
      const width = w / h > ratio ? h * ratio : w;
      const height = w / h > ratio ? h : w / ratio;
      const next = { left: Math.round((w - width) / 2), top: Math.round((h - height) / 2), width: Math.round(width), height: Math.round(height) };
      setBox((current) => current && current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height ? current : next);
    };
    const bindVideo = () => {
      const next = view.querySelector("video");
      if (next === video) { measure(); return; }
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("loadeddata", measure);
      video?.removeEventListener("resize", measure);
      video = next;
      video?.addEventListener("loadedmetadata", measure);
      video?.addEventListener("loadeddata", measure);
      video?.addEventListener("resize", measure);
      measure();
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(view);
    const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(bindVideo) : null;
    mutations?.observe(view, { childList: true, subtree: true });
    window.addEventListener("resize", measure, { passive: true });
    window.visualViewport?.addEventListener("resize", measure, { passive: true });
    bindVideo();
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("loadeddata", measure);
      video?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [screenShare.publication, tool]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
      if (topic !== ANNOTATION_TOPIC || !participant) return;
      let data: AnnotationMessage;
      try { data = JSON.parse(new TextDecoder().decode(payload)) as AnnotationMessage; } catch { return; }
      if (isPresenter) {
        // A viewer who just arrived asks for what is already drawn.
        if (data.k === "hello") send({ k: "sync", arrows: arrowsRef.current, visible: visibleRef.current, pointer: pointerRef.current }, true, [participant.identity]);
        return;
      }
      if (participant.identity !== presenterId) return; // Only the person presenting can draw.
      if (data.k === "arrow") { const arrow = cleanArrow(data.arrow); if (arrow) setArrows((current) => [...current.filter((item) => item.id !== arrow.id), arrow].slice(-MAX_ANNOTATION_ARROWS)); }
      else if (data.k === "pointer") setPointer(data.on ? { x: unit(data.x), y: unit(data.y) } : null);
      else if (data.k === "remove" && typeof data.id === "string") setArrows((current) => current.filter((item) => item.id !== data.id));
      else if (data.k === "clear") setArrows([]);
      else if (data.k === "visible") { setVisible(Boolean(data.on)); if (!data.on) setPointer(null); }
      else if (data.k === "sync") {
        setArrows((Array.isArray(data.arrows) ? data.arrows : []).map(cleanArrow).filter((item): item is AnnotationArrow => Boolean(item)).slice(-MAX_ANNOTATION_ARROWS));
        setVisible(data.visible !== false);
        setPointer(data.pointer && typeof data.pointer === "object" ? { x: unit(data.pointer.x), y: unit(data.pointer.y) } : null);
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    if (!isPresenter) send({ k: "hello" }, true, [presenterId]);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, isPresenter, presenterId, send]);

  const point = (event: ReactPointerEvent) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return { x: unit((event.clientX - rect.left) / rect.width), y: unit((event.clientY - rect.top) / rect.height) };
  };
  const sendPointer = (position: { x: number; y: number } | null, force = false) => {
    if (position) {
      const now = Date.now();
      if (!force && now - lastPointerSend.current < 40) return;
      lastPointerSend.current = now;
      send({ k: "pointer", x: position.x, y: position.y, on: true }, false);
    } else send({ k: "pointer", x: 0, y: 0, on: false }, true);
  };
  const choose = (next: AnnotationTool) => {
    const value = tool === next ? "off" : next;
    setTool(value); setPointer(null); setDraft(null); drawing.current = false;
    sendPointer(null);
    if (value !== "off" && !visible) { setVisible(true); send({ k: "visible", on: true }); }
  };
  const clearAll = () => { setArrows([]); setDraft(null); send({ k: "clear" }); };
  const undoLast = () => {
    const last = arrowsRef.current[arrowsRef.current.length - 1];
    if (!last) return;
    setArrows((current) => current.filter((item) => item.id !== last.id));
    send({ k: "remove", id: last.id });
  };
  const toggleVisible = () => {
    const next = !visible;
    setVisible(next); setPointer(null);
    if (!next) { setTool("off"); setDraft(null); sendPointer(null); }
    send({ k: "visible", on: next });
  };
  const onDown = (event: ReactPointerEvent) => {
    if (!isPresenter || tool === "off") return;
    const position = point(event); if (!position) return;
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Capture is optional. */ }
    drawing.current = true;
    if (tool === "pointer") { setPointer(position); sendPointer(position, true); }
    else setDraft({ id: `${presenterId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, x1: position.x, y1: position.y, x2: position.x, y2: position.y });
  };
  const onMove = (event: ReactPointerEvent) => {
    if (!isPresenter || tool === "off") return;
    const position = point(event); if (!position) return;
    if (tool === "pointer") { setPointer(position); sendPointer(position); }
    else if (drawing.current) setDraft((current) => current ? { ...current, x2: position.x, y2: position.y } : current);
  };
  const onUp = (event: ReactPointerEvent) => {
    if (!isPresenter || tool === "off") return;
    const wasDrawing = drawing.current; drawing.current = false;
    if (tool === "pointer") { if (event.pointerType !== "mouse") { setPointer(null); sendPointer(null); } return; }
    if (!wasDrawing || !draft) return;
    const length = Math.hypot((draft.x2 - draft.x1) * (box?.width ?? 1), (draft.y2 - draft.y1) * (box?.height ?? 1));
    setDraft(null);
    if (length < 18) return; // A tap is not an arrow.
    setArrows((current) => [...current, draft].slice(-MAX_ANNOTATION_ARROWS));
    send({ k: "arrow", arrow: draft });
  };
  const onLeave = () => { if (tool === "pointer" && !drawing.current) { setPointer(null); sendPointer(null); } };
  const onCancel = () => { drawing.current = false; setDraft(null); if (tool === "pointer") { setPointer(null); sendPointer(null); } };
  const onLostCapture = () => { if (tool === "arrow") { drawing.current = false; setDraft(null); } };

  const shown = visible && box;
  const drawingOn = isPresenter && tool !== "off";
  return <div className="screen-share-view" ref={viewRef}>
    {isPresenter && !drawingOn
      ? <div className="screen-share-self"><MonitorUp size={34}/><b>You are presenting your screen</b><span>Everyone in the meeting can see it. Use the tools below to point things out.</span></div>
      : isPresenter
        ? (screenShare.publication?.track ? <VideoTrack trackRef={screenShare}/> : null)
        : <VideoTrack trackRef={screenShare}/>}
    {box && <div ref={layerRef} className={`screen-annotate-layer ${drawingOn ? "is-drawing" : ""} ${tool === "arrow" ? "tool-arrow" : tool === "pointer" ? "tool-pointer" : ""}`} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave} onPointerCancel={onCancel} onLostPointerCapture={onLostCapture}>
      {shown && <svg className="screen-annotate-svg" width={box.width} height={box.height} aria-hidden="true">
        {arrows.map((arrow) => <AnnotationArrowShape key={arrow.id} arrow={arrow} w={box.width} h={box.height}/>)}
        {draft && <AnnotationArrowShape arrow={draft} w={box.width} h={box.height} draft/>}
      </svg>}
      {shown && pointer && <span className="annotate-pointer" style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%` }}><i/><b>{isPresenter ? "You" : presenterName}</b></span>}
    </div>}
    <div className="screen-share-label"><MonitorUp size={14}/><span>{isPresenter ? "You are presenting" : `${presenterName} is presenting`}</span>{isPresenter && <><button type="button" className="screen-share-switch" onClick={onSwitch}>Switch</button><button type="button" className="screen-share-stop" onClick={onStop}>Stop sharing</button></>}</div>
    {isPresenter && <div className="screen-annotate-toolbar" role="toolbar" aria-label="Presenter annotation tools">
      <button type="button" className={tool === "pointer" ? "is-active" : ""} aria-pressed={tool === "pointer"} onClick={() => choose("pointer")} title="Pointer: everyone sees where you point" aria-label="Pointer"><MousePointer2 size={16}/><span>Pointer</span></button>
      <button type="button" className={tool === "arrow" ? "is-active" : ""} aria-pressed={tool === "arrow"} onClick={() => choose("arrow")} title="Arrow: drag to draw a directional arrow" aria-label="Arrow"><MoveUpRight size={16}/><span>Arrow</span></button>
      <button type="button" onClick={undoLast} disabled={arrows.length === 0} title="Remove the most recent arrow" aria-label="Undo last arrow"><Undo2 size={16}/><span>Undo</span></button>
      <button type="button" onClick={clearAll} disabled={arrows.length === 0} title="Clear all arrows" aria-label="Clear arrows"><Eraser size={16}/><span>Clear</span></button>
      <button type="button" className={!visible ? "is-active" : ""} aria-pressed={!visible} onClick={toggleVisible} title={visible ? "Hide annotations for everyone" : "Show annotations for everyone"} aria-label={visible ? "Hide annotations" : "Show annotations"}>{visible ? <EyeOff size={16}/> : <Eye size={16}/>}<span>{visible ? "Hide" : "Show"}</span></button>
      {drawingOn && <span className="screen-annotate-hint"><PenLine size={12}/>{tool === "arrow" ? "Drag on the preview to draw" : "Move over the preview to point"}</span>}
    </div>}
  </div>;
}

function ConferenceWorkspace({ meeting, role, onLeave, onEndForEveryone, ending, isActive }: { meeting: Meeting; role: "host" | "participant"; onLeave: () => void; onEndForEveryone: () => void; ending: boolean; isActive: boolean }) {
  const room = useRoomContext();
  const { theme, toggleTheme } = useAppContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const trackRefs = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const screenRefs = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }], { onlySubscribed: false });
  // Whoever is presenting right now (their screen has arrived), shown big for everyone.
  const screenShare = screenRefs.filter((item): item is TrackReference => isTrackReference(item) && (item.participant.isLocal || Boolean(item.publication?.track))).slice(-1)[0];
  const { chatMessages, send, isSending } = useChat();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleViewTab, setPeopleViewTab] = useState<"people" | "private">("people");
  const [notesOpen, setNotesOpen] = useState(false);
  // Notes are cache-first: the last known copy is ready instantly (and preloaded below), then refreshed quietly in the background.
  const notesCacheKey = `notes:${meeting.slug}`;
  const [notesTitle, setNotesTitle] = useState(() => readCache<NotesCache>(notesCacheKey)?.value.title || "Meeting notes");
  const [notesHtml, setNotesHtml] = useState(() => readCache<NotesCache>(notesCacheKey)?.value.html || "");
  const [notesRevision, setNotesRevision] = useState(() => readCache<NotesCache>(notesCacheKey)?.value.revision || 0);
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesConflict, setNotesConflict] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [notesUpdatedBy, setNotesUpdatedBy] = useState(() => readCache<NotesCache>(notesCacheKey)?.value.updatedByName || "");
  const [recordingState, setRecordingState] = useState<MeetingRecordingState | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingConsentBusy, setRecordingConsentBusy] = useState(false);
  const [directContact, setDirectContact] = useState<DirectContact | null>(null);
  const [privateMessages, setPrivateMessages] = useState<PrivateMessage[]>([]);
  const [recentConversations, setRecentConversations] = useState<PrivateConversationSummary[]>([]);
  const [privateDraft, setPrivateDraft] = useState("");
  const [privateLoading, setPrivateLoading] = useState(false);
  const [privateSending, setPrivateSending] = useState(false);
  const [privateNotice, setPrivateNotice] = useState<DirectContact | null>(null);
  const [moderatorRequest, setModeratorRequest] = useState<{ media: "microphone" | "camera"; hostName: string } | null>(null);
  const [moderationBusy, setModerationBusy] = useState<string | null>(null);
  const [spotlightIdentity, setSpotlightIdentity] = useState<string | null>(null);
  const [videoQualityMode, setVideoQualityMode] = useState<VideoQualityMode>(readVideoQualityChoice);
  const [videoQualityMenuOpen, setVideoQualityMenuOpen] = useState(false);
  const [videoDiagnosticsOpen, setVideoDiagnosticsOpen] = useState(false);
  const [videoProfileBusy, setVideoProfileBusy] = useState(false);
  const [localVideoStats, setLocalVideoStats] = useState<VideoStatsSnapshot | null>(null);
  const [remoteVideoStats, setRemoteVideoStats] = useState<VideoStatsSnapshot | null>(null);
  const [remoteStatsName, setRemoteStatsName] = useState("");
  const localStatsCounter = useRef<VideoStatsCounter | undefined>(undefined);
  const remoteStatsCounter = useRef<VideoStatsCounter | undefined>(undefined);
  const autoCaptureHeight = useRef<VideoQualityHeight>(720);
  const autoGoodSamples = useRef(0);
  const autoPoorSamples = useRef(0);
  const videoProfileKey = useRef("");
  const [mediaModal, setMediaModal] = useState<{ kind: MediaKind; state: MicPromptState } | null>(null);
  const mediaAttemptRef = useRef(0);
  const [messageText, setMessageText] = useState("");
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Record<string, boolean>>({});
  const [handRaised, setHandRaised] = useState(false);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [page, setPage] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const [pseudoFull, setPseudoFull] = useState(false);
  const [fullscreenPrompt, setFullscreenPrompt] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const dockRef = useRef<HTMLDivElement>(null);
  const fullScreenStateRef = useRef(false);
  const [topSpeaker, setTopSpeaker] = useState("");
  const [messageToast, setMessageToast] = useState<{ id: number; name: string; text: string } | null>(null);
  const [presenceToasts, setPresenceToasts] = useState<Array<{ id: number; kind: "joined" | "left"; name: string }>>([]);
  const presenceTimers = useRef<number[]>([]);
  const pseudoFullRef = useRef(false);
  const lastFullscreenAction = useRef(0);
  const suppressNextClick = useRef(false);
  const overlayOpenRef = useRef(false);
  const messagesOpenRef = useRef(false);
  const seenMessages = useRef(chatMessages.length);
  const messageToastTimer = useRef(0);
  const fullScreenRef = useRef<HTMLDivElement>(null);
  const autoFullscreenDone = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const privateChatEndRef = useRef<HTMLDivElement>(null);
  const notesEditorRef = useRef<HTMLDivElement>(null);
  const notesDirtyRef = useRef(false);
  const notesSavingRef = useRef(false);
  const notesConflictRef = useRef(false);
  const notesHtmlRef = useRef("");
  const notesTitleRef = useRef("Meeting notes");
  const notesRevisionRef = useRef(0);
  const notesSaveTimer = useRef(0);
  const notesLiveTimer = useRef(0);
  const notesLoadedRef = useRef(Boolean(readCache<NotesCache>(notesCacheKey)));
  const notesBaseRef = useRef(readCache<NotesCache>(notesCacheKey)?.value.html || "");
  const directContactRef = useRef<DirectContact | null>(null);
  const privateNoticeTimer = useRef(0);
  const localIdentity = localParticipant.identity;
  const localUserId = participantUserId(localParticipant);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  directContactRef.current = directContact;
  notesHtmlRef.current = notesHtml;
  notesTitleRef.current = notesTitle;
  notesRevisionRef.current = notesRevision;
  notesSavingRef.current = notesSaving;
  const localVoiceActivity = useVoiceActivity(localParticipant);
  useBackgroundCall(room, meeting.title, onLeave);
  // Keep the receive-side jitter buffer as small as the browser safely allows so other people's voices play back with minimal delay.
  useEffect(() => {
    const tune = (track: { kind?: string; setPlayoutDelay?: (seconds: number) => void }) => { if (track.kind === Track.Kind.Audio) { try { track.setPlayoutDelay?.(0.02); } catch { /* unsupported browser: default buffering */ } } };
    room.remoteParticipants.forEach((participant) => participant.audioTrackPublications.forEach((publication) => { if (publication.track) tune(publication.track); }));
    const onSubscribed = (track: { kind?: string; setPlayoutDelay?: (seconds: number) => void }) => tune(track);
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    return () => { room.off(RoomEvent.TrackSubscribed, onSubscribed); };
  }, [room]);
  const [deviceMenu, setDeviceMenu] = useState<"audioinput" | "videoinput" | null>(null);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setInputDevices(devices.filter((device) => device.kind === "audioinput" || device.kind === "videoinput"));
      } catch { /* Device selection remains optional if browser enumeration is blocked. */ }
    };
    void loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices); };
  }, []);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: { identity: string; name?: string }, _kind?: unknown, topic?: string) => {
      if (topic !== "meet-enihakole-ui") return;
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as RoomSignal;
        const identity = participant?.identity || "unknown";
        if (data.kind === "hand") setRaisedHands((current) => ({ ...current, [identity]: data.raised }));
        if (data.kind === "reaction" && REACTION_SET.includes(data.emoji)) {
          const item = makeReaction(`${data.id}-${Math.random().toString(36).slice(2, 6)}`, data.emoji, participant?.name || "A participant");
          setReactions((current) => [...current.slice(-11), item]);
          window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== item.id)), REACTION_LIFETIME);
        }
      } catch { /* Ignore unrelated or malformed room data. */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, participants]);

  // Private messages and moderator requests use reliable, identity-targeted data packets.
  // Message history is stored through the authenticated API, so a reconnect does not lose messages.
  useEffect(() => {
    const onPrivateData = (payload: Uint8Array, sender?: Participant, _kind?: unknown, topic?: string) => {
      if (topic !== PRIVATE_MESSAGE_TOPIC || !sender || !localUserId) return;
      let data: PrivateDataSignal;
      try { data = JSON.parse(new TextDecoder().decode(payload)) as PrivateDataSignal; } catch { return; }
      if (!data || typeof data !== "object" || data.recipientUserId !== localUserId) return;
      if (data.kind === "private-message") {
        const message = data.message;
        if (!message || message.recipientUserId !== localUserId || message.senderUserId !== participantUserId(sender) || typeof message.id !== "string" || typeof message.message !== "string" || message.message.length > 2000) return;
        const contact: DirectContact = {
          userId: message.senderUserId,
          identity: sender.identity,
          name: message.senderName || sender.name || "Participant",
          picture: participantPicture(sender.metadata, sender.identity),
        };
        setRecentConversations((current) => [
          { userId: contact.userId, name: contact.name, picture: contact.picture, lastMessage: message.message, createdAt: message.createdAt },
          ...current.filter((item) => item.userId !== contact.userId),
        ].slice(0, 30));
        if (directContactRef.current?.userId === contact.userId) {
          setPrivateMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-200));
        } else {
          setPrivateNotice(contact);
          window.clearTimeout(privateNoticeTimer.current);
          privateNoticeTimer.current = window.setTimeout(() => setPrivateNotice(null), 7000);
        }
      } else if (data.kind === "moderator-request") {
        let senderRole = "";
        try { senderRole = JSON.parse(sender.metadata || "{}").role || ""; } catch { /* Ignore malformed role metadata. */ }
        if (participantUserId(sender) === meeting.ownerId && senderRole === "host" && (data.media === "microphone" || data.media === "camera")) {
          setModeratorRequest({ media: data.media, hostName: data.hostName || sender.name || "The host" });
        }
      } else if (data.kind === "moderator-media-control") {
        let senderRole = "";
        try { senderRole = JSON.parse(sender.metadata || "{}").role || ""; } catch { /* Ignore malformed role metadata. */ }
        if (participantUserId(sender) !== meeting.ownerId || senderRole !== "host" || data.action !== "disable") return;
        const stopCapture = data.media === "microphone"
          ? localParticipant.setMicrophoneEnabled(false)
          : data.media === "camera" ? localParticipant.setCameraEnabled(false) : Promise.resolve();
        void stopCapture.then(() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: `The host turned off your ${data.media}. You can turn it on again when appropriate.` } }))).catch(() => undefined);
      }
    };
    room.on(RoomEvent.DataReceived, onPrivateData);
    return () => { room.off(RoomEvent.DataReceived, onPrivateData); };
  }, [room, localUserId, localParticipant, meeting.ownerId]);

  useEffect(() => () => window.clearTimeout(privateNoticeTimer.current), []);
  useEffect(() => { privateChatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [privateMessages.length, directContact]);

  // Register the signed-in account even when an existing stored LiveKit token is reused after a refresh.
  // A blocked account is disconnected again if it tries to reconnect with a still-valid token.
  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let retryTimer = 0;
    const register = () => {
      if (cancelled || room.state !== ConnectionState.Connected) return;
      void api.registerParticipantProfile(meeting.slug, localIdentity).catch((cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 403) {
          window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause.message } }));
          onLeaveRef.current();
        } else if (cause instanceof ApiError && cause.status === 409 && retries++ < 3) {
          retryTimer = window.setTimeout(register, 900);
        }
      });
    };
    if (room.state === ConnectionState.Connected) register();
    room.on(RoomEvent.Connected, register);
    room.on(RoomEvent.Reconnected, register);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      room.off(RoomEvent.Connected, register);
      room.off(RoomEvent.Reconnected, register);
      void api.leaveParticipantProfile(meeting.slug, localIdentity).catch(() => undefined);
    };
  }, [room, meeting.slug, localIdentity]);

  // Recording consent and status are server-authoritative and shared with every connected client.
  useEffect(() => {
    if (!RECORDING_UI_ENABLED) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled || room.state !== ConnectionState.Connected) return;
      void api.recordingStatus(meeting.slug, localIdentity)
        .then((result) => { if (!cancelled) setRecordingState(result.recording); })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 4500);
    room.on(RoomEvent.Connected, refresh);
    room.on(RoomEvent.Reconnected, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      room.off(RoomEvent.Connected, refresh);
      room.off(RoomEvent.Reconnected, refresh);
    };
  }, [room, meeting.slug, localIdentity]);

  // Restore the open conversation's persisted history after LiveKit reconnects.
  useEffect(() => {
    const reload = () => {
      const contact = directContactRef.current;
      if (!contact) return;
      void api.privateMessages(meeting.slug, contact.userId).then((result) => setPrivateMessages((current) => {
        const merged = new Map([...result.messages, ...current].map((item) => [item.id, item]));
        return [...merged.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(-200);
      })).catch(() => undefined);
    };
    room.on(RoomEvent.Reconnected, reload);
    return () => { room.off(RoomEvent.Reconnected, reload); };
  }, [room, meeting.slug]);

  useEffect(() => {
    if (!peopleOpen) return;
    let cancelled = false;
    api.privateConversations(meeting.slug)
      .then((result) => { if (!cancelled) setRecentConversations(result.conversations); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [peopleOpen, meeting.slug]);

  useEffect(() => {
    if (!peopleOpen) return;
    const reloadConversations = () => {
      void api.privateConversations(meeting.slug).then((result) => setRecentConversations(result.conversations)).catch(() => undefined);
    };
    room.on(RoomEvent.Reconnected, reloadConversations);
    return () => { room.off(RoomEvent.Reconnected, reloadConversations); };
  }, [room, meeting.slug, peopleOpen]);

  useEffect(() => {
    if (!directContact) return;
    let cancelled = false;
    setPrivateLoading(true);
    api.privateMessages(meeting.slug, directContact.userId)
      .then((result) => { if (!cancelled) setPrivateMessages((current) => {
        const merged = new Map([...result.messages, ...current].map((item) => [item.id, item]));
        return [...merged.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(-200);
      }); })
      .catch((cause) => { if (!cancelled) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not load this private conversation." } })); })
      .finally(() => { if (!cancelled) setPrivateLoading(false); });
    return () => { cancelled = true; };
  }, [meeting.slug, directContact?.userId]);

  // Puts note content into the editor without disturbing a person who is mid-sentence (the caret is restored).
  function paintNotesEditor(html: string) {
    const editor = notesEditorRef.current;
    if (!editor || editor.innerHTML === html) return;
    const caret = document.activeElement === editor ? readCaretOffsets(editor) : null;
    editor.innerHTML = html;
    if (caret) restoreCaretOffsets(editor, caret);
  }

  async function loadMeetingNotes(force = false) {
    if (!force && (notesDirtyRef.current || notesSavingRef.current)) return;
    // Only a first-ever load (or an explicit "Load latest") shows the loading state; everything else is a quiet background refresh.
    if (force || !notesLoadedRef.current) setNotesLoading(true);
    try {
      const result = await api.meetingNotes(meeting.slug);
      // Someone may have started typing while the request was in flight; never overwrite their edit.
      if (!force && (notesDirtyRef.current || notesSavingRef.current)) return;
      const note = result.note;
      const loadedTitle = note.title || "Meeting notes";
      const loadedHtml = note.contentHtml || "";
      const loadedRevision = note.revision || 0;
      notesLoadedRef.current = true;
      notesBaseRef.current = loadedHtml;
      writeCache<NotesCache>(notesCacheKey, { title: loadedTitle, html: loadedHtml, revision: loadedRevision, updatedByName: note.updatedByName || "" });
      if (loadedTitle !== notesTitleRef.current) { setNotesTitle(loadedTitle); notesTitleRef.current = loadedTitle; }
      if (loadedHtml !== notesHtmlRef.current) { setNotesHtml(loadedHtml); notesHtmlRef.current = loadedHtml; }
      setNotesRevision(loadedRevision); notesRevisionRef.current = loadedRevision;
      setNotesUpdatedBy(note.updatedByName || "");
      setNotesDirty(false); notesDirtyRef.current = false;
      setNotesConflict(false); notesConflictRef.current = false; setNotesError("");
      paintNotesEditor(loadedHtml);
    } catch (cause) {
      if (force || !notesLoadedRef.current) setNotesError(cause instanceof Error ? cause.message : "Could not load meeting notes.");
    } finally { setNotesLoading(false); }
  }

  // Sends a small realtime message over the room's data channel so everyone's notes update as the person types.
  function publishNotesSignal(signal: Record<string, unknown>, reliable = true) {
    try {
      void localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ ...signal, name: participantName(localParticipant) || "A participant" })), { reliable, topic: NOTES_TOPIC }).catch(() => { /* The next save broadcast or background refresh catches everyone up. */ });
    } catch { /* Not connected yet. */ }
  }
  function broadcastNotesLive() {
    if (notesLiveTimer.current) return;
    notesLiveTimer.current = window.setTimeout(() => {
      notesLiveTimer.current = 0;
      const html = notesHtmlRef.current;
      // Long notes exceed a safe data-channel packet; those peers catch up from the "saved" signal instead.
      if (new TextEncoder().encode(html).length > 12_000) return;
      publishNotesSignal({ kind: "live", html, title: notesTitleRef.current });
    }, 160);
  }
  // Applies another participant's live edit, unless this person is typing (their own save would then be reconciled as usual).
  function applyRemoteNotes(data: { html?: string; title?: string; name?: string }) {
    if (notesDirtyRef.current || notesSavingRef.current || notesConflictRef.current) return;
    const html = typeof data.html === "string" ? data.html : notesHtmlRef.current;
    const title = typeof data.title === "string" && data.title ? data.title : notesTitleRef.current;
    if (html === notesHtmlRef.current && title === notesTitleRef.current) return;
    notesHtmlRef.current = html; notesTitleRef.current = title; notesBaseRef.current = html;
    setNotesHtml(html); setNotesTitle(title);
    if (data.name) setNotesUpdatedBy(data.name);
    writeCache<NotesCache>(notesCacheKey, { title, html, revision: notesRevisionRef.current, updatedByName: data.name || "" });
    paintNotesEditor(html);
  }

  async function saveMeetingNotes(force = false) {
    if (!notesDirtyRef.current || notesSavingRef.current) return;
    const title = notesTitleRef.current.trim() || "Meeting notes";
    const contentHtml = notesHtmlRef.current;
    const expectedRevision = notesRevisionRef.current;
    setNotesSaving(true); notesSavingRef.current = true;
    let saved = false;
    try {
      const result = await api.saveMeetingNotes(meeting.slug, { title, contentHtml, expectedRevision, force });
      saved = true;
      setNotesRevision(result.note.revision); notesRevisionRef.current = result.note.revision;
      setNotesUpdatedBy(result.note.updatedByName || "");
      notesBaseRef.current = contentHtml;
      writeCache<NotesCache>(notesCacheKey, { title, html: contentHtml, revision: result.note.revision, updatedByName: result.note.updatedByName || "" });
      // Tell everyone else a new version exists so they refresh it in the background.
      publishNotesSignal({ kind: "saved", revision: result.note.revision });
      setNotesConflict(false); notesConflictRef.current = false; setNotesError("");
      if (notesHtmlRef.current === contentHtml && notesTitleRef.current.trim() === title) {
        setNotesDirty(false); notesDirtyRef.current = false;
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // If the newest server copy is exactly what this edit was based on, nobody else changed anything in between
        // (our revision number was just behind), so the edit is safely retried on top of it.
        let reconciled = false;
        try {
          const latest = (await api.meetingNotes(meeting.slug)).note;
          if ((latest.contentHtml || "") === notesBaseRef.current && !force) {
            notesRevisionRef.current = latest.revision || 0; setNotesRevision(latest.revision || 0);
            reconciled = true;
          }
        } catch { /* Fall back to the conflict prompt below. */ }
        if (reconciled) saved = true;
        else {
          setNotesConflict(true);
          notesConflictRef.current = true;
          setNotesError("Another participant has saved a newer version. Load their version or explicitly keep yours.");
        }
      } else setNotesError(cause instanceof Error ? cause.message : "Could not save meeting notes.");
    } finally {
      setNotesSaving(false); notesSavingRef.current = false;
      // If someone typed while the previous save was in flight, persist the newer version too.
      if (saved && notesDirtyRef.current && !notesConflictRef.current) {
        window.clearTimeout(notesSaveTimer.current);
        notesSaveTimer.current = window.setTimeout(() => { void saveMeetingNotes(); }, 0);
      }
    }
  }

  function updateMeetingNotes(html: string) {
    notesHtmlRef.current = html;
    setNotesHtml(html);
    notesDirtyRef.current = true;
    setNotesDirty(true);
    if (!notesConflict) setNotesError("");
    broadcastNotesLive();
    window.clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = window.setTimeout(() => { void saveMeetingNotes(); }, 1100);
  }

  function updateMeetingNotesTitle(title: string) {
    notesTitleRef.current = title;
    setNotesTitle(title);
    notesDirtyRef.current = true;
    setNotesDirty(true);
    if (!notesConflict) setNotesError("");
    broadcastNotesLive();
    window.clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = window.setTimeout(() => { void saveMeetingNotes(); }, 1100);
  }

  useEffect(() => {
    if (!notesOpen) return;
    // Cached notes are already on screen; this only refreshes them quietly (the loading state shows only on a first-ever open).
    void loadMeetingNotes(false);
    // Realtime messages keep notes current; this slower refresh is only a safety net.
    const refresh = window.setInterval(() => { if (!notesDirtyRef.current && !notesSavingRef.current) void loadMeetingNotes(false); }, 12_000);
    return () => {
      window.clearInterval(refresh);
      window.clearTimeout(notesSaveTimer.current);
      // Closing the Notes panel or leaving the room should flush a pending edit.
      if (notesDirtyRef.current && !notesConflictRef.current) void saveMeetingNotes();
    };
  }, [notesOpen, meeting.slug]);

  // The editor is temporarily unmounted while the initial load skeleton is shown.
  // Hydrate it after loading completes, without overwriting in-progress local edits.
  useLayoutEffect(() => {
    const editor = notesEditorRef.current;
    if (!notesOpen || notesLoading || !editor || notesDirtyRef.current) return;
    if (editor.innerHTML !== notesHtmlRef.current) editor.innerHTML = notesHtmlRef.current;
  }, [notesOpen, notesLoading, notesHtml]);

  // Preload notes quietly as soon as the room opens, so the Notes panel is instant and always current.
  useEffect(() => { void loadMeetingNotes(false); }, [meeting.slug]);

  // Realtime notes: apply other participants' live edits and refresh in the background whenever someone saves.
  useEffect(() => {
    const onNotesData = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
      if (topic !== NOTES_TOPIC || participant?.identity === localIdentity) return;
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as { kind?: string; html?: string; title?: string; name?: string };
        if (data.kind === "live") applyRemoteNotes(data);
        else if (data.kind === "saved" && !notesDirtyRef.current && !notesSavingRef.current) void loadMeetingNotes(false);
      } catch { /* Ignore unrelated or malformed room data. */ }
    };
    room.on(RoomEvent.DataReceived, onNotesData);
    // After a reconnect any live messages may have been missed, so catch up quietly.
    const onReconnected = () => { void loadMeetingNotes(false); };
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => { room.off(RoomEvent.DataReceived, onNotesData); room.off(RoomEvent.Reconnected, onReconnected); window.clearTimeout(notesLiveTimer.current); notesLiveTimer.current = 0; };
  }, [room, meeting.slug, localIdentity]);

  useEffect(() => {
    if (!notesOpen || !notesDirty || notesSaving || notesConflict || notesError) return;
    window.clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = window.setTimeout(() => { void saveMeetingNotes(); }, 1100);
    return () => window.clearTimeout(notesSaveTimer.current);
  }, [notesOpen, notesDirty, notesSaving, notesConflict, notesError, notesTitle, notesHtml]);

  function formatNote(command: string, value?: string) {
    const editor = notesEditorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    updateMeetingNotes(editor.innerHTML);
  }

  function exportNotesPdf() {
    downloadMeetingNotesPdf(meeting.title, meeting.startedAt || meeting.startsAt, notesTitle, notesHtmlRef.current);
  }

  useEffect(() => {
    const onFullscreen = () => {
      if (document.fullscreenElement === fullScreenRef.current) {
        autoFullscreenDone.current = true;
        pseudoFullRef.current = false;
        setPseudoFull(false);
        setFullscreenPrompt(false);
        setFullScreen(true);
      } else if (!document.fullscreenElement && !pseudoFullRef.current) {
        // Esc or the browser's own fullscreen-exit control is an explicit exit;
        // do not surprise the participant by automatically re-entering.
        autoFullscreenDone.current = true;
        setFullScreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chatMessages.length, messagesOpen]);

  // The latest person to speak moves to the top and stays there (even after they stop) until someone else starts speaking.
  useEffect(() => {
    const onSpeakers = (speakers: Participant[]) => {
      if (!speakers.length) return;
      setTopSpeaker((current) => {
        if (current && speakers.some((speaker) => speaker.identity === current)) return current;
        const loudest = [...speakers].sort((a, b) => b.audioLevel - a.audioLevel)[0];
        return loudest ? loudest.identity : current;
      });
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => { room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers); };
  }, [room]);

  useEffect(() => {
    if (isActive) return;
    setMessagesOpen(false);
    setReactionsOpen(false);
    setDeviceMenu(null);
    setMediaModal(null);
  }, [isActive]);

  // New message from someone else: play a tone and show a 4 second pop-up with the message at the bottom of the call.
  useEffect(() => {
    messagesOpenRef.current = messagesOpen;
    overlayOpenRef.current = messagesOpen || reactionsOpen || deviceMenu !== null;
  }, [messagesOpen, reactionsOpen, deviceMenu]);
  useEffect(() => {
    pseudoFullRef.current = pseudoFull;
    window.dispatchEvent(new Event("meet-pseudo-fullscreen-change"));
  }, [pseudoFull, fullScreen]);
  useEffect(() => {
    if (chatMessages.length < seenMessages.current) seenMessages.current = chatMessages.length;
    if (chatMessages.length === seenMessages.current) return;
    const fresh = chatMessages.slice(seenMessages.current).filter((message) => message.from?.identity !== localIdentity);
    seenMessages.current = chatMessages.length;
    const latest = fresh[fresh.length - 1];
    if (!latest) return;
    playMessageTone();
    if (messagesOpenRef.current) return;
    setMessageToast({ id: Date.now(), name: latest.from?.name || "Choir guest", text: latest.message });
    window.clearTimeout(messageToastTimer.current);
    messageToastTimer.current = window.setTimeout(() => setMessageToast(null), 5000);
  }, [chatMessages, localIdentity]);
  useEffect(() => () => window.clearTimeout(messageToastTimer.current), []);
  // Someone joins or leaves: play a tone and show a bottom pop-up saying who. People already in the room when we arrive are not announced.
  useEffect(() => {
    const known = new Set<string>(Array.from(room.remoteParticipants.values()).map((participant) => participant.identity));
    let armed = false;
    let armTimer = 0;
    const arm = () => { window.clearTimeout(armTimer); armTimer = window.setTimeout(() => { armed = true; }, 1500); };
    if (room.state === ConnectionState.Connected) arm();
    const onConnected = () => arm();
    const onReconnecting = () => { armed = false; };
    const announce = (kind: "joined" | "left", participant: RemoteParticipant) => {
      const id = Date.now() + Math.random();
      const name = participantName(participant) || "A participant";
      playPresenceTone(kind);
      setPresenceToasts((current) => [...current.slice(-2), { id, kind, name }]);
      const timer = window.setTimeout(() => setPresenceToasts((current) => current.filter((toast) => toast.id !== id)), 3600);
      presenceTimers.current.push(timer);
    };
    const onJoined = (participant: RemoteParticipant) => {
      const isNew = !known.has(participant.identity);
      known.add(participant.identity);
      if (armed && isNew) announce("joined", participant);
    };
    const onLeft = (participant: RemoteParticipant) => {
      const wasKnown = known.delete(participant.identity);
      if (armed && wasKnown) announce("left", participant);
    };
    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onConnected);
    room.on(RoomEvent.ParticipantConnected, onJoined);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      window.clearTimeout(armTimer);
      presenceTimers.current.forEach((timer) => window.clearTimeout(timer));
      presenceTimers.current = [];
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onConnected);
      room.off(RoomEvent.ParticipantConnected, onJoined);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);
  // Browsers keep audio locked until the first tap; unlock it early so the message tone can play.
  useEffect(() => {
    const unlock = () => { try { const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!Ctx) return; toneContext ??= new Ctx(); if (toneContext.state === "suspended") void toneContext.resume(); if (ringContext && ringContext.state === "suspended") void ringContext.resume(); } catch { /* ignore */ } };
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    return () => document.removeEventListener("pointerdown", unlock, true);
  }, []);

  // Request native fullscreen on entry and retry once after 15 seconds.
  // Browsers that require transient user activation can reject both requests;
  // in that case expose a clear one-tap fallback instead of forcing pseudo mode.
  useEffect(() => {
    if (!isActive) return;
    const target = fullScreenRef.current;
    if (!target) return;

    let gestureCleanup = () => {};
    let requestPending = false;
    const enterPseudoFullscreen = () => {
      if (autoFullscreenDone.current || document.fullscreenElement || pseudoFullRef.current) return;
      autoFullscreenDone.current = true;
      pseudoFullRef.current = true;
      setPseudoFull(true);
      setFullScreen(true);
      lastFullscreenAction.current = Date.now();
      gestureCleanup();
    };
    const requestNativeFullscreen = (fallbackToPseudo = false) => {
      if (autoFullscreenDone.current || document.fullscreenElement || requestPending) return;
      if (typeof target.requestFullscreen !== "function") {
        enterPseudoFullscreen();
        return;
      }
      requestPending = true;
      lastFullscreenAction.current = Date.now();
      let request: Promise<void>;
      try { request = target.requestFullscreen({ navigationUI: "hide" }); }
      catch {
        requestPending = false;
        if (fallbackToPseudo) setFullscreenPrompt(true);
        return;
      }
      void request.then(() => {
        autoFullscreenDone.current = true;
        setFullScreen(true);
        setPseudoFull(false);
        pseudoFullRef.current = false;
        lastFullscreenAction.current = Date.now();
        gestureCleanup();
      }).catch(() => {
        requestPending = false;
        // The initial no-gesture request may be rejected by browser policy.
        // After the timed retry, offer one explicit tap that can enter native
        // fullscreen or the viewport-filling fallback where native is denied.
        if (fallbackToPseudo) setFullscreenPrompt(true);
      });
    };

    if (typeof target.requestFullscreen !== "function") {
      // iPhone Safari and other browsers without the element Fullscreen API.
      enterPseudoFullscreen();
      return () => { gestureCleanup(); };
    }

    const events = ["pointerup", "click", "keydown"] as const;
    const onUserGesture = (event: Event) => {
      if (!event.isTrusted || autoFullscreenDone.current || document.fullscreenElement || pseudoFullRef.current) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
      // Use this gesture exactly once; if a policy blocks it, the visible
      // manual fullscreen button can still be used without repeated retries.
      gestureCleanup();
      requestNativeFullscreen(true);
    };
    gestureCleanup = () => events.forEach((name) => document.removeEventListener(name, onUserGesture, true));
    events.forEach((name) => document.addEventListener(name, onUserGesture, true));

    requestNativeFullscreen();
    const retryTimer = window.setTimeout(() => {
      if (!autoFullscreenDone.current && !document.fullscreenElement && !pseudoFullRef.current) requestNativeFullscreen(true);
    }, 15000);
    return () => {
      window.clearTimeout(retryTimer);
      gestureCleanup();
    };
  }, [isActive]);

  useEffect(() => {
    if (isActive) return;
    setFullscreenPrompt(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (pseudoFullRef.current) {
      pseudoFullRef.current = false;
      setPseudoFull(false);
      setFullScreen(false);
    }
  }, [isActive]);

  // Close the microphone / camera / reaction popovers as soon as the user presses anywhere outside them.
  useEffect(() => {
    if (!deviceMenu && !reactionsOpen) return;
    const onOutside = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const inside = (name: string) => Boolean(target?.closest(`[data-popover="${name}"]`));
      if (deviceMenu && !inside(deviceMenu)) setDeviceMenu(null);
      if (reactionsOpen && !inside("reactions")) setReactionsOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [deviceMenu, reactionsOpen]);

  async function broadcast(signal: RoomSignal) {
    try {
      await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), { reliable: true, topic: "meet-enihakole-ui" });
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Your action could not be sent. Check your connection." } }));
    }
  }
  function focusParticipant(identity: string | null) {
    // Spotlight is a personal viewing preference; do not change other participants' layouts.
    setSpotlightIdentity((current) => identity && current === identity ? null : identity);
    setPage(0);
    setPeopleOpen(false);
  }
  async function openPrivateConversation(participant: Participant) {
    const userId = participantUserId(participant);
    if (!userId || participant.isLocal) return;
    const contact = { userId, identity: participant.identity, name: participantName(participant) || "Participant", picture: participantPicture(participant.metadata, participant.identity) };
    setPrivateMessages([]);
    setPrivateLoading(true);
    setDirectContact(contact);
    setPrivateDraft("");
    setPeopleOpen(false);
    setMessagesOpen(false);
    setNotesOpen(false);
  }
  function openPrivateContact(contact: DirectContact) {
    setPrivateMessages([]);
    setPrivateLoading(true);
    setDirectContact(contact);
    setPrivateDraft("");
    setPrivateNotice(null);
    setPeopleOpen(false);
    setMessagesOpen(false);
    setNotesOpen(false);
  }
  async function sendPrivateMessage(event: FormEvent) {
    event.preventDefault();
    const message = privateDraft.trim();
    const contact = directContactRef.current;
    if (!message || !contact || privateSending) return;
    setPrivateSending(true);
    try {
      const result = await api.sendPrivateMessage(meeting.slug, contact.userId, message);
      const saved = result.message;
      setPrivateMessages((current) => current.some((item) => item.id === saved.id) ? current : [...current, saved].slice(-200));
      setRecentConversations((current) => [
        { userId: saved.recipientUserId, name: saved.recipientName || contact.name, picture: contact.picture, lastMessage: saved.message, createdAt: saved.createdAt },
        ...current.filter((item) => item.userId !== saved.recipientUserId),
      ].slice(0, 30));
      setPrivateDraft("");
      try {
        const recipientIdentities = saved.recipientIdentities?.length ? saved.recipientIdentities : saved.recipientIdentity ? [saved.recipientIdentity] : [];
        if (saved.recipientOnline && room.state === ConnectionState.Connected && recipientIdentities.length > 0) {
          const signal: PrivateDataSignal = { kind: "private-message", recipientUserId: saved.recipientUserId, message: saved };
          await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), { reliable: true, topic: PRIVATE_MESSAGE_TOPIC, destinationIdentities: recipientIdentities });
        } else {
          window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Your private message was saved. It will appear when the recipient returns to the meeting." } }));
        }
      } catch {
        window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Your message was saved. The recipient can read it when they return to the meeting." } }));
      }
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not send this private message." } }));
    } finally { setPrivateSending(false); }
  }
  async function refreshRecordingStatus() {
    try {
      const result = await api.recordingStatus(meeting.slug, localIdentity);
      setRecordingState(result.recording);
    } catch { /* Status refreshes automatically after a reconnect. */ }
  }
  async function startRecording() {
    if (role !== "host" || recordingBusy || !window.confirm("Start an audio-only recording? Every connected participant will receive a consent request. Only synchronized meeting audio is captured; camera video is never recorded.")) return;
    setRecordingBusy(true);
    try {
      const result = await api.startRecording(meeting.slug);
      await refreshRecordingStatus();
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: result.recording.status === "recording" ? "Audio recording started." : "Audio recording consent requests sent to everyone in the meeting." } }));
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not start meeting recording." } }));
    } finally { setRecordingBusy(false); }
  }
  async function stopRecording() {
    if (role !== "host" || recordingBusy || !recordingState || !window.confirm("Stop the audio recording and save it to your recordings library?")) return;
    setRecordingBusy(true);
    try {
      await api.stopRecording(meeting.slug);
      await refreshRecordingStatus();
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Audio recording stopped. The file is being uploaded securely." } }));
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not stop the recording." } }));
    } finally { setRecordingBusy(false); }
  }
  async function retryRecordingUpload() {
    if (role !== "host" || recordingBusy || !recordingState?.canRetry) return;
    setRecordingBusy(true);
    try {
      await api.retryRecording(meeting.slug);
      await refreshRecordingStatus();
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Recording upload retry started." } }));
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not retry the recording upload." } }));
    } finally { setRecordingBusy(false); }
  }
  async function respondToRecordingConsent(accepted: boolean) {
    if (!recordingState || recordingConsentBusy || recordingState.myDecision !== "pending") return;
    setRecordingConsentBusy(true);
    try {
      await api.recordingConsent(meeting.slug, recordingState.id, localIdentity, accepted);
      await refreshRecordingStatus();
      if (!accepted) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "You declined recording. The host has been notified and recording will not start." } }));
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not save your recording decision." } }));
    } finally { setRecordingConsentBusy(false); }
  }

  async function moderateParticipant(participant: Participant, action: "mute-mic" | "disable-camera" | "remove" | "ban" | "request-unmute" | "request-camera") {
    if (role !== "host" || participant.isLocal || moderationBusy) return;
    if ((action === "remove" || action === "ban") && !window.confirm(action === "ban" ? `Remove ${participantName(participant) || "this participant"} and block their account from rejoining?` : `Remove ${participantName(participant) || "this participant"} from the meeting?`)) return;
    setModerationBusy(participant.identity);
    try {
      const moderationResult = await api.moderateParticipant(meeting.slug, participant.identity, action);
      if (action === "request-unmute" || action === "request-camera") {
        const signal: PrivateDataSignal = { kind: "moderator-request", recipientUserId: participantUserId(participant), media: action === "request-unmute" ? "microphone" : "camera", hostName: localParticipant.name || "The host" };
        if (signal.recipientUserId) {
          try { await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), { reliable: true, topic: PRIVATE_MESSAGE_TOPIC, destinationIdentities: [participant.identity] }); } catch { /* The participant sees the request on their next connection only if still online. */ }
        }
        window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: action === "request-unmute" ? "Unmute request sent. The participant must allow their microphone." : "Camera-on request sent. The participant must allow their camera." } }));
      } else if (action === "mute-mic" || action === "disable-camera") {
        const signal: PrivateDataSignal = { kind: "moderator-media-control", recipientUserId: participantUserId(participant), media: action === "mute-mic" ? "microphone" : "camera", action: "disable", hostName: localParticipant.name || "The host" };
        if (signal.recipientUserId) {
          try { await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), { reliable: true, topic: PRIVATE_MESSAGE_TOPIC, destinationIdentities: [participant.identity] }); } catch { /* The server-side mute remains applied even if the capture-stop notice cannot be delivered. */ }
        }
        window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: action === "mute-mic" ? "Participant microphone muted." : "Participant camera disabled." } }));
      } else {
        window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: action === "ban" || action === "remove" ? moderationResult.message : action === "mute-mic" ? "Participant microphone muted." : "Participant camera disabled." } }));
      }
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: cause instanceof Error ? cause.message : "Could not apply that participant action." } }));
    } finally { setModerationBusy(null); }
  }
  async function acceptModeratorRequest() {
    const request = moderatorRequest;
    if (!request) return;
    setModeratorRequest(null);
    if (await queryMediaPermission(request.media) === "denied") {
      setMediaModal({ kind: request.media, state: mediaFailure("blocked", request.media) });
      return;
    }
    if (!(await mediaAlreadyAllowed(request.media))) {
      setMediaModal({ kind: request.media, state: { phase: "ask" } });
      return;
    }
    await enableMedia(request.media);
  }
  // Turns the device on once it is allowed; anything that goes wrong opens the troubleshooting dialog instead of failing silently.
  async function enableMedia(kind: MediaKind) {
    try {
      if (kind === "microphone") {
        await localParticipant.setMicrophoneEnabled(true);
      } else {
        const selected = VIDEO_QUALITY_OPTIONS.find((option) => option.value === videoQualityMode) ?? VIDEO_QUALITY_OPTIONS[0];
        const targetHeight = videoQualityMode === "auto" ? 720 : selected.height;
        await localParticipant.setCameraEnabled(true, { resolution: videoCaptureResolution(targetHeight) });
        const cameraTrack = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
        cameraTrack?.setPublishingQuality(videoPublishingQuality(videoQualityMode));
      }
      setMediaModal(null);
    } catch (cause) {
      const failure = MediaDeviceFailure.getFailure(cause);
      setMediaModal({ kind, state: mediaFailure(failure === MediaDeviceFailure.NotFound ? "unavailable" : failure === MediaDeviceFailure.PermissionDenied ? "blocked" : "busy", kind) });
    }
  }
  // Mic and camera buttons: turning off is instant; turning on shows our permission dialog first when the browser has not been allowed yet.
  async function toggleMedia(kind: MediaKind) {
    const enabled = kind === "microphone" ? isMicrophoneEnabled : isCameraEnabled;
    if (enabled) { if (kind === "microphone") await localParticipant.setMicrophoneEnabled(false); else await localParticipant.setCameraEnabled(false); return; }
    if (await queryMediaPermission(kind) === "denied") { setMediaModal({ kind, state: mediaFailure("blocked", kind) }); return; }
    if (!(await mediaAlreadyAllowed(kind))) { setMediaModal({ kind, state: { phase: "ask" } }); return; }
    await enableMedia(kind);
  }
  // Called only from the dialog's Allow / Try again button, which is when the browser prompt may appear.
  async function askMedia(kind: MediaKind) {
    const attempt = ++mediaAttemptRef.current;
    setMediaModal({ kind, state: { phase: "waiting" } });
    const result = await requestMediaAccess(kind);
    if (attempt !== mediaAttemptRef.current) return;
    if (result.phase === "granted") await enableMedia(kind); else setMediaModal({ kind, state: result });
  }
  useEffect(() => {
    const onFailure = (event: Event) => {
      const { failure, kind } = (event as CustomEvent<{ failure?: MediaDeviceFailure; kind?: MediaDeviceKind }>).detail;
      const media: MediaKind | null = kind === "audioinput" ? "microphone" : kind === "videoinput" ? "camera" : null;
      if (!media) return;
      setMediaModal({ kind: media, state: mediaFailure(failure === MediaDeviceFailure.NotFound ? "unavailable" : failure === MediaDeviceFailure.DeviceInUse || failure === MediaDeviceFailure.Other ? "busy" : "blocked", media) });
    };
    window.addEventListener("meet-media-failure", onFailure);
    return () => window.removeEventListener("meet-media-failure", onFailure);
  }, []);
  async function chooseDevice(kind: "audioinput" | "videoinput", deviceId: string) {
    try {
      await room.switchActiveDevice(kind, deviceId);
      setDeviceMenu(null);
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Could not switch that device. Check browser permissions and try again." } }));
    }
  }

  function chooseVideoQuality(mode: VideoQualityMode) {
    setVideoQualityMode(mode);
    setVideoQualityMenuOpen(false);
    setVideoProfileBusy(false);
    autoCaptureHeight.current = mode === "auto" ? 720 : (VIDEO_QUALITY_OPTIONS.find((option) => option.value === mode)?.height ?? 720);
    autoGoodSamples.current = 0;
    autoPoorSamples.current = 0;
    videoProfileKey.current = "";
    try { localStorage.setItem(VIDEO_QUALITY_STORAGE_KEY, mode); } catch { /* Quality still applies for this meeting. */ }
  }

  // Apply a manual capture preference to the existing camera track. restartTrack
  // reacquires the camera at the selected resolution while keeping the LiveKit
  // publication and participant identity intact.
  useEffect(() => {
    if (!isCameraEnabled || videoQualityMode === "auto") {
      setVideoProfileBusy(false);
      if (!isCameraEnabled) videoProfileKey.current = "";
      return;
    }
    const publication = localParticipant.getTrackPublication(Track.Source.Camera);
    const cameraTrack = publication?.videoTrack;
    if (!cameraTrack) return;
    const option = VIDEO_QUALITY_OPTIONS.find((item) => item.value === videoQualityMode);
    if (!option) return;
    const profileKey = `${cameraTrack.sid ?? cameraTrack.mediaStreamTrack.id}:${videoQualityMode}`;
    if (videoProfileKey.current === profileKey) return;
    videoProfileKey.current = profileKey;
    const currentCaptureHeight = Number(cameraTrack.mediaStreamTrack.getSettings().height ?? 0);
    if (currentCaptureHeight > 0 && Math.abs(currentCaptureHeight - option.height) <= 40) {
      // Enabling the camera already applies this selected capture profile; do
      // not immediately reacquire the same camera a second time.
      cameraTrack.setPublishingQuality(videoPublishingQuality(videoQualityMode));
      return;
    }
    let cancelled = false;
    setVideoProfileBusy(true);
    void cameraTrack.restartTrack(videoCaptureOptionsForTrack(cameraTrack, option.height))
      .then(() => { if (!cancelled) cameraTrack.setPublishingQuality(videoPublishingQuality(videoQualityMode)); })
      .catch(() => {
        if (!cancelled) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: `This camera could not start at ${option.label}. Choose Auto or a lower resolution.` } }));
      })
      .finally(() => { if (!cancelled) setVideoProfileBusy(false); });
    return () => { cancelled = true; };
  }, [isCameraEnabled, localParticipant, videoQualityMode]);

  // Auto starts at 720p, steps down when real sender statistics show sustained
  // pressure, and only steps up to 1080p after several stable samples. The
  // Network Information API is optional; unavailable signals never force an
  // upscale. A single participant's receiver quality never changes other
  // participants' outgoing streams.
  useEffect(() => {
    if (videoQualityMode !== "auto" || !isCameraEnabled) return;
    let stopped = false;
    let sampling = false;
    autoCaptureHeight.current = 720;
    autoGoodSamples.current = 0;
    autoPoorSamples.current = 0;
    const inspectNetwork = async () => {
      if (sampling || stopped) return;
      sampling = true;
      try {
        const track = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
        if (!track) return;
        const currentCaptureHeight = Number(track.mediaStreamTrack.getSettings().height ?? 0);
        if (currentCaptureHeight > 0 && Math.abs(currentCaptureHeight - 720) > 80) {
          await track.restartTrack(videoCaptureOptionsForTrack(track, 720));
          if (stopped) return;
          autoCaptureHeight.current = 720;
          return;
        }
        const report = await track.getRTCStatsReport();
        if (!report || stopped) return;
        const rows = Array.from(report.values()) as unknown as Array<Record<string, unknown>>;
        const isVideo = (row: Record<string, unknown>) => row.kind === "video" || row.mediaType === "video";
        const outbound = rows
          .filter((row) => row.type === "outbound-rtp" && isVideo(row) && row.isRemote !== true)
          .sort((a, b) => Number(b.frameWidth ?? 0) * Number(b.frameHeight ?? 0) - Number(a.frameWidth ?? 0) * Number(a.frameHeight ?? 0))[0];
        const remoteInbound = rows.find((row) => row.type === "remote-inbound-rtp" && isVideo(row) && row.id === outbound?.remoteId)
          ?? rows.find((row) => row.type === "remote-inbound-rtp" && isVideo(row));
        const candidate = rows.find((row) => row.type === "candidate-pair" && row.state === "succeeded" && (row.nominated === true || row.selected === true));
        const network = (navigator as Navigator & { connection?: { downlink?: number; rtt?: number; effectiveType?: string; saveData?: boolean } }).connection;
        const cores = navigator.hardwareConcurrency || 0;
        const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;
        const constrainedDevice = (cores > 0 && cores <= 4) || (memory > 0 && memory < 4);
        const networkType = network?.effectiveType || "";
        const constrainedNetwork = network?.saveData === true || ["slow-2g", "2g", "3g"].includes(networkType);
        const availableBps = Number(candidate?.availableOutgoingBitrate ?? 0);
        const rttSeconds = Number(remoteInbound?.roundTripTime ?? candidate?.currentRoundTripTime ?? (network?.rtt ? network.rtt / 1000 : 0));
        const packetLoss = Number(remoteInbound?.fractionLost ?? -1);
        const limitation = typeof outbound?.qualityLimitationReason === "string" ? outbound.qualityLimitationReason : "unknown";
        const cpuLimited = limitation === "cpu";
        const bandwidthLimited = limitation === "bandwidth";
        const severePressure = cpuLimited || (packetLoss >= 0.08) || (availableBps > 0 && availableBps < 850_000) || (rttSeconds > 0.65);
        const moderatePressure = constrainedNetwork || bandwidthLimited || (packetLoss >= 0.04) || (availableBps > 0 && availableBps < 1_800_000) || (rttSeconds > 0.42);
        const cameraCapabilities = track.mediaStreamTrack.getCapabilities?.();
        const maxCameraWidth = typeof cameraCapabilities?.width === "object" ? cameraCapabilities.width.max : Number(cameraCapabilities?.width ?? 0);
        const maxCameraHeight = typeof cameraCapabilities?.height === "object" ? cameraCapabilities.height.max : Number(cameraCapabilities?.height ?? 0);
        const canCaptureFullHd = (maxCameraWidth ?? 0) >= 1920 && (maxCameraHeight ?? 0) >= 1080;
        const hasStrongEvidence = !constrainedDevice && !constrainedNetwork && !cpuLimited && !bandwidthLimited
          && canCaptureFullHd && availableBps >= 6_000_000 && (rttSeconds === 0 || rttSeconds < 0.22)
          && (packetLoss < 0 || packetLoss < 0.02);
        if (severePressure || moderatePressure) {
          autoPoorSamples.current += 1;
          autoGoodSamples.current = 0;
        } else if (hasStrongEvidence) {
          autoGoodSamples.current += 1;
          autoPoorSamples.current = 0;
        } else {
          autoGoodSamples.current = 0;
          autoPoorSamples.current = 0;
        }

        let target: VideoQualityHeight = autoCaptureHeight.current;
        if (autoPoorSamples.current >= 2) {
          target = severePressure || constrainedDevice ? 360 : 480;
        } else if (autoGoodSamples.current >= 3) {
          if (target < 720) target = 720;
          else if (target === 720 && hasStrongEvidence) target = 1080;
        }
        if (target !== autoCaptureHeight.current) {
          await track.restartTrack(videoCaptureOptionsForTrack(track, target));
          if (stopped) return;
          track.setPublishingQuality(VideoQuality.HIGH);
          autoCaptureHeight.current = target;
          autoGoodSamples.current = 0;
          autoPoorSamples.current = 0;
          window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: `Auto video quality adjusted to ${target}p for connection stability.` } }));
        }
      } catch { /* Stats can be temporarily unavailable during browser/network transitions. */ }
      finally { sampling = false; }
    };
    void inspectNetwork();
    const timer = window.setInterval(() => { void inspectNetwork(); }, 4500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [isCameraEnabled, localParticipant, videoQualityMode]);

  // Per-viewer quality preference: Auto leaves sizing to Adaptive Stream;
  // fixed preferences cap only this receiver's subscriptions.
  useEffect(() => {
    const quality = videoQualityMode === "auto" || videoQualityMode === "fullhd" ? VideoQuality.HIGH
      : videoQualityMode === "hd" || videoQualityMode === "480p" ? VideoQuality.MEDIUM : VideoQuality.LOW;
    participants.forEach((participant) => {
      if (participant.isLocal) return;
      // useParticipants exposes the shared Participant base type; the local
      // guard makes the remote publication API safe to access here.
      const remoteParticipant = participant as RemoteParticipant;
      const publication = remoteParticipant.getTrackPublication(Track.Source.Camera);
      if (publication?.isSubscribed && publication.simulcasted) publication.setVideoQuality(quality);
    });
  }, [participants, trackRefs, videoQualityMode]);

  // Diagnostics are sampled only while the panel is open; this keeps normal
  // meetings free of a permanent polling loop and shows actual encoded/decoded
  // resolution rather than the selected preference.
  const remoteStatsTrack = trackRefs
    .filter((item): item is TrackReference => isTrackReference(item) && !item.participant.isLocal && Boolean(item.publication?.track) && !item.publication?.isMuted)
    .sort((a, b) => Number(b.participant.identity === topSpeaker || b.participant.isSpeaking) - Number(a.participant.identity === topSpeaker || a.participant.isSpeaking))[0];
  const activeLocalCameraTrack = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  let cameraCapabilityWidth = 0;
  let cameraCapabilityHeight = 0;
  if (isCameraEnabled && activeLocalCameraTrack) {
    try {
      const capabilities = activeLocalCameraTrack.mediaStreamTrack.getCapabilities?.();
      cameraCapabilityWidth = typeof capabilities?.width === "object" ? Number(capabilities.width.max ?? 0) : Number(capabilities?.width ?? 0);
      cameraCapabilityHeight = typeof capabilities?.height === "object" ? Number(capabilities.height.max ?? 0) : Number(capabilities?.height ?? 0);
    } catch { /* Some mobile browsers do not expose camera capabilities. */ }
  }
  const cameraSupportsQuality = (height: VideoQualityHeight) => !isCameraEnabled || !activeLocalCameraTrack
    || cameraCapabilityHeight <= 0 || cameraCapabilityWidth <= 0
    || (cameraCapabilityHeight >= height && (height < 1080 || cameraCapabilityWidth >= 1920));
  useEffect(() => {
    if (!videoQualityMenuOpen || !videoDiagnosticsOpen) return;
    let stopped = false;
    let sampling = false;
    localStatsCounter.current = undefined;
    remoteStatsCounter.current = undefined;
    const sample = async () => {
      if (sampling || stopped) return;
      sampling = true;
      try {
        const localTrack = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
        const remoteTrack = remoteStatsTrack?.publication?.track;
        const [localResult, remoteResult] = await Promise.all([
          localTrack ? readVideoStatsSnapshot(localTrack, "outbound", localStatsCounter.current) : Promise.resolve(null),
          remoteTrack ? readVideoStatsSnapshot(remoteTrack, "inbound", remoteStatsCounter.current) : Promise.resolve(null),
        ]);
        if (stopped) return;
        if (localResult) {
          setLocalVideoStats(localResult.snapshot);
          localStatsCounter.current = localResult.counter;
        } else setLocalVideoStats(null);
        if (remoteResult) {
          setRemoteVideoStats(remoteResult.snapshot);
          remoteStatsCounter.current = remoteResult.counter;
          setRemoteStatsName(remoteStatsTrack?.participant.name || remoteStatsTrack?.participant.identity || "Participant");
        } else {
          setRemoteVideoStats(null);
          setRemoteStatsName("");
        }
      } finally { sampling = false; }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [videoDiagnosticsOpen, videoQualityMenuOpen, localParticipant, remoteStatsTrack?.publication?.track, remoteStatsTrack?.participant.identity]);

  const screenBusy = useRef(false);
  async function toggleScreenShare(switching = false) {
    const notify = (message: string) => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message } }));
    if (screenBusy.current) return; // A start or stop is already in progress: ignore double taps.
    if (isScreenShareEnabled && !switching) {
      screenBusy.current = true;
      try { await localParticipant.setScreenShareEnabled(false); } catch { notify("Could not stop sharing. Please try again."); }
      finally { screenBusy.current = false; }
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      notify("Screen sharing is not available on this device or browser. Most phones and tablets cannot share their screen; use Chrome, Edge, Firefox or Safari on a computer.");
      return;
    }
    if (!isScreenShareEnabled && screenShare && !screenShare.participant.isLocal) {
      notify(`${participantName(screenShare.participant) || "Someone"} is presenting. Ask them to stop sharing first.`);
      return;
    }
    screenBusy.current = true;
    try {
      // Switching: end the current share first, then immediately open the picker again for the new window or screen.
      if (isScreenShareEnabled) await localParticipant.setScreenShareEnabled(false);
      // Some browsers refuse audio capture or the extra picker hints; fall back step by step so sharing still starts.
      const attempts = [
        { audio: true, contentHint: "detail" as const, resolution: { width: 1920, height: 1080, frameRate: 15 }, selfBrowserSurface: "exclude" as const, surfaceSwitching: "include" as const, systemAudio: "include" as const },
        { audio: false, contentHint: "detail" as const, resolution: { width: 1920, height: 1080, frameRate: 15 } },
        { audio: false },
      ];
      let lastName = "";
      for (const options of attempts) {
        try { await localParticipant.setScreenShareEnabled(true, options); return; }
        catch (cause) {
          lastName = cause instanceof Error ? cause.name : "";
          if (lastName === "NotAllowedError" || lastName === "AbortError" || lastName === "NotFoundError") break;
        }
      }
      if (lastName === "AbortError") notify("Screen sharing was cancelled.");
      else if (lastName === "NotAllowedError") notify("Screen sharing was not allowed. Check your browser permission and try again.");
      else notify(lastName === "NotFoundError" ? "There is no screen or window available to share." : "Could not start screen sharing. Check your browser permissions and try again.");
    } finally { screenBusy.current = false; }
  }
  // Leaving the room always ends your share, so nobody is left looking at a frozen screen.
  useEffect(() => () => { try { void room.localParticipant.setScreenShareEnabled(false).catch(() => undefined); } catch { /* Room already closed. */ } }, [room]);
  async function toggleHand() {
    const next = !handRaised;
    setHandRaised(next);
    setRaisedHands((current) => ({ ...current, [localIdentity]: next }));
    await broadcast({ kind: "hand", raised: next });
  }
  async function react(emoji: string) {
    setReactionsOpen(false);
    const id = `${localIdentity}-${Date.now()}`;
    setReactions((current) => [...current.slice(-11), makeReaction(id, emoji, localParticipant.name || "You")]);
    window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== id)), REACTION_LIFETIME);
    await broadcast({ kind: "reaction", emoji, id });
  }
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const message = messageText.trim();
    if (!message || isSending) return;
    try { await send(message); setMessageText(""); }
    catch { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Could not send that message. Please retry." } })); }
  }
  async function toggleFullscreen(silent = false, enterOnly = false) {
    // Background taps may only ENTER fullscreen; leaving is reserved for the fullscreen button (or Esc).
    if (enterOnly && (document.fullscreenElement || pseudoFullRef.current || pseudoFull)) return;
    autoFullscreenDone.current = true;
    lastFullscreenAction.current = Date.now();
    setFullscreenPrompt(false);
    const target = fullScreenRef.current;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (pseudoFullRef.current || pseudoFull) {
        pseudoFullRef.current = false;
        setPseudoFull(false);
        setFullScreen(false);
      } else if (target?.requestFullscreen) {
        await target.requestFullscreen({ navigationUI: "hide" });
        setFullScreen(true);
      } else {
        pseudoFullRef.current = true;
        setPseudoFull(true);
        setFullScreen(true);
      }
    } catch {
      // A deliberate tap is the valid activation needed by native fullscreen.
      // Keep the control usable even when that browser still denies the API.
      pseudoFullRef.current = true;
      setPseudoFull(true);
      setFullScreen(true);
      if (!silent) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Using in-page fullscreen mode in this browser." } }));
    }
  }
  // Tapping or clicking anywhere on the room page (outside fullscreen) enters fullscreen; it never exits it. Buttons, links, menus and the chat keep working normally.
  const toggleFullscreenRef = useRef(toggleFullscreen);
  toggleFullscreenRef.current = toggleFullscreen;
  // Fullscreen: the control bar starts hidden and each tap on the stage fades it in or out.
  fullScreenStateRef.current = fullScreen;
  useEffect(() => { setControlsVisible(false); }, [fullScreen]);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const measure = () => setDockHeight(Math.round(dock.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onDown = () => { suppressNextClick.current = overlayOpenRef.current; };
    const onClick = (event: MouseEvent) => {
      if (!isActive) return;
      const wasOverlay = suppressNextClick.current; suppressNextClick.current = false;
      if (wasOverlay || event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.isConnected || target.closest(INTERACTIVE_SELECTOR)) return;
      if (window.getSelection()?.toString()) return;
      if (document.fullscreenElement || pseudoFullRef.current || fullScreenStateRef.current) {
        // Already fullscreen: a tap never exits it, it only shows or hides the control bar.
        if (Date.now() - lastFullscreenAction.current < 350) return;
        setControlsVisible((visible) => !visible);
        return;
      }
      if (Date.now() - lastFullscreenAction.current < 350) return;
      void toggleFullscreenRef.current(true, true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("click", onClick); };
  }, [isActive]);

  const getParticipantRole = (participant: typeof participants[number]) => {
    try { return JSON.parse(participant.metadata || "{}").role === "host" ? "host" : "participant"; } catch { return "participant"; }
  };
  const orderedParticipants = [...participants].sort((a, b) => {
    const aSpotlight = a.identity === spotlightIdentity; const bSpotlight = b.identity === spotlightIdentity;
    if (aSpotlight !== bSpotlight) return aSpotlight ? -1 : 1;
    const aTop = a.identity === topSpeaker; const bTop = b.identity === topSpeaker;
    if (aTop !== bTop) return aTop ? -1 : 1;
    const aHost = getParticipantRole(a) === "host"; const bHost = getParticipantRole(b) === "host";
    if (aHost !== bHost) return aHost ? -1 : 1;
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });
  // Your own card always lives on the first screen (right after the current speaker and the host), so you never have to page to find yourself.
  useEffect(() => {
    if (spotlightIdentity && !participants.some((participant) => participant.identity === spotlightIdentity)) setSpotlightIdentity(null);
  }, [participants, spotlightIdentity]);
  const localSlot = orderedParticipants.findIndex((participant) => participant.isLocal);
  if (localSlot >= PARTICIPANTS_PER_SCREEN && orderedParticipants[0]?.identity !== spotlightIdentity) {
    const [self] = orderedParticipants.splice(localSlot, 1);
    orderedParticipants.splice(PARTICIPANTS_PER_SCREEN - 1, 0, self);
  }
  const tracksByIdentity = new Map(trackRefs.map((trackRef) => [trackRef.participant.identity, trackRef]));
  const visualParticipants = orderedParticipants.map((participant) => ({ participant, trackRef: tracksByIdentity.get(participant.identity) })).filter((item) => item.trackRef);
  const pages = Math.max(1, Math.ceil(visualParticipants.length / PARTICIPANTS_PER_SCREEN));
  const currentPage = Math.min(page, pages - 1);
  const visibleParticipants = visualParticipants.slice(currentPage * PARTICIPANTS_PER_SCREEN, currentPage * PARTICIPANTS_PER_SCREEN + PARTICIPANTS_PER_SCREEN);

  return <div className={`conference-fullscreen-target ${fullScreen ? "is-fullscreen" : ""} ${pseudoFull ? "is-pseudo-fullscreen" : ""} ${fullScreen && controlsVisible ? "controls-shown" : ""}`} data-theme={theme} ref={fullScreenRef} style={{ "--dock-space": fullScreen ? (controlsVisible ? `${dockHeight}px` : "0px") : `${dockHeight || 110}px` } as CSSProperties}>
    <div className="conference-media-area">
      <RoomAudioRenderer />
      <div className="room-top-stack">
        <div className="room-fullscreen-meeting-title" title={meeting.title}>{meeting.title}</div>
        <div className="active-count-pill" role="status" aria-live="polite" title="People currently in this meeting"><Users size={14}/><b>{participants.length}</b><span>{participants.length === 1 ? "person" : "people"} in the meeting</span></div>
        {RECORDING_UI_ENABLED && recordingState && <div className={`meeting-recording-banner meeting-recording-${recordingState.status}`} role="status" aria-live="polite"><span className="meeting-recording-dot"/><b>{recordingState.status === "recording" ? "Recording" : recordingState.status === "consent_pending" ? "Waiting for recording consent" : recordingState.status === "uploading" ? "Saving recording" : recordingState.status === "ready" ? "Recording saved" : recordingState.status === "failed" ? "Recording upload failed" : recordingState.status === "declined" ? "Recording declined" : "Recording"}</b>{recordingState.status === "consent_pending" && <small>{recordingState.consents.filter((item) => item.decision === "accepted").length}/{recordingState.consents.length} approved</small>}{recordingState.status === "uploading" && <><small>{recordingState.uploadProgressPercent || 0}% uploaded</small><span className="meeting-recording-progress"><i style={{ width: `${Math.max(0, Math.min(100, recordingState.uploadProgressPercent || 0))}%` }}/></span></>}</div>}
        {participants.filter((participant) => raisedHands[participant.identity]).map((participant) => <div className="raised-hand-chip" key={participant.identity} title={`${participantName(participant) || "Participant"} raised a hand`}><Hand size={13}/><span>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " (You)" : ""}</span></div>)}
      </div>
      <div className={`participant-grid-wrap ${screenShare ? "has-screen-share" : ""}`}>
        {screenShare && <ScreenShareStage key={screenShare.participant.identity} screenShare={screenShare} onStop={() => void toggleScreenShare()} onSwitch={() => void toggleScreenShare(true)}/>}
        <div className={`participant-grid participant-grid-count-${visibleParticipants.length || 1} ${spotlightIdentity && visibleParticipants.some((item) => item.participant.identity === spotlightIdentity) ? "has-spotlight" : ""}`}>
          {visibleParticipants.map(({ participant, trackRef }) => {
            const isHost = getParticipantRole(participant) === "host";
            const hand = Boolean(raisedHands[participant.identity]);
            const speaking = participant.identity === localIdentity ? localVoiceActivity.speaking : participant.isSpeaking;
            const cameraVideoOn = isTrackReference(trackRef!) && Boolean(trackRef!.publication?.track) && !trackRef!.publication?.isMuted;
            return <div className={`participant-card ${speaking && cameraVideoOn ? "participant-speaking" : ""} ${isHost ? "participant-host" : ""} ${participant.identity === localIdentity ? "participant-local" : ""} ${participant.identity === spotlightIdentity ? "participant-spotlight" : ""}`} key={participant.identity}>
              <ParticipantTile trackRef={trackRef!} />
              <ParticipantAvatar trackRef={trackRef!} participant={participant} />
              {isHost && <span className="participant-role-label">HOST</span>}
              <div className="participant-name-overlay"><span className="participant-name-copy" title={participantName(participant) || "Participant"}><b>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " · You" : ""}</b></span><span className="participant-badges"><MicOffBadge participant={participant}/>{hand && <span className="raised-hand-badge" title="Raised hand"><Hand size={15}/></span>}{speaking && <span className="speaker-mic" title="Speaking" aria-label="Speaking"><Mic size={14}/></span>}</span></div>
            </div>;
          })}
        </div>
        {reactions.length > 0 && <div className="reaction-float-stack" aria-live="polite">{reactions.map((reaction) => <div className="reaction-float" key={reaction.id} style={{ "--x": `${reaction.x}%`, "--rise": `${reaction.rise}%`, "--rs": reaction.scale } as CSSProperties}><span className={`reaction-emoji reaction-emoji-${reactionKind(reaction.emoji)}`}>{reaction.emoji}</span><b>{reaction.name}</b></div>)}</div>}
        {pages > 1 && <div className="participant-pagination"><span>Screen {currentPage + 1} of {pages} · {visualParticipants.length} participants</span><div><button className="room-icon-button" onClick={() => setPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0} aria-label="Previous participant screen"><ChevronLeft size={18}/></button><button className="room-icon-button" onClick={() => setPage(Math.min(pages - 1, currentPage + 1))} disabled={currentPage >= pages - 1} aria-label="Next participant screen"><ChevronRight size={18}/></button></div></div>}
      </div>
      <div className={`room-control-dock ${!fullScreen || controlsVisible ? "dock-open" : "dock-hidden"}`} ref={dockRef} aria-hidden={fullScreen && !controlsVisible}>
        <div className="room-control-group room-control-row-a">
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isMicrophoneEnabled ? "control-disabled" : ""}`} onClick={() => void toggleMedia("microphone")} title={isMicrophoneEnabled ? "Turn microphone off" : "Turn microphone on"}>{isMicrophoneEnabled ? <Mic size={18}/> : <MicOff size={18}/>}<span>{isMicrophoneEnabled ? "Mic" : "Unmute"}</span></button><button data-popover="audioinput" className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "audioinput" ? null : "audioinput")} aria-label="Choose microphone" title="Choose microphone"><ChevronDown size={14}/></button>{deviceMenu === "audioinput" && <div data-popover="audioinput" className="room-device-menu">{inputDevices.filter((device) => device.kind === "audioinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("audioinput", device.deviceId)}>{device.label || `Microphone ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "audioinput").length === 0 && <span>No microphones found</span>}</div>}</div>
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isCameraEnabled ? "control-disabled" : ""}`} onClick={() => void toggleMedia("camera")} title={isCameraEnabled ? "Turn camera off" : "Turn camera on"}>{isCameraEnabled ? <VideoIcon size={18}/> : <VideoOff size={18}/>}<span>{isCameraEnabled ? "Camera" : "Camera off"}</span></button><button data-popover="videoinput" className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "videoinput" ? null : "videoinput")} aria-label="Choose camera" title="Choose camera"><ChevronDown size={14}/></button>{deviceMenu === "videoinput" && <div data-popover="videoinput" className="room-device-menu">{inputDevices.filter((device) => device.kind === "videoinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("videoinput", device.deviceId)}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "videoinput").length === 0 && <span>No cameras found</span>}</div>}</div>
          <button className={`room-control-button ${isScreenShareEnabled ? "control-selected" : ""}`} onClick={() => void toggleScreenShare()} title={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}><MonitorUp size={18}/><span>{isScreenShareEnabled ? "Stop share" : "Share"}</span></button>
          <button className={`room-control-button ${handRaised ? "control-selected" : ""}`} onClick={() => void toggleHand()} title={handRaised ? "Lower your hand" : "Raise your hand"}><Hand size={18}/><span>{handRaised ? "Lower hand" : "Raise hand"}</span></button>
        </div>
        <div className="room-control-group room-control-row-b">
          <div className="video-quality-control-wrap">
            <button type="button" className={`room-control-button video-quality-trigger ${videoQualityMenuOpen ? "control-selected" : ""}`} onClick={() => { setVideoQualityMenuOpen((open) => !open); setDeviceMenu(null); }} aria-expanded={videoQualityMenuOpen} aria-haspopup="dialog" title="Choose camera video quality">
              <Settings2 size={18}/><span>Quality</span>
            </button>
            {videoQualityMenuOpen && <section className="video-quality-menu" role="dialog" aria-label="Video quality settings">
              <header><div><b>Video quality</b><small>Choose how clearly your camera is sent and received</small></div><button type="button" onClick={() => setVideoQualityMenuOpen(false)} aria-label="Close video quality settings"><X size={16}/></button></header>
              <div className="video-quality-options" role="group" aria-label="Video quality preference">
                {VIDEO_QUALITY_OPTIONS.map((option) => {
                  const supported = option.value === "auto" || cameraSupportsQuality(option.height);
                  return <button type="button" key={option.value} className={`${videoQualityMode === option.value ? "is-selected" : ""} ${!supported ? "is-unavailable" : ""}`} aria-pressed={videoQualityMode === option.value} disabled={!supported} onClick={() => chooseVideoQuality(option.value)} title={!supported ? "The active camera does not report support for this resolution" : option.detail}>
                    <span className="video-quality-option-copy"><b>{option.label}</b><small>{!supported ? "Not supported by the active camera" : option.detail}</small></span>
                    {videoQualityMode === option.value && <Check size={16}/>}
                  </button>;
                })}
              </div>
              {videoProfileBusy && <p className="video-quality-status"><LoaderCircle size={13} className="spin"/> Updating camera profile…</p>}
              {videoQualityMode === "auto" && <p className="video-quality-status">Auto starts at 720p and changes resolution only after sustained network/device signals.</p>}
              <button type="button" className="video-diagnostics-toggle" onClick={() => setVideoDiagnosticsOpen((open) => !open)} aria-expanded={videoDiagnosticsOpen}>{videoDiagnosticsOpen ? "Hide live diagnostics" : "Show live diagnostics"}<ChevronDown size={14}/></button>
              {videoDiagnosticsOpen && <div className="video-diagnostics" aria-live="polite">
                <div><span>Your outgoing video</span><b>{formatVideoResolution(localVideoStats)}</b><small>{localVideoStats?.fps ? `${localVideoStats.fps} fps` : "Frame rate pending"} · {formatVideoBitrate(localVideoStats?.bitrateBps ?? 0)}</small><small>{localVideoStats?.packetLossPercent != null ? `${localVideoStats.packetLossPercent.toFixed(1)}% packet loss` : `Encoder: ${localVideoStats?.limitation ?? "Waiting"}`}{localVideoStats?.roundTripMs != null ? ` · ${Math.round(localVideoStats.roundTripMs)} ms RTT` : ""}</small></div>
                <div><span>Incoming video{remoteStatsName ? ` · ${remoteStatsName}` : " · active speaker"}</span><b>{formatVideoResolution(remoteVideoStats)}</b><small>{remoteVideoStats?.fps ? `${remoteVideoStats.fps} fps` : "Frame rate pending"} · {formatVideoBitrate(remoteVideoStats?.bitrateBps ?? 0)}</small><small>{remoteVideoStats?.packetLossPercent != null ? `${remoteVideoStats.packetLossPercent.toFixed(1)}% packet loss` : "Receiver statistics pending"}</small></div>
                <small>Values come from WebRTC sender/receiver reports. Resolution appears after encoded/decoded frames are available.</small>
              </div>}
            </section>}
          </div>
          <button className={`room-control-button message-control ${messagesOpen ? "control-selected" : ""}`} onClick={() => { setMessagesOpen(true); setPeopleOpen(false); setDirectContact(null); setNotesOpen(false); }} title="Open room messages"><MessageCircle size={18}/><span>Messages</span>{chatMessages.length > 0 && <i>{chatMessages.length}</i>}</button>
          <button className={`room-control-button people-control ${peopleOpen ? "control-selected" : ""}`} onClick={() => { setPeopleViewTab("people"); setPeopleOpen(true); setMessagesOpen(false); setDirectContact(null); setNotesOpen(false); }} title="See who is in the meeting"><Users size={18}/><span>People</span><i>{participants.length}</i></button>
          {RECORDING_UI_ENABLED && role === "host" && <button className={`room-control-button recording-control ${recordingState?.status === "recording" ? "recording-control-active" : ""}`} onClick={() => recordingState?.status === "recording" ? void stopRecording() : recordingState?.status === "uploading" || recordingState?.status === "consent_pending" ? undefined : recordingState?.status === "failed" && recordingState.canRetry ? void retryRecordingUpload() : void startRecording()} disabled={recordingBusy || recordingState?.status === "uploading" || recordingState?.status === "consent_pending"} title={recordingState?.status === "recording" ? "Stop audio recording" : recordingState?.status === "failed" && recordingState.canRetry ? "Retry audio upload" : "Start audio-only recording"}>{recordingBusy ? <LoaderCircle size={18} className="spin"/> : <span className="meeting-recording-dot"/>}<span>{recordingState?.status === "recording" ? "Stop" : recordingState?.status === "uploading" ? "Saving" : recordingState?.status === "consent_pending" ? "Consent" : recordingState?.status === "failed" && recordingState.canRetry ? "Retry upload" : "Record"}</span></button>}
          <button className={`room-control-button notes-control ${notesOpen ? "control-selected" : ""}`} onClick={() => { setNotesOpen(true); setMessagesOpen(false); setPeopleOpen(false); setDirectContact(null); }} title="Open collaborative meeting notes"><FileText size={18}/><span>Notes</span></button>
          <div className="reaction-control-wrap"><button data-popover="reactions" className={`room-control-button ${reactionsOpen ? "control-selected" : ""}`} onClick={() => setReactionsOpen((open) => !open)} title="Send an emoji or sticker reaction"><Smile size={18}/><span>React</span></button>{reactionsOpen && <div data-popover="reactions" className="reaction-picker" role="dialog" aria-label="Choose a reaction">{REACTION_SET.map((emoji) => <button key={emoji} onClick={() => void react(emoji)} aria-label={`Send ${emoji}`}>{emoji}</button>)}</div>}</div>
        <div className="room-control-side"><button className="room-icon-button room-theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</button><button className="room-icon-button fullscreen-control" onClick={() => void toggleFullscreen()} aria-label={fullScreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullScreen ? "Exit fullscreen" : "Fullscreen"}>{fullScreen ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>{role === "host" && <button className="room-icon-button room-end-button" onClick={onEndForEveryone} disabled={ending} title="End for everyone" aria-label="End for everyone"><X size={18}/></button>}<button className="room-leave-button" onClick={onLeave}><DoorOpen size={17}/><span>Leave</span></button></div></div>
      </div>
    </div>
    {(fullscreenPrompt || moderatorRequest || privateNotice || presenceToasts.length > 0 || messageToast) && <div className="room-bottom-notifications" aria-live="polite">
      {fullscreenPrompt && !fullScreen && <div className="fullscreen-fallback-prompt" role="status"><span>Fullscreen needs your permission. Tap once to enter.</span><button type="button" onClick={() => void toggleFullscreen()}>Enter fullscreen <Maximize2 size={15}/></button></div>}
      {moderatorRequest && <div className="moderator-request-banner" role="status"><span>{moderatorRequest.hostName} asks you to turn on your {moderatorRequest.media === "microphone" ? "microphone" : "camera"}. You choose whether to allow it.</span><button type="button" onClick={() => void acceptModeratorRequest()}>Review request</button><button type="button" className="request-dismiss" onClick={() => setModeratorRequest(null)} aria-label="Dismiss request"><X size={15}/></button></div>}
      {privateNotice && <div className="room-private-notice" role="status"><span><MessageCircle size={16}/> Private message from <b>{privateNotice.name}</b></span><button type="button" onClick={() => openPrivateContact(privateNotice)}>Open chat</button><button type="button" className="notice-dismiss" onClick={() => setPrivateNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}
      {presenceToasts.length > 0 && <div className="room-presence-stack" aria-live="polite">{presenceToasts.map((toast) => <div className={`room-presence-toast room-presence-${toast.kind}`} key={toast.id} role="status"><span className="room-presence-icon">{toast.kind === "joined" ? <LogIn size={15}/> : <LogOut size={15}/>}</span><span className="room-presence-text"><b>{toast.name}</b> {toast.kind === "joined" ? "joined the meeting" : "left the meeting"}</span></div>)}</div>}
      {messageToast && <button type="button" className="room-message-toast" key={messageToast.id} onClick={() => { setMessagesOpen(true); setPeopleOpen(false); }} aria-label={`Open message from ${messageToast.name}`}><span className="room-message-toast-icon"><MessageCircle size={16}/></span><span className="room-message-toast-body"><b>{messageToast.name}</b><span>{messageToast.text}</span></span></button>}
    </div>}
    {mediaModal && <MediaPermissionModal
      kind={mediaModal.kind}
      state={mediaModal.state}
      skipLabel="Not now"
      grantedLabel="Turning on…"
      onRetry={() => void askMedia(mediaModal.kind)}
      onGranted={() => { mediaAllowed[mediaModal.kind as MediaKind] = true; void enableMedia(mediaModal.kind); }}
      onSkip={() => { mediaAttemptRef.current++; setMediaModal(null); }}
      onClose={() => { mediaAttemptRef.current++; setMediaModal(null); }}
    />}
    {RECORDING_UI_ENABLED && recordingState?.status === "consent_pending" && recordingState.myDecision === "pending" && <div className="recording-consent-backdrop" role="presentation"><section className="recording-consent-modal" role="dialog" aria-modal="true" aria-labelledby="recording-consent-title"><span className="recording-consent-icon"><AudioLines size={24}/></span><p className="section-overline">MEETING AUDIO RECORDING REQUEST</p><h2 id="recording-consent-title">The host would like to record</h2><p>The recording captures synchronized audio from the connected participants. No camera video is recorded. Your choice is saved with the meeting record. You can decline; recording will not begin unless everyone currently connected accepts.</p><div className="recording-consent-list">{recordingState.consents.map((item) => <span key={item.identity}><b>{item.displayName}</b><small>{item.decision === "accepted" ? "Accepted" : item.decision === "declined" ? "Declined" : "Awaiting response"}</small></span>)}</div><div className="recording-consent-actions"><button type="button" className="button button-soft" disabled={recordingConsentBusy} onClick={() => void respondToRecordingConsent(false)}>Decline</button><button type="button" className="button button-primary" disabled={recordingConsentBusy} onClick={() => void respondToRecordingConsent(true)}>{recordingConsentBusy ? "Saving…" : "I consent"}</button></div></section></div>}
    {notesOpen && <div className="messages-modal-backdrop meeting-notes-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNotesOpen(false); }}><section className="messages-modal meeting-notes-modal" role="dialog" aria-modal="true" aria-label="Collaborative meeting notes"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setNotesOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div className="meeting-panel-heading"><b>Meeting notes</b><small>{meeting.title}</small></div><button className="room-icon-button" onClick={() => setNotesOpen(false)} aria-label="Close notes"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className="meeting-panel-tab" onClick={() => { setNotesOpen(false); setMessagesOpen(true); }}>Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setNotesOpen(false); setPeopleViewTab("people"); setPeopleOpen(true); }}>People</button><button type="button" className="meeting-panel-tab" onClick={() => { setNotesOpen(false); setPeopleViewTab("private"); setPeopleOpen(true); }}>Private chats</button><button type="button" className="meeting-panel-tab meeting-panel-tab-active" aria-current="page">Notes</button></nav><div className="meeting-notes-body"><label className="meeting-notes-title-label">Note title<input value={notesTitle} onChange={(event) => updateMeetingNotesTitle(event.target.value)} onBlur={() => { if (notesDirtyRef.current && !notesConflict) void saveMeetingNotes(); }} maxLength={120} aria-label="Meeting notes title"/></label><div className="meeting-notes-toolbar" role="toolbar" aria-label="Note formatting"><button type="button" title="Bold" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("bold")}><Bold size={16}/></button><button type="button" title="Italic" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("italic")}><Italic size={16}/></button><button type="button" title="Underline" aria-label="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("underline")}><Underline size={16}/></button><button type="button" title="Heading 1" aria-label="Heading 1" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("formatBlock", "<h1>")}><Heading1 size={16}/></button><button type="button" title="Heading 2" aria-label="Heading 2" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("formatBlock", "<h2>")}><Heading2 size={16}/></button><button type="button" title="Bulleted list" aria-label="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("insertUnorderedList")}><List size={16}/></button><button type="button" title="Numbered list" aria-label="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("insertOrderedList")}><ListOrdered size={16}/></button><button type="button" title="Indent" aria-label="Indent" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("indent")}><IndentIncrease size={16}/></button><button type="button" title="Outdent" aria-label="Outdent" onMouseDown={(event) => event.preventDefault()} onClick={() => formatNote("outdent")}><IndentDecrease size={16}/></button></div>{notesLoading ? <div className="meeting-notes-loading"><LoaderCircle size={22} className="spin"/> Loading notes…</div> : <div ref={notesEditorRef} className="meeting-notes-editor" contentEditable suppressContentEditableWarning role="textbox" aria-label="Collaborative meeting notes editor" aria-multiline="true" data-placeholder="Capture decisions, action items, and key points together…" onInput={(event) => updateMeetingNotes(event.currentTarget.innerHTML)} onBlur={() => { if (notesDirtyRef.current && !notesConflict) void saveMeetingNotes(); }}></div>}{notesError && <div className="meeting-notes-error" role="alert">{notesError}{notesConflict && <div className="meeting-notes-conflict-actions"><button type="button" onClick={() => void loadMeetingNotes(true)}>Load latest</button><button type="button" onClick={() => void saveMeetingNotes(true)}>Keep my version</button></div>}</div>}<div className="meeting-notes-footer"><span className="meeting-notes-save-state">{notesSaving ? "Saving…" : notesDirty ? "Unsaved changes" : notesUpdatedBy ? `Saved · ${notesUpdatedBy}` : "Saved for meeting participants"}</span><button type="button" className="button button-soft button-small" onClick={exportNotesPdf}><Download size={15}/> Export PDF</button><button type="button" className="button button-primary button-small" onClick={() => void saveMeetingNotes(notesConflict)} disabled={!notesDirty || notesSaving}><Check size={15}/> Save now</button></div></div></section></div>}
    {messagesOpen && <div className="messages-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMessagesOpen(false); }}><section className="messages-modal" role="dialog" aria-modal="true" aria-label="Meeting messages"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div className="meeting-panel-heading"><b>Meeting messages</b><small>Chat with everyone in this room</small></div><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Close messages"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className="meeting-panel-tab meeting-panel-tab-active" aria-current="page">Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setPeopleViewTab("people"); setPeopleOpen(true); }}>People</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setPeopleViewTab("private"); setPeopleOpen(true); }}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setNotesOpen(true); }}>Notes</button></nav><div className="messages-modal-body">{chatMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No messages yet</b><span>Send a note to everyone in this gathering.</span></div> : chatMessages.map((message, index) => <article className={`chat-message ${message.from?.identity === localIdentity ? "chat-message-own" : ""}`} key={`${message.timestamp}-${index}`}><span className="chat-message-author">{message.from?.name || (message.from?.identity === localIdentity ? "You" : "Choir guest")}</span><p>{message.message}</p><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article>)}<div ref={chatEndRef}/></div><form className="messages-composer" onSubmit={sendMessage}><input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message…" maxLength={2000} aria-label="Message"/><button className="button button-primary" type="submit" disabled={!messageText.trim() || isSending} aria-label="Send message"><Send size={17}/></button></form></section></div>}
    {peopleOpen && <div className="messages-modal-backdrop people-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPeopleOpen(false); }}><section className="messages-modal people-modal" role="dialog" aria-modal="true" aria-label="People and private chats"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setPeopleOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div className="meeting-panel-heading"><b>{peopleViewTab === "people" ? "People" : "Private chats"}</b><small>{peopleViewTab === "people" ? `${participants.length} currently online · presence updates live` : `${recentConversations.length} saved conversations`}</small></div><button className="room-icon-button" onClick={() => setPeopleOpen(false)} aria-label="Close people"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className={`meeting-panel-tab ${peopleViewTab === "people" ? "meeting-panel-tab-active" : ""}`} aria-current={peopleViewTab === "people" ? "page" : undefined} onClick={() => setPeopleViewTab("people")}>People</button><button type="button" className={`meeting-panel-tab ${peopleViewTab === "private" ? "meeting-panel-tab-active" : ""}`} aria-current={peopleViewTab === "private" ? "page" : undefined} onClick={() => setPeopleViewTab("private")}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setPeopleOpen(false); setMessagesOpen(true); }}>Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setPeopleOpen(false); setNotesOpen(true); }}>Notes</button></nav><div className="people-directory-body">{peopleViewTab === "people" ? <><div className="people-online-heading"><span><span className="people-online-dot"/> Online now</span><b>{participants.length}</b></div>{[...participants].sort((a, b) => getParticipantRole(a) === getParticipantRole(b) ? participantName(a).localeCompare(participantName(b)) : getParticipantRole(a) === "host" ? -1 : 1).map((person) => {
      const isSelf = person.identity === localIdentity;
      const micMuted = person.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true;
      const cameraMuted = person.getTrackPublication(Track.Source.Camera)?.isMuted ?? true;
      const isHostPerson = getParticipantRole(person) === "host";
      const busy = moderationBusy === person.identity;
      return <article className="people-person-row" key={person.identity}><ProfilePhoto src={participantPicture(person.metadata, person.identity)} name={participantName(person)} size={128} className="people-person-avatar"/><div className="people-person-details"><div className="people-person-title"><b>{participantName(person) || "Participant"}{isSelf ? " · You" : ""}</b>{isHostPerson && <span className="people-host-tag">HOST</span>}</div><small><span className="people-online-dot"/> Connected {person.isSpeaking ? "· Speaking" : ""}{micMuted ? " · Mic off" : " · Mic on"}{cameraMuted ? " · Camera off" : " · Camera on"}</small></div>{!isSelf && <div className="people-person-actions"><button type="button" onClick={() => void focusParticipant(person.identity)} title={spotlightIdentity === person.identity ? "Clear participant focus" : "Bring participant into the main view"}>{spotlightIdentity === person.identity ? "Unfocus" : "Focus"}</button><button type="button" onClick={() => openPrivateConversation(person)} title={`Private message ${participantName(person) || "participant"}`}><MessageCircle size={15}/><span>Message</span></button>{role === "host" && !isHostPerson && <details className="people-more-menu"><summary aria-label={`Host actions for ${participantName(person) || "participant"}`}><ChevronDown size={16}/></summary><div className="people-more-popover"><button type="button" disabled={busy} onClick={() => void moderateParticipant(person, micMuted ? "request-unmute" : "mute-mic")}>{micMuted ? "Request microphone" : "Mute microphone"}</button><button type="button" disabled={busy} onClick={() => void moderateParticipant(person, cameraMuted ? "request-camera" : "disable-camera")}>{cameraMuted ? "Request camera" : "Disable camera"}</button><button type="button" disabled={busy} onClick={() => void moderateParticipant(person, "remove")}>Remove from meeting</button><button type="button" className="people-ban-action" disabled={busy} onClick={() => void moderateParticipant(person, "ban")}>Remove and block re-entry</button></div></details>}</div>}{isSelf && <span className="people-you-tag">You</span>}</article>;
    })}{participants.length === 1 && <div className="people-alone-note">You are the only person connected right now.</div>}</> : <section className="people-recent-conversations"><div className="people-recent-heading">Saved private conversations</div>{recentConversations.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No private conversations yet</b><span>Start a one-to-one conversation from the People tab.</span></div> : recentConversations.map((contact) => {
      const online = participants.some((person) => participantUserId(person) === contact.userId);
      return <button type="button" className="people-recent-row" key={contact.userId} onClick={() => openPrivateContact({ userId: contact.userId, identity: "", name: contact.name, picture: contact.picture })}><ProfilePhoto src={contact.picture} name={contact.name} size={96} className="people-person-avatar"/><span className="people-recent-copy"><b>{contact.name}</b><small>{contact.lastMessage}</small></span><span className={`people-recent-status ${online ? "is-online" : ""}`}>{online ? "Online" : "Saved"}</span></button>;
    })}</section>}</div></section></div>}
    {directContact && <div className="messages-modal-backdrop private-chat-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDirectContact(null); }}><section className="messages-modal private-chat-modal" role="dialog" aria-modal="true" aria-label={`Private conversation with ${directContact.name}`}><header className="messages-modal-header"><button className="room-icon-button" onClick={() => { setDirectContact(null); setPeopleViewTab("private"); setPeopleOpen(true); }} aria-label="Back to private chats"><ArrowLeft size={18}/></button><ProfilePhoto src={directContact.picture} name={directContact.name} size={64} className="private-chat-avatar"/><div className="meeting-panel-heading"><b>{directContact.name}</b><small>Private one-to-one conversation</small></div><button className="room-icon-button" onClick={() => { setDirectContact(null); setPeopleViewTab("private"); setPeopleOpen(true); }} aria-label="Close private messages"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setPeopleViewTab("people"); setPeopleOpen(true); }}>People</button><button type="button" className="meeting-panel-tab meeting-panel-tab-active" aria-current="page" onClick={() => { setDirectContact(null); setPeopleViewTab("private"); setPeopleOpen(true); }}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setMessagesOpen(true); }}>Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setNotesOpen(true); }}>Notes</button></nav><div className="messages-modal-body private-chat-body">{privateLoading ? <div className="messages-empty"><LoaderCircle size={23} className="spin"/><span>Loading private conversation…</span></div> : privateMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No private messages yet</b><span>Only you and {directContact.name} can see this conversation.</span></div> : privateMessages.map((message) => <article className={`chat-message ${message.senderUserId === localUserId ? "chat-message-own" : ""}`} key={message.id}><span className="chat-message-author">{message.senderUserId === localUserId ? "You" : message.senderName}</span><p>{message.message}</p><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article>)}<div ref={privateChatEndRef}/></div><form className="messages-composer" onSubmit={sendPrivateMessage}><input value={privateDraft} onChange={(event) => setPrivateDraft(event.target.value)} placeholder={`Message ${directContact.name} privately…`} maxLength={2000} aria-label="Private message"/><button className="button button-primary" type="submit" disabled={!privateDraft.trim() || privateSending || privateLoading} aria-label="Send private message">{privateSending ? <LoaderCircle size={17} className="spin"/> : <Send size={17}/>}</button></form></section></div>}
    {role === "host" && <span className="room-host-sr" aria-hidden="true">{meeting.ownerName} is hosting</span>}
  </div>;
}

function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (user: User, token: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleCredential(credential: string) {
    setBusy(true); setError("");
    try {
      const result = await api.googleSignIn(credential);
      await preloadPhotoBriefly(result.user.picture, 512, 1200);
      onAuthenticated(result.user, result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in with Google.");
    } finally { setBusy(false); }
  }

  return <Modal onClose={onClose} wide={false}>
    <div className="auth-modal-content"><span className="modal-brand-icon"><AudioLines size={23}/></span><p className="section-overline">WELCOME TO YOUR GATHERING SPACE</p><h2>Good to have you here.</h2><p className="modal-subtitle">Continue with Google to sign in or create your account. We use your Google name and profile photo — no password needed.</p>
      <div className="form-stack">
        <GoogleContinueButton onCredential={(credential) => void handleCredential(credential)}/>
        {busy && <div className="auth-busy"><LoaderCircle size={16} className="spin"/> Signing you in…</div>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div><p className="auth-legal"><ShieldCheck size={13}/> Your account is used to manage the meetings you host.</p>
    </div>
  </Modal>;
}

const DURATION_OPTIONS = [{ value: "15", label: "15 minutes" }, { value: "30", label: "30 minutes" }, { value: "45", label: "45 minutes" }, { value: "60", label: "1 hour" }, { value: "90", label: "1.5 hours" }, { value: "120", label: "2 hours" }, { value: "180", label: "3 hours" }, { value: "240", label: "4 hours" }];
// Decides whether a dropdown opens below or above its button, based on the room left inside the modal body / screen.
function usePopoverDirection(open: boolean, wrapRef: RefObject<HTMLElement | null>, popRef: RefObject<HTMLElement | null>) {
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setUp(false); return; }
    const place = () => {
      const wrap = wrapRef.current; const pop = popRef.current;
      if (!wrap || !pop) return;
      const trigger = wrap.getBoundingClientRect();
      const box = wrap.closest<HTMLElement>(".modal-scroll-body")?.getBoundingClientRect();
      const limitTop = Math.max(0, box?.top ?? 0);
      const limitBottom = Math.min(window.innerHeight, box?.bottom ?? window.innerHeight);
      const need = pop.offsetHeight + 14;
      const below = limitBottom - trigger.bottom;
      const above = trigger.top - limitTop;
      const goUp = below < need && above > below;
      setUp(goUp);
      if (below < need && above < need) requestAnimationFrame(() => pop.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, wrapRef, popRef]);
  return up;
}
function DurationPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const up = usePopoverDirection(open, wrapRef, popRef);
  const selected = DURATION_OPTIONS.find((item) => item.value === value) || DURATION_OPTIONS[3];
  return <div className="custom-picker-wrap" ref={wrapRef}><button type="button" className="custom-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><Clock3 size={16}/><span>{selected.label}</span><ChevronRight size={15} className={open ? "picker-chevron-open" : "picker-chevron"}/></button>{open && <><button type="button" className="picker-dismiss" aria-label="Close duration options" onClick={() => setOpen(false)}/><div ref={popRef} className={`custom-picker-menu duration-picker-menu ${up ? "popover-up" : ""}`} role="listbox" aria-label="Meeting duration">{DURATION_OPTIONS.map((option) => <button type="button" key={option.value} role="option" aria-selected={value === option.value} className={value === option.value ? "custom-picker-option picker-option-active" : "custom-picker-option"} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}{value === option.value && <Check size={15}/>}</button>)}</div></>}</div>;
}
function TimePicker({ value, datePart, onChange }: { value: string; datePart: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const up = usePopoverDirection(open, wrapRef, popRef);
  const [h24, minute] = (value || "12:00").split(":").map((part) => Number(part) || 0);
  const period = h24 >= 12 ? "PM" : "AM";
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  const to24 = (h: number, p: string) => (h % 12) + (p === "PM" ? 12 : 0);
  const isPast = (hour: number, min: number) => datePart === localDateTimeValue(new Date()).slice(0, 10) && new Date(`${datePart}T${pad(hour)}:${pad(min)}:59`).getTime() < Date.now();
  const emit = (hour: number, min: number) => onChange(`${pad(hour)}:${pad(min)}`);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      for (const ref of [hourRef, minuteRef]) {
        const active = ref.current?.querySelector<HTMLElement>(".time-option-active");
        if (active && ref.current) ref.current.scrollTop = active.offsetTop - ref.current.clientHeight / 2 + active.clientHeight / 2;
      }
    });
  }, [open]);
  const label = new Date(`2000-01-01T${pad(h24)}:${pad(minute)}:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return <div className="custom-picker-wrap time-picker-wrap" ref={wrapRef}><button type="button" className="custom-picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label="Meeting time" onClick={() => setOpen((current) => !current)}><Clock3 size={16}/><span>{label}</span><ChevronRight size={15} className={open ? "picker-chevron-open" : "picker-chevron"}/></button>{open && <><button type="button" className="picker-dismiss" aria-label="Close time picker" onClick={() => setOpen(false)}/><div ref={popRef} className={`custom-calendar-popover time-popover ${up ? "popover-up" : ""}`} role="dialog" aria-label="Choose time"><div className="time-columns"><div className="time-column" ref={hourRef} role="listbox" aria-label="Hour">{Array.from({ length: 12 }, (_, index) => index + 1).map((h) => <button type="button" key={h} role="option" aria-selected={h === hour12} disabled={isPast(to24(h, period), 59)} className={h === hour12 ? "time-option time-option-active" : "time-option"} onClick={() => emit(to24(h, period), minute)}>{pad(h)}</button>)}</div><div className="time-column" ref={minuteRef} role="listbox" aria-label="Minute">{Array.from({ length: 60 }, (_, index) => index).map((m) => <button type="button" key={m} role="option" aria-selected={m === minute} disabled={isPast(h24, m)} className={m === minute ? "time-option time-option-active" : "time-option"} onClick={() => emit(h24, m)}>{pad(m)}</button>)}</div><div className="time-column time-column-period" role="listbox" aria-label="AM or PM">{["AM", "PM"].map((p) => <button type="button" key={p} role="option" aria-selected={p === period} disabled={isPast(to24(hour12, p), 59)} className={p === period ? "time-option time-option-active" : "time-option"} onClick={() => emit(to24(hour12, p), minute)}>{p}</button>)}</div></div><button type="button" className="button button-primary time-done" onClick={() => setOpen(false)}>Done</button></div></>}</div>;
}
function CustomDateTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const datePart = value.slice(0, 10);
  const timePart = value.slice(11, 16) || "12:00";
  const selectedDate = new Date(`${datePart || localDateTimeValue(new Date()).slice(0, 10)}T12:00:00`);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarWrapRef = useRef<HTMLDivElement>(null);
  const calendarPopRef = useRef<HTMLDivElement>(null);
  const calendarUp = usePopoverDirection(calendarOpen, calendarWrapRef, calendarPopRef);
  const [shownMonth, setShownMonth] = useState(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  useEffect(() => { setShownMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1)); }, [datePart]);
  const firstDay = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1).getDay();
  const dayCount = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 0).getDate();
  const today = localDateTimeValue(new Date()).slice(0, 10);
  const updateDate = (date: string) => onChange(`${date}T${timePart}`);
  return <div className="custom-datetime"><div className="custom-datetime-row"><div className="custom-picker-wrap date-picker-wrap" ref={calendarWrapRef}><button type="button" className="custom-picker-trigger" onClick={() => setCalendarOpen((current) => !current)} aria-expanded={calendarOpen}><CalendarDays size={16}/><span>{selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><ChevronRight size={15} className={calendarOpen ? "picker-chevron-open" : "picker-chevron"}/></button>{calendarOpen && <><button type="button" className="picker-dismiss" aria-label="Close calendar" onClick={() => setCalendarOpen(false)}/><div ref={calendarPopRef} className={`custom-calendar-popover ${calendarUp ? "popover-up" : ""}`}><div className="calendar-month-row"><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={16}/></button><b>{shownMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={16}/></button></div><div className="calendar-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="calendar-days">{Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`}/>)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const date = `${shownMonth.getFullYear()}-${String(shownMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; const isPast = date < today; return <button type="button" key={date} disabled={isPast} className={`${date === datePart ? "calendar-day-active" : ""} ${date === today ? "calendar-day-today" : ""}`} onClick={() => { updateDate(date); setCalendarOpen(false); }}>{day}</button>; })}</div></div></>}</div><TimePicker value={timePart} datePart={datePart} onChange={(time) => onChange(`${datePart}T${time}`)} /></div><input className="visually-hidden-date-value" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} min={localDateTimeValue(new Date(Date.now() - 60_000))} tabIndex={-1} aria-hidden="true"/></div>;
}

function ScheduleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (meeting: Meeting, shareUrl: string) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [meetingType, setMeetingType] = useState<"meeting" | "prayer" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(localDateTimeValue(new Date(Date.now() + 15 * 60_000)));
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ meeting: Meeting; shareUrl: string } | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Kigali";

  function nextStep() {
    setError("");
    if (step === 1) {
      if (!meetingType) { setError("Choose Meeting or Online Prayer to continue."); return; }
      setStep(2); return;
    }
    if (step === 2) {
      if (title.trim().length < 3) { setError("Enter a meeting title of at least 3 characters."); return; }
      if (description.trim().length < 3) { setError("Enter a short description of at least 3 characters."); return; }
      setStep(3);
    }
  }

  // Creation only ever happens from an explicit click on the Create button (never from Enter, picker taps or step changes).
  async function submit(event?: FormEvent) {
    event?.preventDefault(); setError("");
    if (step !== 3 || busy) return;
    if (!meetingType) { setStep(1); setError("Choose a gathering type."); return; }
    if (title.trim().length < 3 || description.trim().length < 3) { setStep(2); setError("Enter both a meeting title and description."); return; }
    const startMillis = new Date(startsAt).getTime();
    if (!startsAt || !Number.isFinite(startMillis) || startMillis <= Date.now() + 30_000) {
      setError("Choose a valid date and time at least 30 seconds in the future."); return;
    }
    const duration = Number(durationMinutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 240) {
      setError("Choose a duration between 15 and 240 minutes."); return;
    }
    setBusy(true);
    try {
      const result = await api.createMeeting({
        title: title.trim(), description: description.trim(), startsAt: new Date(startMillis).toISOString(),
        durationMinutes: duration, timezone, meetingType, thumbnailUrl: "",
      });
      const shareUrl = `${window.location.origin}/share/${encodeURIComponent(result.meeting.slug)}`;
      setCreated({ meeting: result.meeting, shareUrl });
      onCreated(result.meeting, shareUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this gathering.");
    } finally { setBusy(false); }
  }

  async function copyShare() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.shareUrl); window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Invitation link copied to clipboard." } })); }
    catch { setError(`Copy this link: ${created.shareUrl}`); }
  }
  async function shareMeeting() {
    if (!created) return;
    try { if (navigator.share) await navigator.share({ title: created.meeting.title, text: "You are invited to join MEET ENIHAKOLE.", url: created.shareUrl }); else await copyShare(); }
    catch { /* The share sheet can be dismissed without action. */ }
  }

  return <Modal onClose={onClose} solidTop>
    {!created ? <div className="schedule-modal-content">
      <div className="modal-heading-row"><span className="modal-brand-icon"><CalendarClock size={22}/></span><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19}/></button></div>
      <div className="modal-scroll-body">
        <p className="section-overline">CREATE A GATHERING</p>
        <h2>{step === 1 ? "What are we gathering for?" : step === 2 ? (meetingType === "prayer" ? "Describe your Online Prayer." : "Give your meeting a name.") : "Choose when to meet."}</h2>
        <p className="modal-subtitle">{step === 1 ? "Choose the kind of gathering you want to create." : step === 2 ? "Add a clear title and a short description for participants." : "Set the date, time, and planned duration. Joining opens automatically at the scheduled start."}</p>
        {step === 1 && <div className="gathering-type-options" role="group" aria-label="Gathering type">
          <button type="button" className={`gathering-type-card ${meetingType === "meeting" ? "is-selected" : ""}`} aria-pressed={meetingType === "meeting"} onClick={() => { setMeetingType("meeting"); setError(""); }}><span><Users size={22}/></span><b>Meeting</b><small>Private gathering accessible through its invitation link.</small></button>
          <button type="button" className={`gathering-type-card ${meetingType === "prayer" ? "is-selected" : ""}`} aria-pressed={meetingType === "prayer"} onClick={() => { setMeetingType("prayer"); setError(""); }}><span><HeartHandshake size={22}/></span><b>Online Prayer</b><small>Publicly discoverable before, during, and after the prayer.</small></button>
        </div>}
        {step === 2 && <div className="form-stack schedule-form">
          <label className="field-label">{meetingType === "prayer" ? "Prayer title" : "Meeting title"}<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder={meetingType === "prayer" ? "e.g. Wednesday morning prayer" : "e.g. Choir planning meeting"} required autoFocus/></label>
          <label className="field-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} minLength={3} maxLength={1000} placeholder="Describe the purpose of this gathering and what participants can expect." required/></label>
        </div>}
        {step === 3 && <form id="schedule-form" onSubmit={(event) => event.preventDefault()} className="form-stack schedule-form">
          <div className="form-row"><label className="field-label">Date and time<CustomDateTimePicker value={startsAt} onChange={setStartsAt}/></label><label className="field-label">Duration<DurationPicker value={durationMinutes} onChange={setDurationMinutes}/></label></div>
          <div className="gathering-visibility-note"><ShieldCheck size={17}/><span>{meetingType === "prayer" ? "Online Prayer will be publicly listed for everyone to discover." : "This Meeting stays private. Only people with its unique invitation link can open it."}</span></div>
          <small className="modal-timezone"><Clock3 size={14}/>{timezone}</small>
        </form>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
      <div className="schedule-modal-footer schedule-step-footer">
        {step > 1 ? <button className="button button-soft" type="button" onClick={() => { setStep((step - 1) as 1 | 2); setError(""); }} disabled={busy}><ChevronLeft size={16}/> Back</button> : <button className="button button-soft" type="button" onClick={onClose}>Cancel</button>}
        {step < 3 ? <button key="schedule-continue" className="button button-primary" type="button" onClick={nextStep} disabled={step === 1 && !meetingType}>Continue <ArrowRight size={15}/></button> : <button key="schedule-create" className="button button-primary" type="button" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : meetingType === "prayer" ? <HeartHandshake size={16}/> : <CalendarDays size={16}/>} {busy ? "Creating…" : meetingType === "prayer" ? "Schedule Online Prayer" : "Create Meeting"} <ArrowRight size={15}/></button>}
      </div>
    </div> : <div className="schedule-success"><div className="modal-scroll-body"><span className="success-icon"><CheckCircle2 size={27}/></span><p className="section-overline">YOUR INVITATION IS READY</p><h2>It's all set.</h2><p className="modal-subtitle">{created.meeting.meetingType === "prayer" ? "Your Online Prayer is listed publicly. Share the invitation too." : "Your private meeting is ready. Only people with this invitation link can open it."}</p><div className="success-meeting-preview"><img src={meetingImage(created.meeting)} alt="Meeting cover"/><div><b>{created.meeting.title}</b><small>{formatDate(created.meeting.startsAt, {}, created.meeting.timezone)} · {created.meeting.durationMinutes} min</small></div></div><div className="share-url-box"><Link2 size={15}/><span>{created.shareUrl}</span><button className="icon-button" onClick={copyShare} aria-label="Copy link"><Copy size={15}/></button></div></div><div className="success-actions modal-footer-fixed"><button className="button button-primary button-full" onClick={() => void shareMeeting()}><Share2 size={16}/> Share invitation</button><Link className="button button-soft button-full" to={`/meeting/${created.meeting.slug}`} onClick={onClose}>Open gathering page <ArrowRight size={16}/></Link><button className="text-action centered-action" onClick={onClose}>Back to workspace</button></div></div>}
  </Modal>;
}

function Modal({ children, onClose, wide = true, solidTop = false }: { children: ReactNode; onClose: () => void; wide?: boolean; solidTop?: boolean }) {
  const panelRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const drag = useRef<{ y: number; x: number; lastY: number; lastT: number; velocity: number; active: boolean; locked: boolean } | null>(null);
  const frame = useRef(0);
  const offset = useRef(0);

  const paint = (animated: boolean) => {
    const panel = panelRef.current; const backdrop = backdropRef.current;
    if (!panel) return;
    panel.style.transition = animated ? "transform .28s cubic-bezier(.22,1,.36,1)" : "none";
    panel.style.transform = `translate3d(0, ${offset.current}px, 0)`;
    if (backdrop) {
      backdrop.style.transition = animated ? "opacity .28s ease" : "none";
      backdrop.style.opacity = String(Math.max(0, 1 - offset.current / Math.max(1, panel.offsetHeight) * 0.9));
    }
  };
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const panel = panelRef.current;
    if (!panel || window.innerWidth > 720) { onCloseRef.current(); return; }
    offset.current = panel.offsetHeight + 40;
    paint(true);
    window.setTimeout(() => onCloseRef.current(), 250);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.classList.remove("modal-open"); cancelAnimationFrame(frame.current); };
  }, []);

  const onTouchStart = (event: ReactTouchEvent) => {
    if (window.innerWidth > 720 || closingRef.current) return;
    const target = event.target as HTMLElement;
    if (!target.closest(".modal-drag-handle, .modal-heading-row")) { drag.current = null; return; }
    if (target.closest("button")) { drag.current = null; return; }
    const touch = event.touches[0];
    const panel = panelRef.current;
    if (panel) { panel.style.animation = "none"; }
    drag.current = { y: touch.clientY, x: touch.clientX, lastY: touch.clientY, lastT: performance.now(), velocity: 0, active: false, locked: false };
  };
  const onTouchMove = (event: ReactTouchEvent) => {
    const d = drag.current; if (!d) return;
    const touch = event.touches[0];
    const dy = touch.clientY - d.y; const dx = touch.clientX - d.x;
    if (!d.locked) {
      if (Math.abs(dy) < 4 && Math.abs(dx) < 4) return;
      d.locked = true; d.active = Math.abs(dy) > Math.abs(dx);
      if (!d.active) { drag.current = null; return; }
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.velocity = d.velocity * 0.6 + ((touch.clientY - d.lastY) / dt) * 0.4;
    d.lastY = touch.clientY; d.lastT = now;
    // Follow the finger 1:1 downward; add rubber-band resistance when pulling upward.
    offset.current = dy >= 0 ? dy : dy / 6;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => paint(false));
  };
  const onTouchEnd = () => {
    const d = drag.current; drag.current = null;
    if (!d || !d.active) return;
    const panel = panelRef.current; const height = panel?.offsetHeight || 600;
    cancelAnimationFrame(frame.current);
    if (offset.current > height * 0.28 || d.velocity > 0.55) requestClose();
    else { offset.current = 0; paint(true); }
  };

  return <div ref={backdropRef} className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}><section ref={panelRef} className={`modal-panel ${wide ? "modal-panel-wide" : "modal-panel-narrow"} ${solidTop ? "modal-panel-solid-top" : ""}`} role="dialog" aria-modal="true" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}><div className="modal-drag-handle" aria-hidden="true"><span/></div>{children}</section></div>;
}
function StandaloneLoading({ label }: { label: string }) {
  return <div className="standalone-state"><span className="modal-brand-icon"><AudioLines size={23}/></span><LoaderCircle size={22} className="spin"/><p>{label}</p></div>;
}

function StandaloneError({ message, action }: { message: string; action?: ReactNode }) {
  return <div className="standalone-state"><span className="modal-brand-icon"><AudioLines size={23}/></span><h1>Let's get you connected.</h1><p>{message}</p>{action || <Link to="/" className="button button-primary"><ArrowLeft size={16}/> Back to MEET ENIHAKOLE</Link>}</div>;
}

function ToastHost() {
  const [toast, setToast] = useState<{ message: string; action?: string; shareUrl?: string } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let expiry = 0;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; action?: string; shareUrl?: string }>).detail;
      setToast(detail);
      window.clearTimeout(expiry);
      expiry = window.setTimeout(() => setToast((current) => current === detail ? null : current), 4200);
    };
    const updateTarget = () => {
      const fullscreen = document.fullscreenElement instanceof HTMLElement && document.fullscreenElement.classList.contains("conference-fullscreen-target") ? document.fullscreenElement : null;
      const pseudo = document.querySelector<HTMLElement>(".conference-fullscreen-target.is-pseudo-fullscreen");
      setPortalTarget(fullscreen || pseudo || document.body);
    };
    updateTarget();
    window.addEventListener("meet-toast", handler);
    document.addEventListener("fullscreenchange", updateTarget);
    window.addEventListener("meet-pseudo-fullscreen-change", updateTarget);
    return () => {
      window.clearTimeout(expiry);
      window.removeEventListener("meet-toast", handler);
      document.removeEventListener("fullscreenchange", updateTarget);
      window.removeEventListener("meet-pseudo-fullscreen-change", updateTarget);
    };
  }, []);
  if (!toast || !portalTarget) return null;
  return createPortal(<div className="toast-message" role="status"><span className="toast-check"><Check size={15}/></span><span>{toast.message}</span>{toast.action && toast.shareUrl && <button onClick={() => void navigator.clipboard.writeText(toast.shareUrl!)}>{toast.action}</button>}<button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14}/></button></div>, portalTarget);
}
