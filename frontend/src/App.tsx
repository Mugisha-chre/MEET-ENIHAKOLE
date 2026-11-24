import { createPortal } from "react-dom";
import { createContext, memo, startTransition, useCallback, useId, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject, type FormEvent, type ReactNode, type TouchEvent as ReactTouchEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { LiveKitRoom, ParticipantTile, RoomAudioRenderer, isTrackReference, useChat, useIsMuted, useLocalParticipant, useParticipants, useRoomContext, useTracks, VideoTrack, type TrackReference } from "@livekit/components-react";
import { ConnectionState, DisconnectReason, MediaDeviceFailure, ParticipantEvent, Room, RoomEvent, Track, VideoPresets, VideoQuality, type Participant, type RemoteParticipant, type RoomOptions, type VideoCaptureOptions } from "livekit-client";
import {
  ArrowLeft, ArrowRight, AudioLines, CalendarClock, CalendarDays, Check,
  CheckCircle2, CircleHelp, Clock3, Copy, DoorOpen, HeartHandshake, Home,
  Link2, LoaderCircle, LogIn, LogOut, Menu, Mic, Plus, Share2, ShieldCheck,
  SlidersHorizontal, ArrowUp, ArrowDown, UserRound, Users, Video, VideoOff, X, Sun, Moon, MessageCircle,
  PictureInPicture2, Hand, Send, MonitorUp, MicOff, Maximize2, Minimize2, ChevronLeft, ChevronRight, Smile, ChevronDown, Download,
  MousePointer2, MoveUpRight, Eraser, Eye, EyeOff, PenLine, Undo2, Settings2,
  BookOpen, Smartphone, Headphones, LifeBuoy, Mail,
  Repeat, FileText, Bold, Italic, Underline, List, ListOrdered, Heading1, Heading2, IndentIncrease, IndentDecrease, Lightbulb,
} from "lucide-react";
import { api, ApiError, clearAuthToken, getRegisteredAuthToken, getGuestProfile, saveAuthToken, saveGuestAuthToken, type MeetingNotesPayload } from "./api";
import { AdminCenterPage, AudioRecordingPlayer, RecordingsPage } from "./ManagementPages";
import { clearCachePrefix, patchCache, readCache, removeCache, writeCache } from "./cache";
import type { JoinSession, Meeting, PrivateConversationSummary, PrivateMessage, User } from "./types";
import { GoogleContinueButton, ProfilePhoto, avatarColor, googleSignOut, hiResPhoto, preloadPhoto, preloadPhotoBriefly } from "./google";
import { RoomTipCard, useRoomTips, useWeakNetworkTip, type RoomTip } from "./RoomTips";

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
  logoutNow: () => void;
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
      if (document.visibilityState === "visible" || document.pictureInPictureElement) void api.sessionHeartbeat().catch(() => undefined);
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
    const root = document.documentElement;
    const next = root.dataset.theme === "light" ? "dark" : "light";
    // Paint the new theme immediately (before React re-renders) with transitions switched off for that frame, so nothing fades or lags.
    root.classList.add("theme-switching");
    root.dataset.theme = next;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = next === "light" ? "#fbf7f2" : "#130d10";
    const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]'); if (scheme) scheme.content = next;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => root.classList.remove("theme-switching")));
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Theme still applies for this session. */ }
    startTransition(() => setTheme(next));
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
    const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]'); if (scheme) scheme.content = theme;
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
    // Switching to a different account: drop the previous account's cached data so nothing of it shows for the new one.
    if (user && user.id !== nextUser.id) {
      removeCache("mine"); clearCachePrefix("meeting:"); clearCachePrefix("admin:"); clearCachePrefix("recordings:"); clearCachePrefix("notes:");
      setMeetings([]);
    }
    saveAuthToken(token);
    setUser(nextUser);
    writeCache("user", nextUser);
    setAuthOpen(false);
    void refreshMeetings(true);
  }, [refreshMeetings, user]);
  const performLogout = useCallback(() => {
    void api.logout().catch(() => undefined);
    googleSignOut();
    clearAuthToken();
    removeCache("user"); removeCache("mine"); clearCachePrefix("meeting:"); clearCachePrefix("admin:"); clearCachePrefix("recordings:"); clearCachePrefix("notes:");
    setUser(null);
    setMeetings([]);
    void refreshMeetings(true);
  }, [refreshMeetings]);
  // Every "Logout" button asks first; only "Yes, log out" really logs out.
  const [logoutAsk, setLogoutAsk] = useState(false);
  const signOut = useCallback(() => setLogoutAsk(true), []);

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
    user, meetings: liveMeetings, publicMeetings: livePublicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, logoutNow: performLogout, theme, toggleTheme,
  }), [user, liveMeetings, livePublicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, performLogout, theme, toggleTheme]);

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
      {logoutAsk && <ConfirmPrompt icon={<LogOut size={26}/>} title="Log out of your account?" message="You will need to log in again to host prayers or see your recordings. Guests can still join with a name." confirmLabel="Yes, log out" cancelLabel="No, stay logged in" onCancel={() => setLogoutAsk(false)} onConfirm={() => { setLogoutAsk(false); performLogout(); }}/>}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthenticated={completeAuth} currentName={user?.displayName} />}
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

/** Phone side menu: modern light/dark switch (the top bar has no theme button on phones). */
function SidebarThemeSwitch() {
  const { theme, toggleTheme } = useAppContext();
  const dark = theme === "dark";
  return (
    <button type="button" role="switch" aria-checked={dark} className={`sidebar-theme-switch ${dark ? "is-dark" : "is-light"}`} onClick={toggleTheme}>
      <span className="sidebar-theme-icon" aria-hidden="true">{dark ? <Moon size={18}/> : <Sun size={18}/>}</span>
      <span className="sidebar-theme-text"><b>{dark ? "Dark mode" : "Light mode"}</b><small>Switch to {dark ? "light" : "dark"}</small></span>
      <span className="sidebar-theme-track" aria-hidden="true"><span className="sidebar-theme-knob"/></span>
    </button>
  );
}

/** Top bar profile picture: opens a profile card (popover on desktop, bottom sheet on phones) with Change account and Logout. */
function ProfileMenu({ user, onSignOut, onChangeAccount }: { user: User; onSignOut: () => void; onChangeAccount: () => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const dragStart = useRef<number | null>(null);
  const dragFrame = useRef(0);
  const close = useCallback(() => { setOpen(false); dragStart.current = null; }, []);
  // While the sheet is open the page itself must not pull-to-refresh or scroll.
  useEffect(() => {
    if (!open) return;
    document.documentElement.classList.add("no-pull-refresh");
    return () => document.documentElement.classList.remove("no-pull-refresh");
  }, [open]);
  const onSheetPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (window.innerWidth > 720 || (event.target as HTMLElement).closest("button")) return;
    dragStart.current = event.clientY;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Optional. */ }
  };
  const onSheetPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragStart.current === null) return;
    const delta = Math.max(0, event.clientY - dragStart.current);
    const sheet = sheetRef.current;
    if (!sheet) return;
    window.cancelAnimationFrame(dragFrame.current);
    // Moves the sheet straight on the compositor: no React re-render while the finger is down.
    dragFrame.current = window.requestAnimationFrame(() => { sheet.style.animation = "none"; sheet.style.transition = "none"; sheet.style.transform = `translate3d(0, ${delta}px, 0)`; });
  };
  const onSheetPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragStart.current === null) return;
    const delta = Math.max(0, event.clientY - dragStart.current);
    dragStart.current = null;
    window.cancelAnimationFrame(dragFrame.current);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Optional. */ }
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.transition = "transform .14s ease-out";
    if (delta > 80) { sheet.style.transform = "translate3d(0, 100%, 0)"; window.setTimeout(close, 120); }
    else sheet.style.transform = "translate3d(0, 0, 0)";
  };
  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 10, right: Math.max(12, window.innerWidth - rect.right) });
    setOpen((value) => !value);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); };
  }, [open]);
  return <>
    <button ref={triggerRef} type="button" className={`profile-trigger ${open ? "profile-trigger-open" : ""}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open} aria-label="Open profile menu" title={user.displayName}>
      <ProfilePhoto className="profile-avatar" src={user.picture} name={user.displayName} />
      <span className="profile-name">{user.displayName}</span>
      <ChevronDown size={14} className="profile-chevron" aria-hidden="true"/>
    </button>
    {open && createPortal(
      <div className="profile-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <section ref={sheetRef} className="profile-sheet" role="dialog" aria-modal="true" aria-label="Profile" onPointerDown={onSheetPointerDown} onPointerMove={onSheetPointerMove} onPointerUp={onSheetPointerEnd} onPointerCancel={onSheetPointerEnd} style={anchor ? ({ "--profile-top": `${anchor.top}px`, "--profile-right": `${anchor.right}px` } as CSSProperties) : undefined}>
          <span className="profile-sheet-grab" aria-hidden="true"/>
          <button type="button" className="profile-sheet-close" onClick={close} aria-label="Close profile"><X size={16}/></button>
          <div className="profile-sheet-head">
            <ProfilePhoto className="profile-sheet-photo" src={user.picture} name={user.displayName} size={320}/>
            <b title={user.displayName}>{user.displayName}</b>
            {user.email && <small title={user.email}>{user.email}</small>}
          </div>
          <div className="profile-sheet-actions">
            <button type="button" className="profile-sheet-action" onClick={() => { close(); onChangeAccount(); }}><Users size={17}/><span>Change account</span></button>
            <button type="button" className="profile-sheet-action profile-sheet-danger" onClick={() => { close(); onSignOut(); }}><LogOut size={17}/><span>Logout</span></button>
          </div>
        </section>
      </div>, document.body)}
  </>;
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

const HELP_GUIDES: { id: string; icon: ReactNode; title: string; summary: string; steps: string[] }[] = [
  { id: "join", icon: <HeartHandshake size={18}/>, title: "Joining a prayer room", summary: "Enter a live or upcoming online prayer.", steps: [
    "Open Prayers from the sidebar (or the bottom bar on your phone) and find the prayer you want.",
    "Tap the card to open its details, then choose Join prayer. If the prayer has not started yet the room opens automatically at its scheduled time.",
    "Login with Google, or continue as a guest with your first and last name. Guest access only works for that one prayer.",
    "Choose whether your camera and microphone should be on, then tap Join. You can change both once you are inside the room.",
  ] },
  { id: "invite", icon: <Link2 size={18}/>, title: "Using an invitation link", summary: "Open a link someone shared with you.", steps: [
    "Tap or paste the invitation link in your browser. It opens the prayer page directly, no account is needed to look at it.",
    "Check the banner on the picture: Live now means you can enter, Upcoming means the room opens at the start time.",
    "Use Share invitation on the picture to pass the same link on to someone else.",
  ] },
  { id: "install", icon: <Smartphone size={18}/>, title: "Installing the app", summary: "Add MEET ENIHAKOLE to your phone or computer.", steps: [
    "Android and Chrome or Edge on a computer: tap the Install app button, then confirm Install.",
    "iPhone and iPad: open the site in Safari, tap the Share icon, then choose Add to Home Screen.",
    "Once installed, the app opens full screen from your home screen or desktop, just like any other app.",
    "If you do not see the Install app button, the app may already be installed or your browser does not support installing.",
  ] },
  { id: "recordings", icon: <Headphones size={18}/>, title: "Viewing recorded prayers", summary: "Listen back to finished prayers.", steps: [
    "Open Recorded prayers from the sidebar (or Recorded on your phone).",
    "Public prayer recordings and recordings from prayers you attended appear as cards once the prayer has finished and the audio is ready.",
    "Tap Listen on a card to play it. Use the timeline to skip around and the volume control to adjust the sound.",
    "Recordings are kept for a limited time, so each card shows when it expires. The list updates by itself when a new recording is ready.",
  ] },
  { id: "room", icon: <Video size={18}/>, title: "Inside the prayer room", summary: "Camera, microphone, chat and notes.", steps: [
    "Use the microphone and camera buttons at the bottom of the room to mute or unmute yourself at any time.",
    "Open chat to send messages, raise your hand to ask to speak, and use reactions to respond without interrupting.",
    "Meeting notes are saved for every prayer and meeting, and you can open them again later from the ended prayer page.",
    "Use the red leave button when you are done. You can rejoin while the prayer is still live.",
  ] },
  { id: "trouble", icon: <LifeBuoy size={18}/>, title: "Troubleshooting", summary: "Fix common audio, video and connection problems.", steps: [
    "No sound or no one can hear you: allow microphone access in your browser, then check the correct device is selected in the room settings.",
    "Camera not working: close other apps that may be using it and allow camera access for this site.",
    "Room will not load: check your internet connection, then refresh the page and join again.",
    "Still stuck? Ask the host to resend the invitation link, or contact the organizer of the prayer.",
  ] },
];

const HelpGuideRow = memo(function HelpGuideRow({ guide, open, onToggle }: { guide: (typeof HELP_GUIDES)[number]; open: boolean; onToggle: (id: string) => void }) {
  return (
    <section className={`help-guide ${open ? "help-guide-open" : ""}`}>
      <button type="button" className="help-guide-head" aria-expanded={open} onClick={() => onToggle(guide.id)}>
        <span className="help-guide-icon">{guide.icon}</span>
        <span className="help-guide-text"><b>{guide.title}</b><small>{guide.summary}</small></span>
        <ChevronDown size={17} className="help-guide-chevron"/>
      </button>
      {open && <ol className="help-steps">{guide.steps.map((step, index) => <li key={index}><span>{index + 1}</span><p>{step}</p></li>)}</ol>}
    </section>
  );
});

function HelpSupportModal({ onClose }: { onClose: () => void }) {
  const [openId, setOpenId] = useState<string>(HELP_GUIDES[0].id);
  const toggleGuide = useCallback((id: string) => setOpenId((current) => (current === id ? "" : id)), []);
  useBackClose(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previous; };
  }, [onClose]);
  return createPortal(
    <div className="help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="help-header">
          <span className="help-header-icon"><BookOpen size={21}/></span>
          <div><h2 id="help-title">Help &amp; support</h2><p>Quick guides to get the most out of MEET ENIHAKOLE.</p></div>
          <button type="button" className="icon-button help-close" onClick={onClose} aria-label="Close help"><X size={18}/></button>
        </header>
        <div className="help-body">
          <div className="help-quick">
            <Link to="/meetings" className="help-quick-card" onClick={onClose}><HeartHandshake size={18}/><span><b>Browse prayers</b><small>Join a live or upcoming prayer</small></span></Link>
            {RECORDING_UI_ENABLED && <Link to="/recordings" className="help-quick-card" onClick={onClose}><Headphones size={18}/><span><b>Recorded prayers</b><small>Listen back to finished prayers</small></span></Link>}
          </div>
          <p className="help-section-title">Step-by-step guides</p>
          <div className="help-guides">
            {HELP_GUIDES.map((guide) => <HelpGuideRow key={guide.id} guide={guide} open={openId === guide.id} onToggle={toggleGuide}/>)}
          </div>
          <div className="help-contact"><Mail size={17}/><p>Need more help? Contact the organizer who invited you, or the ENIHAKOLE team, and mention the prayer name and what you were trying to do.</p></div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AppShell({ children, mobileNavOpen, setMobileNavOpen }: { children: ReactNode; mobileNavOpen: boolean; setMobileNavOpen: (v: boolean) => void }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { user, openAuth, openSchedule, signOut } = useAppContext();
  const location = useLocation();
  const routeActive = location.pathname === "/meetings" ? "meetings" : location.pathname === "/recordings" ? "recordings" : location.pathname === "/admin" ? "admin" : "home";
  // The tapped link turns active on the spot (no gray in-between), then the route catches up.
  const [pendingActive, setPendingActive] = useState<string | null>(null);
  useEffect(() => { setPendingActive(null); }, [location.pathname]);
  const active = pendingActive ?? routeActive;
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
        <nav className="side-navigation" aria-label="Main navigation" onClick={(event) => { const link = (event.target as HTMLElement).closest(".side-link") as HTMLElement | null; if (link) { link.blur(); const target = link.getAttribute("data-nav"); if (target) setPendingActive(target); } }}>
          <Link data-nav="home" to="/" className={`side-link ${active === "home" ? "side-link-active" : ""}`}><Home size={18} /><span>Home</span></Link>
          <Link data-nav="meetings" to="/meetings" className={`side-link ${active === "meetings" ? "side-link-active" : ""}`}><HeartHandshake size={18} /><span>Prayers</span></Link>
          {RECORDING_UI_ENABLED && <Link data-nav="recordings" to="/recordings" className={`side-link ${active === "recordings" ? "side-link-active" : ""}`}><AudioLines size={18} /><span>Recorded prayers</span></Link>}
          {user?.isAdmin && <Link data-nav="admin" to="/admin" className={`side-link ${active === "admin" ? "side-link-active" : ""}`}><ShieldCheck size={18} /><span>Admin center</span></Link>}
        </nav>
        <div className="sidebar-bottom">
          <SidebarThemeSwitch />
          {user && <div className="sidebar-account"><ProfilePhoto className="sidebar-account-photo" src={user.picture} name={user.displayName} size={160}/><span><b title={user.displayName}>{user.displayName}</b><small title={user.email}>{user.email}</small></span><button type="button" className="sidebar-signout" onClick={() => { setMobileNavOpen(false); signOut(); }} title="Logout" aria-label="Logout"><LogOut size={16}/><span>Logout</span></button></div>}
          {!user && <div className="sidebar-signin-card"><span className="sidebar-signin-icon" aria-hidden="true"><LogIn size={18}/></span><span className="sidebar-signin-copy"><b>You're not logged in</b><small>Login to manage your prayers, recordings and profile.</small></span><button type="button" className="sidebar-signin-button" onClick={() => { setMobileNavOpen(false); openAuth(); }}><LogIn size={15}/><span>Login</span></button></div>}
          <button className="side-link quiet-link" onClick={() => { setMobileNavOpen(false); setHelpOpen(true); }}><CircleHelp size={18} /><span>Help & support</span></button>
          <div className="sidebar-version">MEET ENIHAKOLE <span>EARLY ACCESS</span></div>
        </div>
      </aside>
      <button type="button" className={`mobile-scrim ${mobileNavOpen ? "mobile-scrim-open" : ""}`} aria-label="Close navigation" aria-hidden={!mobileNavOpen} tabIndex={mobileNavOpen ? 0 : -1} onClick={() => setMobileNavOpen(false)} />
      <div className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>ENIHAKOLE CHOIR</span><span className="breadcrumb-slash">/</span><strong>{active === "meetings" ? "Prayers" : active === "recordings" ? "Recordings" : active === "admin" ? "System admin" : "Workspace"}</strong></div>
          <div className="topbar-actions">
            <ThemeToggle />
            {user ? (
              <div className="profile-menu">
                <ProfileMenu user={user} onSignOut={signOut} onChangeAccount={openAuth} />
              </div>
            ) : <button className="button button-soft button-small" onClick={openAuth}><LogIn size={16} /> Login</button>}
            {(user?.canCreateMeetings || user?.isAdmin) && <button className="button button-primary button-small topbar-create" onClick={() => openSchedule(false)}><Plus size={17} /> Create</button>}
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="page-footer"><span>© {new Date().getFullYear()} MEET ENIHAKOLE</span><span>Made for connection, prayer, and community</span></footer>
      </div>
      {helpOpen && <HelpSupportModal onClose={() => setHelpOpen(false)} />}
      <nav className={`mobile-bottom-nav mbn-${active} mbn-has-fab`} aria-label="Mobile navigation">
        <span className="mbn-bar" aria-hidden="true"/>
        <Link to="/" className={active === "home" ? "mobile-nav-active" : ""} aria-current={active === "home" ? "page" : undefined}><Home size={20}/><span>Home</span></Link>
        {(user?.canCreateMeetings || user?.isAdmin)
          ? <button type="button" className="mbn-fab" aria-label="Create meeting" onClick={() => openSchedule(false)}><Plus size={26} strokeWidth={2.4}/></button>
          : <Link to="/meetings" onClick={(event) => event.currentTarget.blur()} className={`mbn-fab mbn-fab-link ${active === "meetings" ? "mbn-fab-active" : ""}`} aria-label="Prayers" aria-current={active === "meetings" ? "page" : undefined}><HeartHandshake size={26} strokeWidth={2.4}/><span className="mbn-fab-label">Prayers</span></Link>}
        {(user?.canCreateMeetings || user?.isAdmin)
          ? <Link to="/meetings" className={active === "meetings" ? "mobile-nav-active" : ""} aria-current={active === "meetings" ? "page" : undefined}><HeartHandshake size={20}/><span>Prayers</span></Link>
          : <Link to="/recordings" className={active === "recordings" ? "mobile-nav-active" : ""} aria-current={active === "recordings" ? "page" : undefined}><AudioLines size={20}/><span>Recorded</span></Link>}
      </nav>
    </div>
  );
}

function Dashboard() {
  const { user, meetings, publicMeetings, loadingMeetings } = useAppContext();
  const navigate = useNavigate();
  const upcoming = [...meetings, ...publicMeetings]
    .filter((meeting) => meeting.meetingType === "prayer")
    .filter((meeting, index, array) => array.findIndex((other) => other.slug === meeting.slug) === index)
    .filter((meeting) => meeting.status === "scheduled" || meeting.status === "live")
    // Live prayers always come first, then the soonest scheduled ones.
    .sort((a, b) => (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) || new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const liveCount = upcoming.filter((meeting) => meeting.status === "live").length;
  const upcomingCount = upcoming.length - liveCount;

  return (
    <div className="dashboard-page page-enter">
      <section className="welcome-row">
        <div className="welcome-copy">
          {(() => { const text = user ? `Welcome back, ${user.displayName.split(" ")[0]}.` : "Gather in faith. Wherever you are."; return <h1 title={text} style={{ "--welcome-chars": Array.from(text).length } as CSSProperties}>{text}</h1>; })()}
        </div>
        <div className="welcome-decoration" aria-hidden="true"><span className="decor-ring decor-ring-one"/><span className="decor-ring decor-ring-two"/><span className="decor-center"><AudioLines size={36}/></span><span className="decor-star decor-star-one">✦</span><span className="decor-star decor-star-two">✧</span></div>
      </section>

      <section className="hero-panel">
        <div className="hero-shimmer" aria-hidden="true" />
        <div className="hero-copy">
          <h2>Join room for<br /><em>what matters.</em></h2>
          <p>No complicated setup — just open your link and be there.</p>
          <div className="hero-actions">
            <Link className="button button-cream" to="/meetings"><HeartHandshake size={17}/> Go to Prayers <ArrowRight size={16}/></Link>
            <Link className="hero-secondary" to="/recordings"><AudioLines size={17}/> Recorded Prayers</Link>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-window"><div className="art-window-top"><span/><span/><span/><i>ENIHAKOLE · PRAYER ROOM</i></div><div className="art-video-grid">{[["GM", "Grace M.", "one", true], ["DK", "David K.", "two", false], ["AU", "Aline U.", "three", false], ["EN", "Eric N.", "four", false]].map(([initials, name, tone, host]) => <span key={String(tone)} className={`art-person art-person-${tone}`}>{host && <em className="art-person-host">HOST</em>}<span className="art-avatar"><b>{initials}</b></span><span className="art-person-name"><b>{name}</b></span>{tone === "three" && <span className="art-person-mic"><MicOff size={9}/></span>}</span>)}</div><div className="art-controls"><span><RdMicIcon/></span><span><RdCameraIcon/></span><span className="art-end"><RdHangupIcon/></span></div></div>
          <div className="art-note"><span className="art-note-icon"><HeartHandshake size={17}/></span><span><b>All together</b><small>One room. Many voices.</small></span><CheckCircle2 size={17} className="art-note-check"/></div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><p className="section-overline">YOUR SPACE</p><h2>At a glance</h2></div><button className="text-action" onClick={() => navigate("/meetings")}>View prayers <ArrowRight size={15}/></button></div>
        <div className="stats-grid">
          <div className="stat-card"><span className="stat-icon stat-burgundy"><CalendarDays size={19}/></span><div><span className="stat-label">Upcoming Prayers</span><strong>{loadingMeetings ? "—" : String(upcomingCount).padStart(2, "0")}</strong></div><button type="button" className="stat-continue" onClick={() => navigate("/meetings")} aria-label="Continue to Upcoming Prayers">Continue<ArrowRight size={14}/></button><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-gold"><Video size={19}/></span><div><span className="stat-label">Live right now</span><strong>{loadingMeetings ? "—" : String(liveCount).padStart(2, "0")}</strong>{liveCount > 0 && <small>Join the prayer</small>}</div><button type="button" className="stat-continue" onClick={() => navigate("/meetings")} aria-label="Continue to live prayers">Continue<ArrowRight size={14}/></button><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-rose"><Users size={19}/></span><div><span className="stat-label">Your community</span><strong>ENIHAKOLE</strong></div><span className="stat-sheen"/></div>
        </div>
      </section>
    </div>
  );
}

function MeetingCardSkeleton() {
  return (
    <article className="meeting-card meeting-card-skeleton" aria-hidden="true">
      <div className="meeting-cover"><span className="meet-skel meet-skel-cover"/></div>
      <div className="meeting-card-body">
        <span className="meet-skel meet-skel-line meet-skel-date"/>
        <span className="meet-skel meet-skel-title"/>
        <span className="meet-skel meet-skel-line"/>
        <span className="meet-skel meet-skel-line meet-skel-short"/>
        <div className="meeting-card-bottom"><span className="meet-skel meet-skel-chip"/><span className="meet-skel meet-skel-button"/></div>
      </div>
    </article>
  );
}

function MeetingCard({ meeting, priority = false }: { meeting: Meeting; priority?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const shareUrl = `${window.location.origin}/share/${encodeURIComponent(meeting.slug)}`;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Copy this invitation from the prayer details page." } }));
    }
  }
  return (
    <article className="meeting-card">
      <Link to={`/meeting/${meeting.slug}`} className="meeting-cover">
        {!coverLoaded && <span className="meet-skel meet-skel-cover meet-skel-cover-fill" aria-hidden="true"/>}<img className={`meeting-cover-img ${coverLoaded ? "is-loaded" : ""}`} src={meetingImage(meeting)} alt="" loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : "auto"} draggable={false} onLoad={() => setCoverLoaded(true)} onError={() => setCoverLoaded(true)} ref={(node) => { if (node?.complete && !coverLoaded) setCoverLoaded(true); }}/>
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
  // Everything the person can see: their own meetings plus every public prayer, without duplicates.
  const visible = [...(user ? meetings : []), ...publicMeetings].filter((meeting) => meeting.meetingType === "prayer").filter((meeting, index, array) => array.findIndex((other) => other.slug === meeting.slug) === index);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">(() => {
    const requested = new URLSearchParams(window.location.search).get("filter");
    return requested === "past" || requested === "all" ? requested : "upcoming";
  });
  // Newest created prayers first by default, in every tab.
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterOpen, setFilterOpen] = useState(false);
  const filtersActive = sortDir !== "desc";
  const list = visible.filter((meeting) => {
    if (filter === "upcoming") return meeting.status === "scheduled" || meeting.status === "live";
    if (filter === "past") return meeting.status === "ended" || meeting.status === "cancelled";
    return true;
  }).sort((a, b) => {
    const stamp = (m: Meeting) => new Date(m.createdAt || m.startsAt).getTime() || 0;
    // In Upcoming, prayers that are live right now are listed first.
    if (filter === "upcoming" && (a.status === "live") !== (b.status === "live")) return a.status === "live" ? -1 : 1;
    return (stamp(a) - stamp(b)) * (sortDir === "asc" ? 1 : -1);
  });
  // Switching between Upcoming / Past / All briefly shows the loading cards before the list appears.
  const [filtering, setFiltering] = useState(false);
  const filterTimer = useRef<number | undefined>(undefined);
  function changeFilter(value: "upcoming" | "past" | "all") {
    if (value === filter) return;
    setFilter(value);
    setFiltering(true);
    window.clearTimeout(filterTimer.current);
    filterTimer.current = window.setTimeout(() => setFiltering(false), 260);
  }
  useEffect(() => () => window.clearTimeout(filterTimer.current), []);
  useEffect(() => { void refreshMeetings(); }, [refreshMeetings]);
  const showSkeleton = loadingMeetings || filtering;
  return (
    <div className="meetings-page page-enter">
      <div className="page-title-row"><div><h1>Prayers</h1></div>{(user?.canCreateMeetings || user?.isAdmin) && <button className="button button-primary" onClick={() => openSchedule(false)}><Plus size={17}/> Create a prayer</button>}</div>
      <div className="filter-bar"><div className="segmented-filter">{(["upcoming", "past", "all"] as const).map((value) => <button key={value} className={filter === value ? "filter-active" : ""} onClick={() => changeFilter(value)}>{value === "upcoming" ? "Upcoming" : value === "past" ? "Past prayers" : "All prayers"}</button>)}</div><button type="button" className={`filter-open-button ${filtersActive ? "filter-open-active" : ""}`} onClick={() => setFilterOpen(true)} aria-haspopup="dialog"><SlidersHorizontal size={15}/><span>Filter</span>{filtersActive && <i aria-hidden="true"/>}</button></div>
      <div className="meeting-count meeting-count-line">{showSkeleton ? "Loading…" : `${list.length} ${list.length === 1 ? "prayer" : "prayers"}`}</div>
      {filterOpen && <PrayerFilterModal sortDir={sortDir} onClose={() => setFilterOpen(false)} onApply={(next) => { setSortDir(next.sortDir); setFilterOpen(false); }}/>}
      {showSkeleton ? <div className="meeting-card-grid" aria-busy="true" aria-label="Loading prayers">{Array.from({ length: 6 }, (_, index) => <MeetingCardSkeleton key={index}/>)}</div> : list.length ? <div className="meeting-card-grid">{list.map((meeting, index) => <MeetingCard key={meeting.slug} meeting={meeting} priority={index < 6}/>)}</div> : <div className="empty-state empty-large"><div className="empty-icon"><CalendarDays size={23}/></div><div><h3>{filter === "past" ? "No past prayers yet" : "A fresh page for your next prayer"}</h3><p>Online Prayers will appear here when they are scheduled.</p></div><Link className="button button-primary" to="/recordings"><AudioLines size={16}/> Recorded Prayers</Link></div>}
    </div>
  );
}

/** "Filter" on the Prayers page: sort by date (ascending / descending). */
function PrayerFilterModal({ sortDir, onClose, onApply }: { sortDir: "asc" | "desc"; onClose: () => void; onApply: (next: { sortDir: "asc" | "desc" }) => void }) {
  const [dir, setDir] = useState(sortDir);
  return createPortal(
    <Modal onClose={onClose}>
      <div className="auth-modal-content prayer-filter-content">
        <span className="modal-brand-icon"><SlidersHorizontal size={22}/></span>
        <p className="section-overline">FILTER PRAYERS</p>
        <h2>Sort prayers</h2>
        <div className="prayer-filter-group" role="radiogroup" aria-label="Sort by date">
          <div className="prayer-filter-choices">
            <button type="button" role="radio" aria-checked={dir === "asc"} className={dir === "asc" ? "is-selected" : ""} onClick={() => setDir("asc")}><ArrowUp size={15}/> Ascending<small>Oldest first</small></button>
            <button type="button" role="radio" aria-checked={dir === "desc"} className={dir === "desc" ? "is-selected" : ""} onClick={() => setDir("desc")}><ArrowDown size={15}/> Descending<small>Newest first</small></button>
          </div>
        </div>
        <div className="prayer-filter-actions">
          <button type="button" className="button button-soft" onClick={() => setDir("desc")}>Reset</button>
          <button type="button" className="button button-primary" onClick={() => onApply({ sortDir: dir })}>Apply</button>
        </div>
      </div>
    </Modal>,
    document.body,
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
  const { user, meetings: knownMeetings, publicMeetings: knownPublic, openAuth, completeAuth, logoutNow } = useAppContext();
  const cacheKey = `meeting:${user?.id ?? "guest"}:${slug}`;
  const [meeting, setMeeting] = useState<Meeting | null>(() => readCache<Meeting>(cacheKey)?.value ?? [...knownMeetings, ...knownPublic].find((item) => item.slug === slug) ?? null);
  const [cameraOn, setCameraOn] = useState(false);
  const [guestName, setGuestName] = useState(() => getGuestProfile(slug)?.displayName || "");
  const [guestModalOpen, setGuestModalOpen] = useState(false);
  const [identityChoiceOpen, setIdentityChoiceOpen] = useState(false);
  const [switchProfileOpen, setSwitchProfileOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [loading, setLoading] = useState(() => !readCache(cacheKey) && ![...knownMeetings, ...knownPublic].some((item) => item.slug === slug));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [mediaPrompt, setMediaPrompt] = useState<{ kind: MediaKind; state: MicPromptState } | null>(null);
  const [pastNotesOpen, setPastNotesOpen] = useState(false);
  useBackClose(pastNotesOpen, () => setPastNotesOpen(false));
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
    // After logging in the cache key changes; keep showing the invitation we already have (no loading screen, no flash) and refresh it quietly.
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

  // While a session is still scheduled, quietly watch for the host starting it early so waiting people see the Join button right away.
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
  useEffect(() => { if (user) { setIdentityChoiceOpen(false); setError((current) => current === IDENTITY_NEEDED_MESSAGE ? "" : current); } }, [user]);
  useEffect(() => {
    const tick = window.setInterval(() => setClockNow(Date.now() + serverClockOffsetRef.current), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // An ended prayer or meeting may have a synchronized audio-only recording. The invitation
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
          setPastRecordingError(`No completed audio recording is available for this ${kindOf(meeting)}.`);
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
    if (!user && !getGuestProfile(slug)) { setError(""); setIdentityChoiceOpen(true); return; }
    if (joining || mediaPrompt) return;
    await continueJoin(micOn, cameraOn);
  }

  async function enterRoom(audio: boolean, video: boolean) {
    if (!meeting || (!user && !getGuestProfile(slug)) || enteringRef.current) return;
    if (!meeting.isOwner && meeting.status === "scheduled" && Date.now() + serverClockOffsetRef.current < new Date(meeting.startsAt).getTime()) {
      setError(`Not Yet Open. This ${kindOf(meeting)} becomes available at its scheduled start time.`);
      return;
    }
    if (activeRoomSlugInApp) {
      if (activeRoomSlugInApp === slug) navigate(`/room/${encodeURIComponent(slug)}`, { replace: true });
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
      navigate(`/room/${encodeURIComponent(slug)}`, { replace: true });
    } catch (cause) {
      setMediaPrompt(null);
      setError(cause instanceof Error ? cause.message : "Could not join this meeting.");
    } finally { enteringRef.current = false; setJoining(false); }
  }

  /** Saves the guest's name for this meeting. The guest then stays visible on this screen and joins with the normal Join button. */
  async function saveGuest(displayName: string) {
    if (!meeting) return;
    setError("");
    const result = await api.guestSession(slug, displayName);
    // Switching from a Google account to a guest: the old account is only left once the guest session really exists.
    if (user) logoutNow();
    saveGuestAuthToken(result.token, { guestId: result.guestId, displayName: result.displayName, meetingSlug: slug });
    setGuestName(result.displayName);
    setError((current) => current === IDENTITY_NEEDED_MESSAGE ? "" : current);
    setGuestModalOpen(false);
  }

  async function googleCredential(credential: string): Promise<boolean> {
    setError("");
    try {
      const result = await api.googleSignIn(credential);
      // Have the profile photo ready first so the logged-in state appears instantly, with no spinner and no page reload.
      await preloadPhotoBriefly(result.user.picture, 512, 1200);
      completeAuth(result.user, result.token);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not log in with Google.");
      return false;
    }
  }

  async function share() {
    const url = `${window.location.origin}/share/${encodeURIComponent(slug)}`;
    try {
      if (navigator.share) await navigator.share({ title: meeting?.title || "MEET ENIHAKOLE", text: `Join our online ${kindOf(meeting)}.`, url });
      else { await navigator.clipboard.writeText(url); window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Invitation link copied." } })); }
    } catch { /* Share sheet dismissed. */ }
  }

  if (loading) return <StandaloneLoading label="Opening your invitation…"/>;
  if (!meeting) return <StandaloneError message={error || "This meeting could not be found."}/>;
  const ended = meeting.status === "ended" || meeting.status === "cancelled";
  const kind = kindOf(meeting);
  const opensAt = new Date(meeting.startsAt).getTime();
  // The host may always start their own session early; everyone else waits for the scheduled time.
  const notYetOpen = !meeting.isOwner && meeting.status === "scheduled" && Number.isFinite(opensAt) && clockNow < opensAt;

  return (
    <div className="meeting-landing">
      <header className="landing-topbar"><Link className="brand-lockup" to="/"><span className="brand-mark"><AudioLines size={22}/></span><span className="brand-words"><strong>MEET</strong><b>ENIHAKOLE</b><small>GATHER IN FAITH</small></span></Link><div className="landing-topbar-actions"><ThemeToggle/><InstallPwaButton inline/></div></header>
      <main className="landing-layout">
        <section className="join-panel">
          <div className="join-cover join-cover-thumb"><img className="join-cover-img" src={meetingImage(meeting)} alt={meeting.title} decoding="async" fetchPriority="high" draggable={false}/><div className="thumb-corner"><span className={`meeting-status thumb-status ${meeting.status === "live" ? "meeting-status-live" : ""}`}><span/>{getMeetingStateLabel(meeting)}</span><button type="button" className="thumb-share-button" onClick={share} aria-label="Share invitation"><Share2 size={15}/><span>Share invitation</span></button></div></div>
          <form className="join-form" onSubmit={join}>
            <div className="join-form-heading"><h2>{ended ? `This ${kind} has ended` : notYetOpen ? "Not Yet Open" : meeting.status === "live" ? `Join the ${kind}` : meeting.isOwner ? `Your ${kind} is ready` : "You're in the right place"}</h2><p>{ended ? "This invitation is now closed. Available audio and notes are below." : notYetOpen ? `This ${kind} opens at ${formatTime(meeting.startsAt, meeting.timezone)}. Please check again when it becomes available.` : meeting.status === "live" ? "Enter your details and come on in." : "The room becomes available automatically at its scheduled start time."}</p></div>
            {user && !ended && <div className="join-identity"><ProfilePhoto src={user.picture} name={user.displayName} className="join-identity-photo"/><span><b>{user.displayName}</b><small>{user.email}</small></span><button type="button" className="error-link" onClick={() => { setError(""); setSwitchProfileOpen(true); }}><Repeat size={12}/> Switch profile</button>{switchProfileOpen && createPortal(<SwitchProfileModal user={user} error={error} onClose={() => { setSwitchProfileOpen(false); setError(""); }} onGoogleCredential={async (credential) => { if (await googleCredential(credential)) setSwitchProfileOpen(false); }} onGuest={() => { setSwitchProfileOpen(false); setGuestModalOpen(true); }}/>, document.body)}{guestModalOpen && createPortal(<GuestNameModal initialName={guestName} onClose={() => setGuestModalOpen(false)} onSave={saveGuest}/>, document.body)}</div>}
            {!user && !ended && <div className="join-google"><GoogleContinueButton oneTap onCredential={(credential) => void googleCredential(credential)}/><div className="guest-access-form"><div className="guest-access-divider"><span>OR</span></div>{guestModalOpen && createPortal(<GuestNameModal initialName={getGuestProfile(slug)?.displayName || guestName} onClose={() => setGuestModalOpen(false)} onSave={saveGuest}/>, document.body)}{identityChoiceOpen && !user && createPortal(<JoinIdentityModal onClose={() => setIdentityChoiceOpen(false)} onGoogleCredential={async (credential) => { await googleCredential(credential); }} onGuest={() => { setIdentityChoiceOpen(false); setGuestModalOpen(true); }}/>, document.body)}{getGuestProfile(slug) ? <div className="join-identity guest-identity"><ProfilePhoto name={getGuestProfile(slug)?.displayName || guestName} className="join-identity-photo"/><span><b>{getGuestProfile(slug)?.displayName}</b><small>Temporary guest · this meeting only</small></span><button type="button" className="guest-change-name" onClick={() => setGuestModalOpen(true)}>Change</button></div> : <button type="button" className="guest-continue-button" onClick={() => setGuestModalOpen(true)}><UserRound size={18}/><span>Continue as Guest</span></button>}</div></div>}
            {!ended && <div className="join-preferences"><MediaToggle on={cameraOn} onChange={setCameraOn} onIcon={<Video size={16}/>} offIcon={<VideoOff size={16}/>} onLabel="Camera is on" offLabel="Camera is off" onHint="Join with video" offHint="Join without video"/><MediaToggle on={micOn} onChange={setMicOn} onIcon={<Mic size={16}/>} offIcon={<MicOff size={16}/>} onLabel="Microphone is on" offLabel="Microphone is off" onHint="Join with audio" offHint="Join muted"/></div>}
            {error && <div className="inline-error" role="alert">{error}{error.includes("Login") && <button type="button" className="error-link" onClick={openAuth}>Login</button>}</div>}
            {ended ? <div className="meeting-ended-actions"><Link to="/meetings" className="button button-soft button-full"><ArrowLeft size={16}/> {meeting.meetingType === "prayer" ? "Back to prayers" : "Back to meetings"}</Link>{(meeting.isOwner || meeting.isParticipant) && <button type="button" className="button button-primary button-full" onClick={() => setPastNotesOpen(true)}><FileText size={16}/> View meeting notes</button>}{pastRecording && <section className="meeting-ended-audio"><div><AudioLines size={20}/><span><b>Audio recording</b><small>{pastRecording.recording.meetingTitle}</small></span></div><AudioRecordingPlayer src={pastRecording.playbackUrl} title={pastRecording.recording.meetingTitle}/><small>Available until {formatDate(pastRecording.expiresAt)}</small></section>}{pastRecordingError && !pastRecordingLoading && !pastRecording && <p className="meeting-audio-unavailable">{pastRecordingError}</p>}</div> : <><button className={`button button-primary button-full join-submit ${notYetOpen ? "join-submit-locked" : ""}`} type="submit" disabled={joining || notYetOpen}>{joining ? <LoaderCircle size={17} className="spin"/> : notYetOpen ? <Clock3 size={17}/> : meeting.isOwner ? <Video size={17}/> : <DoorOpen size={17}/>} {joining ? "Joining…" : notYetOpen ? "Not Yet Open" : meeting.status === "scheduled" ? `Open ${kind}` : `Join ${kind}`}<ArrowRight size={16}/></button>{notYetOpen && <div className="meeting-not-yet-open" role="status"><Clock3 size={16}/><span><b>Opens {formatDate(meeting.startsAt, { weekday: "short" }, meeting.timezone)}</b><small>{formatTime(meeting.startsAt, meeting.timezone)} · {meeting.timezone || "Scheduled time"}</small></span></div>}</>}
            <p className="join-footnote"><ShieldCheck size={13}/> Your camera and microphone are only requested when you enter the room.</p>
          </form>
        </section>
        <section className="landing-details">
          <p className="eyebrow"><span className={`eyebrow-dot ${meeting.status === "live" ? "eyebrow-dot-live" : ""}`}/>{meeting.status === "live" ? `THE ${kind.toUpperCase()} IS LIVE` : ended ? `${kind.toUpperCase()} CLOSED` : "YOU'RE INVITED"}</p>
          <h1>{meeting.title}</h1>
          <p className="landing-description">{meeting.description || "Join ENIHAKOLE CHOIR for a time to pray, connect, and lift our voices together."}</p>
          <div className="host-row"><span className="host-avatar"><AudioLines size={19}/></span><div><small>HOSTED BY</small><strong>{meeting.ownerName}</strong></div><span className="verified-host"><ShieldCheck size={14}/> Host</span></div>
          <div className="meeting-detail-list"><div><span className="detail-icon"><CalendarDays size={18}/></span><span><b>{formatDate(meeting.startsAt, { weekday: "long", year: "numeric" }, meeting.timezone)}</b><small>{formatTime(meeting.startsAt, meeting.timezone)} · {meeting.timezone || "Meeting time"}</small></span></div><div><span className="detail-icon"><Clock3 size={18}/></span><span><b>{meeting.durationMinutes} minutes</b><small>Planned {kind} time</small></span></div><div><span className="detail-icon"><Users size={18}/></span><span><b>Join from anywhere</b><small>Phone, tablet, or computer</small></span></div></div>
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
  useBackClose(true, onClose);
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
  const [confirmLeave, setConfirmLeave] = useState(false);
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
    // The room entry is replaced by the meeting page, so Back from there goes to the page before the meeting page.
    unwindDialogHistory(() => {
      window.dispatchEvent(new CustomEvent("meet-room-closed", { detail: { slug } }));
      navigate(`/meeting/${encodeURIComponent(slug)}`, { replace: true });
    });
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
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
      // The host removed this person: leave the call completely and explain it with a tip toast, never a top banner.
      sessionStorage.removeItem(`meet-session:${slug}`);
      preparedRooms.delete(slug);
      setConfirmLeave(false); setConfirmEnd(false);
      unwindDialogHistory(() => {
        window.dispatchEvent(new CustomEvent("meet-room-closed", { detail: { slug } }));
        navigate(`/meeting/${encodeURIComponent(slug)}`, { replace: true });
        window.dispatchEvent(new CustomEvent("meet-tip", { detail: { message: "The host removed you from this meeting, so you are no longer in the call.", tone: "removed" } }));
      });
      return;
    }
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
      {!isActive && <BackgroundMeetingDock title={session.meeting.title} disconnected={disconnected} onReturn={() => navigate(`/room/${encodeURIComponent(slug)}`)} onLeave={() => setConfirmLeave(true)}/>}
      <div className={`conference-page ${!isActive ? "conference-page-audio-host" : ""}`} aria-hidden={!isActive}>
        {endError && <div className="room-alert" role="alert">{endError}</div>}
        {disconnected && <div className="room-alert" role="status">You have disconnected from the call. <button onClick={leaveRoom}>Return to meeting</button></div>}
        <main className="conference-main">
          <div className="conference-stage">
            <ConferenceWorkspace meeting={session.meeting} role={session.role} onLeave={leaveRoom} onLeaveClick={() => setConfirmLeave(true)} onEndForEveryone={() => endForEveryone()} ending={ending} isActive={isActive}/>
            {!preparedRoom && <RoomReadyOverlay expected={(session.participants ?? []).map((person) => person.identity)}/>}
          </div>
          {confirmLeave && <ConfirmPrompt icon={<DoorOpen size={26}/>} title="Leave the room?" message="You will leave the call now. You can join again any time while the room is open." confirmLabel="Yes, leave room" cancelLabel="No, stay in the room" onCancel={() => setConfirmLeave(false)} onConfirm={() => { setConfirmLeave(false); leaveRoom(); }}/>}
          {confirmEnd && <ConfirmEndModal busy={ending} onCancel={() => setConfirmEnd(false)} onConfirm={() => void confirmEndForEveryone()}/>}
        </main>
      </div>
    </LiveKitRoom>
  );
}

function BackgroundMeetingDock({ title, disconnected, onReturn, onLeave }: { title: string; disconnected: boolean; onReturn: () => void; onLeave: () => void }) {
  const { pathname } = useLocation();
  const aboveNav = pathname === "/" || pathname === "/meetings" || pathname === "/recordings" || pathname === "/admin";
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
  return <aside className={`background-meeting-dock ${aboveNav ? "background-meeting-dock-above-nav" : ""}`} role="region" aria-label="Active meeting controls">
    <span className="background-meeting-indicator" aria-hidden="true"/>
    <div className="background-meeting-copy"><strong>{disconnected ? "Connection interrupted" : "Meeting continues"}</strong><span>{title} · {participants.length} participants</span></div>
    <button type="button" className="background-meeting-action" onClick={() => void toggleMicrophone()} disabled={micBusy} aria-label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"} title={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}>{isMicrophoneEnabled ? <Mic size={16}/> : <MicOff size={16}/>}</button>
    <button type="button" className="background-meeting-return" onClick={onReturn}>Return to call</button>
    <button type="button" className="background-meeting-leave" onClick={onLeave}>Leave</button>
  </aside>;
}


/** Our own confirmation for ending a meeting. It is drawn inside the fullscreen room when the room is fullscreen, so it is always visible. */
function ConfirmEndModal({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useBackClose(true, () => { if (!busy) onCancel(); });
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

/** Yes/No confirmation used for logging out and leaving the room. Centered card on desktop, bottom sheet on phones. */
function ConfirmPrompt({ icon, title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: { icon: ReactNode; title: string; message: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }) {
  useBackClose(true, onCancel);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const host = document.fullscreenElement ?? document.querySelector(".conference-fullscreen-target.is-pseudo-fullscreen") ?? document.body;
  return createPortal(
    <div className="modal-backdrop confirm-prompt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal-panel modal-panel-narrow confirm-end-panel confirm-prompt-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-prompt-title" aria-describedby="confirm-prompt-text">
        <div className="confirm-end-icon" aria-hidden="true">{icon}</div>
        <h2 id="confirm-prompt-title">{title}</h2>
        <p id="confirm-prompt-text">{message}</p>
        <div className="confirm-end-actions">
          <button type="button" className="button button-soft" onClick={onCancel} autoFocus>{cancelLabel}</button>
          <button type="button" className="button button-danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>,
    host,
  );
}

/** Shown to everyone the moment the meeting is ended. */
/** Removes every dialog/guard history entry in one jump, then runs `then` (used when leaving the room so Back never returns into it). */
function unwindDialogHistory(then: () => void) {
  const count = backCloseStack.length;
  backCloseStack.length = 0;
  if (count === 0) { then(); return; }
  pendingBacks += 1;
  afterBack.push(then);
  window.history.go(-count);
  // If the browser never reports the jump, continue anyway.
  window.setTimeout(() => { if (afterBack.includes(then)) { pendingBacks = 0; afterBack.splice(0).forEach((run) => run()); } }, 1200);
}

/** Phone/browser Back closes the open dialog instead of leaving the page. Opening pushes one history entry; closing by any means removes it again. */
const backCloseStack: string[] = [];
// When one dialog closes and another opens in the same moment, the new entry waits until the old one has finished going back.
let pendingBacks = 0;
const afterBack: Array<() => void> = [];
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (pendingBacks <= 0) return;
    pendingBacks -= 1;
    if (pendingBacks === 0) window.setTimeout(() => afterBack.splice(0).forEach((run) => run()), 0);
  });
}
function useBackClose(active: boolean, onClose: () => void, keep = false) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let pushed = false;
    let cancelled = false;
    const isOurs = () => (window.history.state as { __modal?: string } | null)?.__modal === id;
    const onPop = () => {
      // Only the top-most dialog reacts, and only once its own history entry has been popped.
      if (!pushed || backCloseStack[backCloseStack.length - 1] !== id || isOurs()) return;
      backCloseStack.pop(); pushed = false;
      closeRef.current();
      // A guard (the room) puts its entry back, so every further Back press is caught the same way.
      if (keep) window.setTimeout(() => { if (!cancelled && !pushed) push(); }, 0);
    };
    // Deferred by a tick so React StrictMode's immediate re-mount does not leave a stray entry.
    const push = () => {
      if (cancelled) return;
      try { window.history.pushState({ ...(window.history.state || {}), __modal: id }, ""); backCloseStack.push(id); pushed = true; } catch { /* History unavailable: Back simply behaves as before. */ }
    };
    const timer = window.setTimeout(() => { if (pendingBacks > 0) afterBack.push(push); else push(); }, 0);
    window.addEventListener("popstate", onPop);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPop);
      if (!pushed) return;
      const index = backCloseStack.lastIndexOf(id);
      if (index < 0) return;
      const wasTop = index === backCloseStack.length - 1;
      if (index >= 0) backCloseStack.splice(index, 1);
      // Closed with a button or by tapping outside: remove the extra entry so Back goes to the real previous page.
      if (wasTop && isOurs()) { pendingBacks += 1; window.history.back(); }
    };
  }, [active]);
}

/** "prayer" or "meeting", so wording always follows the type of the session. */
const kindOf = (item?: { meetingType?: string } | null) => (item?.meetingType === "prayer" ? "prayer" : "meeting");
const IDENTITY_NEEDED_MESSAGE = "Choose Google or Guest to continue.";

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
      <p className="eyebrow"><span className="eyebrow-dot"/> {/prayer/i.test(destinationLabel) ? "PRAYER" : "MEETING"} CLOSED</p>
      <h1>This {/prayer/i.test(destinationLabel) ? "prayer" : "meeting"} has ended</h1>
      {title && <p className="meeting-ended-title">{title}</p>}
      <p className="meeting-ended-text">{isHost ? `You ended this ${/prayer/i.test(destinationLabel) ? "prayer" : "meeting"} for everyone. Thank you for hosting.` : `The host has ended this ${/prayer/i.test(destinationLabel) ? "prayer" : "meeting"} for everyone. Thank you for joining.`}</p>
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
type FloatingReaction = { id: string; emoji: string; name: string; x: number; rise: number; scale: number; animated: boolean };
type DirectContact = { userId: string; identity: string; name: string; picture: string };
type PrivateDataSignal =
  | { kind: "private-message"; recipientUserId: string; message: PrivateMessage }
  | { kind: "moderator-request"; recipientUserId: string; media: "microphone" | "camera"; hostName: string }
  | { kind: "moderator-media-control"; recipientUserId: string; media: "microphone" | "camera"; action: "disable"; hostName: string };
const REACTION_LIFETIME = 3400;
const PRIVATE_MESSAGE_TOPIC = "meet-enihakole-private";
/** Reactions use a fixed horizontal launch point and a vertical-only travel distance. */
function makeReaction(id: string, emoji: string, name: string): FloatingReaction {
  return { id, emoji, name, x: 12 + Math.random() * 76, rise: 65, scale: 0.92 + Math.random() * 0.16, animated: true };
}
/** Animated Noto emoji (the same set Google Meet uses). Falls back to the native emoji if an image cannot load. */
const ANIMATED_EMOJI_CODE: Record<string, string> = { "🙏": "1f64f", "❤️": "2764_fe0f", "👏": "1f44f", "🙌": "1f64c", "😊": "1f60a", "🎉": "1f389", "✨": "2728", "💛": "1f49b", "🕊️": "1f54a_fe0f", "👍": "1f44d", "😂": "1f602", "🔥": "1f525", "😍": "1f60d", "🤗": "1f917", "🥳": "1f973", "💪": "1f4aa", "🤝": "1f91d", "😮": "1f62e", "😢": "1f622", "💯": "1f4af" };
const animatedEmojiUrl = (emoji: string) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${ANIMATED_EMOJI_CODE[emoji] || "1f64f"}/512.webp`;
const failedAnimatedEmoji = new Set<string>();
const loadedAnimatedEmoji = new Set<string>();
const emojiLoading = new Map<string, Promise<boolean>>();
/** Resolves true once the animated image is downloaded AND decoded, false if it failed or took too long (the native glyph, which is always instant, is used then). */
function waitForEmoji(emoji: string, timeoutMs = 2500): Promise<boolean> {
  if (loadedAnimatedEmoji.has(emoji)) return Promise.resolve(true);
  if (failedAnimatedEmoji.has(emoji) || !ANIMATED_EMOJI_CODE[emoji]) return Promise.resolve(false);
  let load = emojiLoading.get(emoji);
  if (!load) {
    load = new Promise<boolean>((resolve) => {
      const img = new Image(); img.decoding = "async";
      img.onload = () => { void (typeof img.decode === "function" ? img.decode().catch(() => undefined) : Promise.resolve()).then(() => { loadedAnimatedEmoji.add(emoji); resolve(true); }); };
      img.onerror = () => { failedAnimatedEmoji.add(emoji); resolve(false); };
      img.src = animatedEmojiUrl(emoji);
    });
    emojiLoading.set(emoji, load);
  }
  return Promise.race([load, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs))]);
}
/** Performance guard: animated emoji run on every device (phones included). If a device struggles, fewer play at the same time instead of switching to static emoji. */
const isTouchDevice = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const MAX_FLOATING_REACTIONS = 14;
let animatedCap = isTouchDevice ? 4 : 5; // how many DIFFERENT animated emoji can play together (copies of the same emoji share one decoded image, so they cost almost nothing)
let lowPerformanceMode = false;
let emojiPreloadStarted = false;
/** Warms the browser cache one emoji at a time while the browser is idle, so joining a room never competes with 12 large downloads. */
function preloadAnimatedEmojis() {
  if (emojiPreloadStarted || lowPerformanceMode || typeof window === "undefined") return;
  emojiPreloadStarted = true;
  const queue = Object.keys(ANIMATED_EMOJI_CODE);
  const idle = (callback: () => void) => { const w = window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }; if (w.requestIdleCallback) w.requestIdleCallback(callback, { timeout: 3000 }); else window.setTimeout(callback, 400); };
  const next = () => {
    const emoji = queue.shift();
    if (!emoji) return;
    const img = new Image(); img.decoding = "async";
    img.onload = () => { loadedAnimatedEmoji.add(emoji); idle(next); };
    img.onerror = () => { failedAnimatedEmoji.add(emoji); idle(next); };
    img.src = animatedEmojiUrl(emoji);
  };
  idle(next);
}
/** Renders the animated emoji only when `animated` is true; otherwise (or on failure) the native glyph, which costs nothing to draw. */
function AnimatedEmoji({ emoji, className = "", animated = true }: { emoji: string; className?: string; animated?: boolean }) {
  const [failed, setFailed] = useState(() => failedAnimatedEmoji.has(emoji));
  if (!animated || failed || lowPerformanceMode || !ANIMATED_EMOJI_CODE[emoji]) return <span className={`animated-emoji-fallback ${className}`} aria-hidden="true">{emoji}</span>;
  return <img className={`animated-emoji ${className}`} src={animatedEmojiUrl(emoji)} width={56} height={56} alt="" aria-hidden="true" draggable={false} decoding="async" loading="eager" onError={() => { failedAnimatedEmoji.add(emoji); setFailed(true); }} />;
}
/** Picker emoji: a static glyph at rest; the animated version plays for the one emoji being hovered, pressed or focused (mouse and touch alike). */
function PickerEmoji({ emoji }: { emoji: string }) {
  const [hot, setHot] = useState(false);
  return <span className="picker-emoji" onPointerEnter={() => setHot(true)} onPointerDown={() => setHot(true)} onPointerLeave={() => setHot(false)} onFocus={() => setHot(true)} onBlur={() => setHot(false)}><AnimatedEmoji emoji={emoji} animated={hot}/></span>;
}
/** Most important emoji first; the ones this person sends most often move to the front (remembered on this device). */
const EMOJI_USAGE_KEY = "meet-emoji-usage";
const readEmojiUsage = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(EMOJI_USAGE_KEY) || "{}") as Record<string, number>; } catch { return {}; } };
const orderedReactions = (usage: Record<string, number>) => REACTION_SET.map((emoji, index) => ({ emoji, index })).sort((a, b) => (usage[b.emoji] || 0) - (usage[a.emoji] || 0) || a.index - b.index).map((entry) => entry.emoji);
const recordEmojiUsage = (emoji: string) => { const usage = readEmojiUsage(); usage[emoji] = (usage[emoji] || 0) + 1; try { localStorage.setItem(EMOJI_USAGE_KEY, JSON.stringify(usage)); } catch { /* Storage unavailable. */ } return usage; };
/** One horizontal, swipeable row with no visible scrollbar; the mouse wheel scrolls it sideways on desktop. */
function EmojiRow({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current; if (!element) return;
    const onWheel = (event: WheelEvent) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && element.scrollWidth > element.clientWidth) { element.scrollLeft += event.deltaY; event.preventDefault(); } };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
  return <div ref={ref} className={className} role="group" aria-label="Choose a reaction">{children}</div>;
}
/** Screen indicator: one short dash per screen of people (only with two or more screens); the current one is longer and brighter. */
const ParticipantDots = memo(function ParticipantDots({ pages, current, onSelect }: { pages: number; current: number; onSelect: (page: number) => void }) {
  const MAX_VISIBLE = 7;
  const start = pages <= MAX_VISIBLE ? 0 : Math.max(0, Math.min(pages - MAX_VISIBLE, current - Math.floor(MAX_VISIBLE / 2)));
  const end = Math.min(pages, start + MAX_VISIBLE);
  const dots: number[] = []; for (let i = start; i < end; i += 1) dots.push(i);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") { event.preventDefault(); onSelect(current + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); onSelect(current - 1); }
  };
  return <div className="participant-dots" role="tablist" aria-label={`Participant screens, screen ${current + 1} of ${pages}`} onKeyDown={onKey}>
    {dots.map((index) => <button key={index} type="button" role="tab" aria-selected={index === current} aria-label={`Screen ${index + 1} of ${pages}`} tabIndex={index === current ? 0 : -1} className={`participant-dot ${index === current ? "is-active" : ""} ${(index === start && start > 0) || (index === end - 1 && end < pages) ? "is-edge" : ""}`} onClick={() => onSelect(index)}><span/></button>)}
  </div>;
});
/** Reactions live in their own tiny component, so each emoji re-renders only itself and never the whole room. */
const reactionListeners = new Set<(reaction: FloatingReaction) => void>();
function pushReaction(id: string, emoji: string, name: string) {
  const reaction = makeReaction(id, emoji, name);
  reactionListeners.forEach((listener) => listener(reaction));
}
const ReactionLayer = memo(function ReactionLayer() {
  const [items, setItems] = useState<FloatingReaction[]>([]);
  const itemsRef = useRef<FloatingReaction[]>([]);
  const slotTimes = useRef<number[]>([]);
  const stackRef = useRef<HTMLDivElement>(null);
  itemsRef.current = items;
  // Emojis always start at the bottom edge of the participant cards (the strip while presenting, the card grid otherwise).
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const strip = document.querySelector<HTMLElement>(".participant-grid-wrap.has-screen-share .participant-grid") ?? document.querySelector<HTMLElement>(".participant-grid-wrap .participant-grid");
    const holder = stack.offsetParent as HTMLElement | null;
    if (!strip || !holder) { stack.style.removeProperty("--reaction-bottom"); return; }
    const gap = holder.getBoundingClientRect().bottom - strip.getBoundingClientRect().bottom;
    stack.style.setProperty("--reaction-bottom", `${Math.max(0, Math.round(gap))}px`);
  }, [items.length]);
  useEffect(() => {
    preloadAnimatedEmojis();
    const insert = (incoming: FloatingReaction, imageReady: boolean) => {
      const current = itemsRef.current;
      const playing = new Set(current.filter((entry) => entry.animated).map((entry) => entry.emoji));
      // Spread the launch points: always use the lane that was used longest ago, so many emoji sent at once never touch each other.
      const lanes = window.innerWidth < 720 ? 5 : 7;
      const times = slotTimes.current;
      while (times.length < lanes) times.push(0);
      times.length = lanes;
      let lane = 0; let oldest = Infinity;
      for (let index = 0; index < lanes; index += 1) { const value = times[index] + Math.random() * 30; if (value < oldest) { oldest = value; lane = index; } }
      times[lane] = Date.now();
      const x = 14 + lane * (72 / (lanes - 1)) + (Math.random() * 3 - 1.5);
      const item = { ...incoming, x, animated: imageReady && !lowPerformanceMode && (playing.has(incoming.emoji) || playing.size < animatedCap) };
      setItems([...current.slice(-(MAX_FLOATING_REACTIONS - 1)), item]);
      window.setTimeout(() => setItems((list) => list.filter((entry) => entry.id !== item.id)), REACTION_LIFETIME + 500);
    };
    // An emoji only floats up once its picture is ready, so a name is never seen alone; if the picture is slow, the native emoji is shown right away instead.
    const listener = (incoming: FloatingReaction) => {
      if (lowPerformanceMode || loadedAnimatedEmoji.has(incoming.emoji) || !ANIMATED_EMOJI_CODE[incoming.emoji]) { insert(incoming, loadedAnimatedEmoji.has(incoming.emoji)); return; }
      void waitForEmoji(incoming.emoji).then((ok) => insert(incoming, ok));
    };
    reactionListeners.add(listener);
    return () => { reactionListeners.delete(listener); };
  }, []);
  // Frame monitor: if the device cannot keep up while reactions float, fewer play at once (never fewer than one).
  const active = items.length > 0;
  useEffect(() => {
    if (!active) return;
    let raf = 0; let last = 0; let slow = 0; let frames = 0; let warm = 0;
    const tick = (now: number) => {
      warm += 1;
      if (last && warm > 20) { frames += 1; if (now - last > 55) slow += 1; }
      last = now;
      if (frames >= 60) {
        if (slow / frames > 0.5 && animatedCap > 1) { animatedCap -= 1; setItems((list) => { const allowed = new Set<string>(); return list.map((item) => { if (!item.animated) return item; if (allowed.has(item.emoji) || allowed.size < animatedCap) { allowed.add(item.emoji); return item; } return { ...item, animated: false }; }); }); }
        frames = 0; slow = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  if (!items.length) return null;
  return <div className="reaction-float-stack" ref={stackRef} aria-live="polite" data-dense={items.length > 5 ? "true" : "false"}>{items.map((reaction) => <div className="reaction-float" key={reaction.id} style={{ "--x": `${reaction.x}%`, "--rise": `${reaction.rise}%`, "--rs": reaction.scale } as CSSProperties} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setItems((list) => list.filter((entry) => entry.id !== reaction.id)); }}><span className="reaction-emoji"><AnimatedEmoji emoji={reaction.emoji} animated={reaction.animated}/></span><b>{reaction.name}</b></div>)}</div>;
});
// Anything a person can press: a tap on these must keep doing its own job and never toggle fullscreen.
const INTERACTIVE_SELECTOR = ".screen-annotate-layer.is-drawing, .screen-annotate-toolbar, button, a, input, textarea, select, label, summary, [role='button'], [role='dialog'], [data-popover], .room-device-menu, .reaction-picker, .messages-modal-backdrop, .room-alert, .room-message-toast, .room-presence-stack, .modal-backdrop";
const PARTICIPANTS_PER_SCREEN = 6;
const REACTION_SET = ["🙏", "❤️", "👏", "🙌", "😊", "🎉", "✨", "💛", "🕊️", "👍", "😂", "🔥", "😍", "🤗", "🥳", "💪", "🤝", "😮", "😢", "💯"];

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

/** Call-control icons and round button, drawn to match the reference call bar (solid white glyphs on round buttons). */
function RdCameraIcon({ off = false }: { off?: boolean }) {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><defs><mask id="rd-cam-cut"><rect width="24" height="24" fill="#fff"/>{off && <path d="M3.5 3.5 20.5 20.5" stroke="#000" strokeWidth="4.6" strokeLinecap="round"/>}</mask></defs><g mask="url(#rd-cam-cut)"><rect x="2" y="5.5" width="13.5" height="13" rx="3"/><path d="M16.8 10.4 21 7.7c.7-.45 1.5.05 1.5.9v6.8c0 .85-.8 1.35-1.5.9l-4.2-2.7z"/></g>{off && <path d="M3.5 3.5 20.5 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</svg>;
}
function RdMicIcon({ off = false }: { off?: boolean }) {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><defs><mask id="rd-mic-cut"><rect width="24" height="24" fill="#fff"/>{off && <path d="M3.5 3.5 20.5 20.5" stroke="#000" strokeWidth="4.6" strokeLinecap="round"/>}</mask></defs><g mask="url(#rd-mic-cut)" stroke="currentColor" strokeLinecap="round" strokeWidth="2"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" stroke="none"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.2M8.6 21.2h6.8"/></g>{off && <path d="M3.5 3.5 20.5 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</svg>;
}
function RdSpeakerIcon({ off = false, size = 30 }: { off?: boolean; size?: number }) {
  const maskId = `rd-spk-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // A balanced speaker: square back, flared cone and (when on) two sound waves, all centred on the same horizontal line.
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true"><defs><mask id={maskId}><rect width="24" height="24" fill="#fff"/>{off && <path d="M3.5 3.5 20.5 20.5" stroke="#000" strokeWidth="3.8" strokeLinecap="round"/>}</mask></defs><g mask={`url(#${maskId})`}><path d="M3.5 9.2h2.6l5-4.1c.65-.53 1.6-.07 1.6.77v12.26c0 .84-.95 1.3-1.6.77l-5-4.1H3.5c-.55 0-1-.45-1-1v-3.6c0-.55.45-1 1-1z" fill="currentColor"/>{!off && <path d="M15.8 8.7a4.7 4.7 0 0 1 0 6.6M18.5 5.9a8.6 8.6 0 0 1 0 12.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</g>{off && <path d="M3.5 3.5 20.5 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</svg>;
}
function RdShareIcon() { return <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-4.4l.9 2h1.1a1 1 0 1 1 0 2H8.4a1 1 0 1 1 0-2h1.1l.9-2H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><circle cx="12" cy="9.2" r="2"/><path d="M8 15c0-2 1.8-3 4-3s4 1 4 3z"/></svg>; }
function RdHangupIcon() { return <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>; }
function RdButton({ icon, label, onClick, on = false, danger = false, disabled = false, badge = null, ...aria }: { icon: ReactNode; label: string; onClick?: () => void; on?: boolean; danger?: boolean; disabled?: boolean; badge?: ReactNode; "aria-haspopup"?: "dialog"; "aria-expanded"?: boolean }) {
  return <button type="button" className={`rd-btn ${on ? "is-on" : ""} ${danger ? "is-danger" : ""}`} onClick={onClick} disabled={disabled} title={label} aria-label={label} {...aria}>{icon}{badge}</button>;
}
/** Call bar: swipeable horizontal sections of round buttons (native scroll-snap = compositor-driven, no JS in the scroll path) with a Leave button that never moves. */
function RdCarousel({ pages, leave }: { pages: ReactNode[][]; leave: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(0);
  const [page, setPage] = useState(0);
  const count = pages.length;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / (el.clientWidth || 1))));
        if (next !== pageRef.current) { pageRef.current = next; setPage(next); }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (frame) window.cancelAnimationFrame(frame); };
  }, [count]);
  useEffect(() => {
    // The number of sections can shrink (for example the host-only buttons disappear): keep the position valid.
    if (pageRef.current > count - 1) { pageRef.current = Math.max(0, count - 1); setPage(pageRef.current); scrollerRef.current?.scrollTo({ left: pageRef.current * (scrollerRef.current?.clientWidth || 0) }); }
  }, [count]);
  const goTo = (index: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = Math.max(0, Math.min(count - 1, index));
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: target * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };
  const onDotsKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") { event.preventDefault(); goTo(pageRef.current + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); goTo(pageRef.current - 1); }
  };
  return <div className="rd-pill" role="toolbar" aria-label="Call controls">
    <div className="rd-carousel" ref={scrollerRef}>
      {pages.map((items, index) => <div className="rd-page" key={index} role="group" aria-label={`Call controls, section ${index + 1} of ${count}`}><div className="rd-page-inner">{items}</div></div>)}
    </div>
    <div className="rd-leave">{leave}</div>
    {count > 1 && <div className="rd-dots" role="tablist" aria-label={`Call control sections, section ${page + 1} of ${count}`} onKeyDown={onDotsKey}>
      {pages.map((_, index) => <button key={index} type="button" role="tab" aria-selected={index === page} aria-label={`Show control section ${index + 1} of ${count}`} tabIndex={index === page ? 0 : -1} className={`rd-dot ${index === page ? "is-active" : ""}`} onClick={() => goTo(index)}><span/></button>)}
    </div>}
  </div>;
}
/** One shared dialog for the room's pickers: a real centred modal on desktop, a bottom sheet on phones, light and dark aware. Phone/browser Back closes it. */
function RoomSheet({ title, subtitle, onClose, children, className = "", popover }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; className?: string; popover?: string }) {
  useBackClose(true, onClose);
  return <div className="rs-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`rs-panel ${className}`} role="dialog" aria-modal="true" aria-label={title} data-popover={popover}>
      <span className="rs-grip" aria-hidden="true"/>
      <header className="rs-head"><div><b>{title}</b>{subtitle && <small>{subtitle}</small>}</div><button type="button" className="rs-close" onClick={onClose} aria-label={`Close ${title}`}><X size={16}/></button></header>
      <div className="rs-body">{children}</div>
    </section>
  </div>;
}
function DeviceSheet({ kind, devices, activeId, onPick, onClose, onPickOutput, activeOutputId }: { kind: "audioinput" | "videoinput"; devices: MediaDeviceInfo[]; activeId: string; onPick: (deviceId: string) => void; onClose: () => void; onPickOutput?: (deviceId: string) => void; activeOutputId?: string }) {
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (kind !== "audioinput" || !onPickOutput || !("setSinkId" in HTMLMediaElement.prototype)) return;
    let cancelled = false;
    navigator.mediaDevices?.enumerateDevices().then((list) => { if (!cancelled) setOutputs(list.filter((device) => device.kind === "audiooutput")); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [kind, onPickOutput]);
  const isMic = kind === "audioinput";
  const unnamed = devices.length > 0 && devices.every((device) => !device.label);
  const row = (device: MediaDeviceInfo, index: number, active: boolean, pick: (id: string) => void, fallback: string) => (
    <button type="button" key={`${device.deviceId}-${index}`} className={`rs-option ${active ? "is-selected" : ""}`} onClick={() => pick(device.deviceId)} aria-pressed={active}>
      <span className="rs-option-icon">{isMic ? <Mic size={16}/> : <Video size={16}/>}</span>
      <span className="rs-option-label">{device.label || `${fallback} ${index + 1}`}</span>
      {active && <Check size={17} className="rs-option-check"/>}
    </button>
  );
  return <RoomSheet title={isMic ? "Microphone" : "Camera"} subtitle={isMic ? "Choose which microphone people hear" : "Choose which camera people see"} onClose={onClose} popover={kind}>
    {devices.length === 0 ? <p className="rs-empty">{isMic ? "No microphones were found. Plug one in or allow microphone access in your browser." : "No cameras were found. Plug one in or allow camera access in your browser."}</p>
      : <div className="rs-list" role="group" aria-label={isMic ? "Microphones" : "Cameras"}>{devices.map((device, index) => row(device, index, device.deviceId === activeId || (!activeId && index === 0), (id) => onPick(id), isMic ? "Microphone" : "Camera"))}</div>}
    {unnamed && <p className="rs-hint">Device names appear once the browser has been given {isMic ? "microphone" : "camera"} access.</p>}
    {isMic && outputs.length > 0 && onPickOutput && <>
      <p className="rs-section">Speaker</p>
      <div className="rs-list" role="group" aria-label="Speakers">{outputs.map((device, index) => (
        <button type="button" key={`${device.deviceId}-${index}`} className={`rs-option ${device.deviceId === activeOutputId ? "is-selected" : ""}`} onClick={() => onPickOutput(device.deviceId)} aria-pressed={device.deviceId === activeOutputId}>
          <span className="rs-option-icon"><RdSpeakerIcon size={26}/></span><span className="rs-option-label">{device.label || `Speaker ${index + 1}`}</span>{device.deviceId === activeOutputId && <Check size={17} className="rs-option-check"/>}
        </button>))}</div>
    </>}
  </RoomSheet>;
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
 * Picture-in-Picture for the live room. When the person leaves the page (switches
 * app or tab) the call is shown in a floating PiP window, which keeps the page
 * treated as "in use" by the browser so audio, video and the LiveKit connection stay
 * live. The PiP window plays the real screen-share / active-speaker video track
 * (attached through LiveKit so adaptive-stream keeps that layer flowing), and falls
 * back to a name card when nobody has a camera on.
 */
type PipVideoElement = HTMLVideoElement & {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  autoPictureInPicture?: boolean;
};
type PipSource = { track: Track | null; name: string; key: string; identity?: string; picture?: string };

function isPictureInPictureSupported(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("video") as PipVideoElement;
  return Boolean(document.pictureInPictureEnabled) || typeof probe.webkitSetPresentationMode === "function";
}

type DocumentPipApi = { requestWindow: (options?: { width?: number; height?: number }) => Promise<Window> };
const PIP_ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(135deg)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
};
const PIP_WINDOW_CSS = `html,body{margin:0;height:100%;background:#140c10;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.stage{position:relative;width:100%;height:100%;background:#140c10}.stage video{display:block;width:100%;height:100%;object-fit:cover;background:#140c10}
.bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:14px;padding:26px 12px 12px;background:linear-gradient(to top,rgba(10,5,8,.72),rgba(10,5,8,0));opacity:0;transform:translateY(6px);transition:opacity .2s ease,transform .2s ease}
.stage:hover .bar,.stage:focus-within .bar{opacity:1;transform:none}
.bar button{display:grid;place-items:center;width:40px;height:40px;padding:0;border:0;border-radius:50%;color:#fff;background:rgba(58,58,60,.92);cursor:pointer;transition:background-color .15s ease,transform .12s ease}
.bar button:hover{background:rgba(88,88,92,.96)}.bar button:active{transform:scale(.93)}
.bar button.off{color:#2a2a2c;background:#fff}.bar button.off:hover{background:#ececef}
.bar button.leave{width:44px;height:44px;color:#fff;background:#ee1c47}.bar button.leave:hover{background:#ff2d58}
.bar svg{display:block;width:20px;height:20px}.bar button.leave svg{width:21px;height:21px}`;
function useRoomPictureInPicture(room: Room, title: string, onLeave?: () => void) {
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const [supported] = useState(isPictureInPictureSupported);
  const [active, setActive] = useState(false);
  const controls = useRef<{ enter: (automatic: boolean) => Promise<boolean>; exit: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!supported) return;
    const video = document.createElement("video") as PipVideoElement;
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.setAttribute("playsinline", ""); video.setAttribute("aria-hidden", "true"); video.tabIndex = -1;
    video.disablePictureInPicture = false;
    video.autoPictureInPicture = true; // Safari: float automatically when the page is left.
    video.setAttribute("autopictureinpicture", "");
    video.className = "room-pip-source";
    document.body.appendChild(video);

    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    let canvasStream: MediaStream | null = null;
    let canvasTimer = 0;
    let scheduleTimer = 0;
    let current: PipSource | null = null;
    let enteredAutomatically = false;
    let disposed = false;
    let docWin: Window | null = null; // Chrome/Edge desktop: our own floating window with a styled leave button
    const docPipApi = (window as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;

    const isPip = () => Boolean(docWin) || document.pictureInPictureElement === video || (video as PipVideoElement).webkitPresentationMode === "picture-in-picture";

    const usableTrack = (participant: Participant, source: Track.Source): Track | null => {
      const publication = participant.getTrackPublication(source);
      const track = publication?.track;
      if (!track || publication.isMuted || track.mediaStreamTrack?.readyState === "ended") return null;
      return track;
    };
    // The floating window follows the current speaker: their live camera when it is on, otherwise a large profile photo.
    let lastSpeakerId = "";
    const trackSpeaker = () => { const first = room.activeSpeakers.find((participant) => !participant.isLocal); if (first) lastSpeakerId = first.identity; };
    const pickSource = (): PipSource => {
      const remotes = Array.from(room.remoteParticipants.values());
      const label = (participant: Participant) => participantName(participant) || participant.identity || "Participant";
      for (const participant of remotes) {
        const track = usableTrack(participant, Track.Source.ScreenShare);
        if (track) return { track, name: label(participant), key: `${track.mediaStreamTrack?.id ?? track.sid}` };
      }
      const speakers = room.activeSpeakers.filter((participant) => !participant.isLocal);
      const focus = speakers[0] ?? remotes.find((participant) => participant.identity === lastSpeakerId) ?? remotes[0];
      if (focus) {
        const track = usableTrack(focus, Track.Source.Camera);
        if (track) return { track, name: label(focus), key: `${track.mediaStreamTrack?.id ?? track.sid}` };
        return { track: null, name: label(focus), key: `card:${focus.identity}`, identity: focus.identity, picture: participantPicture(focus.metadata, focus.identity) };
      }
      const own = usableTrack(room.localParticipant, Track.Source.Camera);
      if (own) return { track: own, name: "You", key: `${own.mediaStreamTrack?.id ?? own.sid}` };
      const self = room.localParticipant;
      return { track: null, name: participantName(self) || title, key: `card:${self.identity}`, identity: self.identity, picture: participantPicture(self.metadata, self.identity) };
    };

    // Profile photos are loaded with CORS so they can be painted on the canvas that feeds the floating window.
    const photos = new Map<string, HTMLImageElement | "loading" | "failed">();
    const photoFor = (picture?: string): HTMLImageElement | null => {
      const url = picture ? hiResPhoto(picture, 512) : "";
      if (!url) return null;
      const hit = photos.get(url);
      if (hit instanceof HTMLImageElement) return hit;
      if (hit) return null;
      photos.set(url, "loading");
      const img = new Image();
      img.crossOrigin = "anonymous"; img.referrerPolicy = "no-referrer"; img.decoding = "async";
      img.onload = () => { photos.set(url, img); if (current && !current.track) drawCard(current); };
      img.onerror = () => photos.set(url, "failed");
      img.src = url;
      return null;
    };

    const drawCard = (source: PipSource) => {
      const g = canvas.getContext("2d");
      if (!g) return;
      const w = canvas.width; const h = canvas.height;
      const name = source.name;
      const speaking = Boolean(source.identity && room.activeSpeakers.some((participant) => participant.identity === source.identity));
      g.fillStyle = "#140c10"; g.fillRect(0, 0, w, h);
      const glow = g.createRadialGradient(w / 2, h / 2 - 24, 40, w / 2, h / 2 - 24, w * 0.6);
      glow.addColorStop(0, "rgba(169,43,78,.34)"); glow.addColorStop(1, "rgba(20,12,16,0)");
      g.fillStyle = glow; g.fillRect(0, 0, w, h);

      const cx = w / 2; const cy = h / 2 - 22; const radius = 112;
      g.lineWidth = speaking ? 7 : 3; g.strokeStyle = speaking ? "#e8ca91" : "rgba(255,255,255,.2)";
      g.beginPath(); g.arc(cx, cy, radius + 10, 0, Math.PI * 2); g.stroke();
      g.save(); g.beginPath(); g.arc(cx, cy, radius, 0, Math.PI * 2); g.closePath(); g.clip();
      const photo = photoFor(source.picture);
      if (photo && photo.naturalWidth > 0) {
        const side = Math.min(photo.naturalWidth, photo.naturalHeight);
        g.drawImage(photo, (photo.naturalWidth - side) / 2, (photo.naturalHeight - side) / 2, side, side, cx - radius, cy - radius, radius * 2, radius * 2);
      } else {
        g.fillStyle = avatarColor(name); g.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        const letter = Array.from(name.replace(/[<>]/g, "").trim())[0]?.toUpperCase() || "E";
        g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = "600 120px system-ui, sans-serif"; g.fillText(letter, cx, cy + 6);
      }
      g.restore();

      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = "700 28px system-ui, sans-serif"; g.fillStyle = "#fff7f4";
      g.fillText(name.length > 26 ? `${name.slice(0, 25)}…` : name, cx, cy + radius + 40);
      g.font = "600 15px system-ui, sans-serif"; g.fillStyle = speaking ? "#e8ca91" : "#c9aab4";
      g.fillText(speaking ? "Speaking now" : "MEET ENIHAKOLE · Live", cx, cy + radius + 68);

      // Your own microphone and camera state, so the floating window always shows it (the buttons live in the window's own controls).
      const chip = (x: number, label: string, on: boolean) => {
        g.font = "700 13px system-ui, sans-serif";
        const width = g.measureText(label).width + 34;
        g.fillStyle = "rgba(255,255,255,.1)"; g.beginPath(); if (typeof g.roundRect === "function") g.roundRect(x, 14, width, 28, 14); else g.rect(x, 14, width, 28); g.fill();
        g.fillStyle = on ? "#4ade80" : "#f87171"; g.beginPath(); g.arc(x + 15, 28, 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#fff7f4"; g.textAlign = "left"; g.fillText(label, x + 26, 29);
        return x + width + 8;
      };
      const next = chip(14, room.localParticipant.isMicrophoneEnabled ? "Mic on" : "Mic off", room.localParticipant.isMicrophoneEnabled);
      chip(next, room.localParticipant.isCameraEnabled ? "Camera on" : "Camera off", room.localParticipant.isCameraEnabled);
    };

    // Tells Chrome this page is a live call (camera/microphone in use) so it may float the call by itself when the user leaves the app.
    const flagCapture = () => {
      const media = navigator.mediaSession as (MediaSession & { setMicrophoneActive?: (active: boolean) => void; setCameraActive?: (active: boolean) => void }) | undefined;
      try { media?.setMicrophoneActive?.(room.localParticipant.isMicrophoneEnabled); } catch { /* Optional hint. */ }
      try { media?.setCameraActive?.(room.localParticipant.isCameraEnabled); } catch { /* Optional hint. */ }
    };
    const apply = () => {
      if (disposed) return;
      flagCapture();
      const next = pickSource();
      if (current && current.key === next.key) return;
      if (current?.track) { try { current.track.detach(video); } catch { /* Track already gone. */ } }
      window.clearInterval(canvasTimer); canvasTimer = 0;
      current = next;
      if (next.track) {
        next.track.attach(video);
      } else {
        drawCard(next);
        if (!canvasStream) canvasStream = canvas.captureStream(2);
        video.srcObject = canvasStream;
        // Keep the card producing frames so the floating window never freezes.
        canvasTimer = window.setInterval(() => drawCard(next), 1000);
      }
      void video.play().catch(() => undefined);
    };
    const schedule = () => {
      window.clearTimeout(scheduleTimer);
      scheduleTimer = window.setTimeout(apply, 250);
    };

    const waitForFrame = () => new Promise<void>((resolve) => {
      if (video.readyState >= 1) { resolve(); return; }
      const done = () => { video.removeEventListener("loadedmetadata", done); window.clearTimeout(timer); resolve(); };
      const timer = window.setTimeout(done, 1500);
      video.addEventListener("loadedmetadata", done);
    });

    /** Opens the call in a floating window we draw ourselves (microphone, red leave button, camera). Falls back to the native window if the browser refuses. */
    const enterDocPip = async (): Promise<boolean> => {
      if (!docPipApi) return false;
      try {
        const pw = await docPipApi.requestWindow({ width: 360, height: 220 });
        const doc = pw.document;
        doc.title = title;
        const style = doc.createElement("style"); style.textContent = PIP_WINDOW_CSS; doc.head.appendChild(style);
        const stage = doc.createElement("div"); stage.className = "stage";
        const bar = doc.createElement("div"); bar.className = "bar";
        const makeButton = (label: string, className: string, onClick: () => void) => {
          const button = doc.createElement("button"); button.type = "button"; button.className = className; button.setAttribute("aria-label", label); button.title = label;
          button.addEventListener("click", onClick); bar.appendChild(button); return button;
        };
        const camButton = makeButton("Camera", "", () => { void room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled).catch(() => undefined); });
        const leaveButton = makeButton("Leave call", "leave", () => { leaveRef.current?.(); try { pw.close(); } catch { /* Already closed. */ } });
        const micButton = makeButton("Microphone", "", () => { void room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled).catch(() => undefined); });
        leaveButton.innerHTML = PIP_ICONS.hangup;
        const sync = () => {
          const micOn = room.localParticipant.isMicrophoneEnabled; const camOn = room.localParticipant.isCameraEnabled;
          micButton.className = micOn ? "" : "off"; micButton.innerHTML = micOn ? PIP_ICONS.mic : PIP_ICONS.micOff;
          camButton.className = camOn ? "" : "off"; camButton.innerHTML = camOn ? PIP_ICONS.cam : PIP_ICONS.camOff;
        };
        sync();
        const syncTimer = window.setInterval(sync, 400);
        video.className = ""; video.removeAttribute("style");
        stage.appendChild(video); stage.appendChild(bar); doc.body.appendChild(stage);
        docWin = pw;
        pw.addEventListener("pagehide", () => {
          window.clearInterval(syncTimer);
          docWin = null; enteredAutomatically = false;
          video.className = "room-pip-source"; video.removeAttribute("style");
          if (!disposed) document.body.appendChild(video);
          setActive(false);
        });
        setActive(true);
        void video.play().catch(() => undefined);
        return true;
      } catch {
        docWin = null;
        return false;
      }
    };
    const enter = async (automatic: boolean) => {
      if (disposed || room.state !== ConnectionState.Connected) return false;
      if (isPip()) return true;
      if (!automatic && docPipApi && (await enterDocPip())) return true;
      try {
        apply();
        video.classList.add("room-pip-source-live");
        await waitForFrame();
        await video.play().catch(() => undefined);
        if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") await video.requestPictureInPicture();
        else if (typeof video.webkitSetPresentationMode === "function") video.webkitSetPresentationMode("picture-in-picture");
        else return false;
        enteredAutomatically = automatic;
        return true;
      } catch {
        // Needs a user gesture or the browser blocked it: the call itself keeps running normally.
        video.classList.remove("room-pip-source-live");
        return false;
      }
    };
    const exit = async () => {
      if (docWin) { try { docWin.close(); } catch { /* Already closed. */ } return; }
      try {
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
        else if (video.webkitPresentationMode === "picture-in-picture") video.webkitSetPresentationMode?.("inline");
      } catch { /* Already closed. */ }
    };
    controls.current = { enter, exit };

    const onEnter = () => {
      setActive(true);
      try { if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"; } catch { /* Optional. */ }
    };
    const onLeave = () => { setActive(false); enteredAutomatically = false; video.classList.remove("room-pip-source-live"); };
    const onSafariMode = () => { if (video.webkitPresentationMode === "picture-in-picture") onEnter(); else onLeave(); };
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onSafariMode);

    // Leaving the page: float the call (works without a tap where the browser allows automatic PiP).
    const retryTimers: number[] = [];
    const clearRetries = () => { while (retryTimers.length) window.clearTimeout(retryTimers.pop()); };
    // Home / Recent: float the call right away; if the browser is not ready on the first try, retry a couple of times while the page is still hidden.
    const floatNow = () => {
      flagCapture();
      void enter(true).then((floated) => {
        if (floated || disposed) return;
        clearRetries();
        [250, 900].forEach((delay) => retryTimers.push(window.setTimeout(() => { if (!disposed && document.visibilityState === "hidden" && !isPip()) void enter(true); }, delay)));
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") floatNow();
      else {
        // Back in the app: the call returns to its normal room view (the floating window closes).
        clearRetries();
        if (enteredAutomatically) enteredAutomatically = false;
        if (isPip() && !docWin) void exit();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Home button, app switcher or opening a notification can hide the page without a clean visibility event on some browsers.
    const onPageHide = () => { if (document.visibilityState === "hidden" || document.hidden) floatNow(); };
    window.addEventListener("pagehide", onPageHide);
    // Screen off, app switcher or the tab being frozen by the system: float the call too.
    document.addEventListener("freeze", onPageHide);
    const session = navigator.mediaSession;
    try { session?.setActionHandler("enterpictureinpicture" as MediaSessionAction, () => { void enter(true); }); }
    catch { /* This browser has no automatic-PiP media action. */ }
    // A live call counts as "playing media", which is what lets Chrome float it automatically from Home / Recent.
    try { if (session) { session.playbackState = "playing"; if (typeof MediaMetadata !== "undefined") session.metadata = new MediaMetadata({ title, artist: "MEET ENIHAKOLE" }); } } catch { /* Optional. */ }

    const events = [RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.Connected, RoomEvent.Reconnected] as const;
    room.on(RoomEvent.ActiveSpeakersChanged, trackSpeaker);
    events.forEach((event) => room.on(event, schedule));
    apply(); // Warm start: the floating window opens instantly with a ready picture.

    return () => {
      disposed = true;
      controls.current = null;
      window.clearTimeout(scheduleTimer); window.clearInterval(canvasTimer);
      events.forEach((event) => room.off(event, schedule));
      room.off(RoomEvent.ActiveSpeakersChanged, trackSpeaker);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("freeze", onPageHide);
      try { session?.setActionHandler("enterpictureinpicture" as MediaSessionAction, null); } catch { /* Optional. */ }
      clearRetries();
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onSafariMode);
      if (isPip()) { void exit(); }
      if (current?.track) { try { current.track.detach(video); } catch { /* Already detached. */ } }
      video.srcObject = null;
      canvasStream?.getTracks().forEach((track) => track.stop());
      video.remove();
      setActive(false);
    };
  }, [room, supported, title]);

  const toggle = useCallback(async () => {
    if (!controls.current) return;
    if (active) await controls.current.exit();
    else if (!(await controls.current.enter(false))) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Picture-in-picture isn't available in this browser right now." } }));
  }, [active]);

  const enterAuto = useCallback(async () => (controls.current ? controls.current.enter(true) : false), []);
  const exit = useCallback(async () => { await controls.current?.exit(); }, []);
  return { supported, active, toggle, enterAuto, exit };
}

/**
 * While the call is on screen, keep the phone awake (Screen Wake Lock) so the screen timeout never turns the display off
 * and puts the call to sleep. It is released automatically when the page is hidden, so it is taken again on return, after
 * a reconnect, and on the first touch for browsers that require a gesture. Released for good when the room closes.
 */
function useCallWakeLock(room: Room) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    let requesting = false;
    const acquire = async () => {
      if (disposed || sentinel || requesting || document.visibilityState !== "visible" || room.state !== ConnectionState.Connected) return;
      requesting = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed) { void lock.release().catch(() => undefined); return; }
        sentinel = lock;
        lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; });
      } catch { /* Denied (battery saver or no gesture yet): retried on the next touch or when the page returns. */ }
      finally { requesting = false; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void acquire(); };
    const onTouch = () => { void acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pointerdown", onTouch, { passive: true });
    room.on(RoomEvent.Connected, onTouch);
    room.on(RoomEvent.Reconnected, onTouch);
    void acquire();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", onTouch);
      room.off(RoomEvent.Connected, onTouch);
      room.off(RoomEvent.Reconnected, onTouch);
      const lock = sentinel; sentinel = null;
      if (lock) void lock.release().catch(() => undefined);
    };
  }, [room]);
}

/**
 * Extra "real call" protection while the room is connected, so the call carries on when the screen times out or the app
 * is in the background: a Web Lock (stops the browser freezing the tab), a silent audio session (keeps the phone's audio
 * pipeline and lock-screen call controls alive), and, where the Screen Wake Lock API is missing (older iPhones), a tiny
 * hidden looping video that keeps the display awake. Everything is released when the room closes.
 */
function useCallKeepAlive(room: Room) {
  useEffect(() => {
    let disposed = false;
    let releaseLock: (() => void) | null = null;
    try {
      void navigator.locks?.request("meet-enihakole-live-call", { mode: "shared" }, () => new Promise<void>((resolve) => { releaseLock = resolve; if (disposed) resolve(); })).catch(() => undefined);
    } catch { /* Web Locks are optional. */ }

    let audio: HTMLAudioElement | null = null;
    let audioUrl = "";
    const startAudio = () => {
      if (disposed || audio || room.state !== ConnectionState.Connected) return;
      try {
        // One second of silence (8 kHz, 8-bit mono WAV), looped.
        const bytes = new Uint8Array(44 + 8000);
        const view = new DataView(bytes.buffer);
        const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
        text(0, "RIFF"); view.setUint32(4, 36 + 8000, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
        text(36, "data"); view.setUint32(40, 8000, true); bytes.fill(128, 44);
        audioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const element = new Audio(audioUrl);
        element.loop = true; element.setAttribute("playsinline", ""); element.volume = 0.01;
        void element.play().then(() => { audio = element; }).catch(() => { element.src = ""; URL.revokeObjectURL(audioUrl); audioUrl = ""; });
      } catch { /* Optional. */ }
    };

    let noSleep: HTMLVideoElement | null = null;
    let noSleepCanvas: HTMLCanvasElement | null = null;
    const startNoSleep = () => {
      if (disposed || noSleep || "wakeLock" in navigator || document.visibilityState !== "visible") return;
      try {
        noSleepCanvas = document.createElement("canvas"); noSleepCanvas.width = 16; noSleepCanvas.height = 16;
        noSleepCanvas.getContext("2d")?.fillRect(0, 0, 16, 16);
        const video = document.createElement("video");
        video.muted = true; video.loop = true; video.playsInline = true; video.setAttribute("playsinline", "");
        video.style.cssText = "position:fixed;width:1px;height:1px;opacity:.01;pointer-events:none;left:0;top:0";
        video.srcObject = noSleepCanvas.captureStream(1);
        document.body.appendChild(video);
        void video.play().then(() => { noSleep = video; }).catch(() => video.remove());
      } catch { /* Optional. */ }
    };

    const onGesture = () => { startAudio(); startNoSleep(); };
    const onVisible = () => { if (document.visibilityState === "visible") { void audio?.play().catch(() => undefined); void noSleep?.play().catch(() => undefined); } };
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisible);
    room.on(RoomEvent.Connected, onGesture);
    onGesture();
    return () => {
      disposed = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisible);
      room.off(RoomEvent.Connected, onGesture);
      (releaseLock as (() => void) | null)?.();
      if (audio) { audio.pause(); audio.src = ""; }
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (noSleep) { noSleep.pause(); noSleep.srcObject = null; noSleep.remove(); }
    };
  }, [room]);
}

/**
 * Keeps an active LiveKit call usable when the browser backgrounds the page.
 * WebRTC media capture and active real-time connections receive browser-managed
 * treatment, but a page can still be suspended or terminated by the OS. We do
 * not use silent audio as an artificial keep-alive because it cannot guarantee
 * background execution; the screen wake lock above keeps the display on instead.
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
            album: "Live room",
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
      setHandler("togglecamera", () => {
        void room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled).catch(() => undefined);
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

function ConferenceWorkspace({ meeting, role, onLeave, onLeaveClick, onEndForEveryone, ending, isActive }: { meeting: Meeting; role: "host" | "participant"; onLeave: () => void; onLeaveClick?: () => void; onEndForEveryone: () => void; ending: boolean; isActive: boolean }) {
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
  const [hostMenuIdentity, setHostMenuIdentity] = useState<string | null>(null);
  const [personSheetId, setPersonSheetId] = useState<string | null>(null);
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
  const [emojiOrder, setEmojiOrder] = useState<string[]>(() => orderedReactions(readEmojiUsage()));
  const [moreOpen, setMoreOpen] = useState(false);
  useBackClose(moreOpen, () => setMoreOpen(false));
  useBackClose(reactionsOpen, () => setReactionsOpen(false));
  useBackClose(notesOpen, () => setNotesOpen(false));
  useBackClose(messagesOpen, () => setMessagesOpen(false));
  useBackClose(peopleOpen, () => setPeopleOpen(false));
  useBackClose(Boolean(directContact), () => setDirectContact(null));
  const [moreView, setMoreView] = useState<"actions" | "reactions">("actions");
  const [speakerOff, setSpeakerOff] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Record<string, boolean>>({});
  const [handRaised, setHandRaised] = useState(false);
  const [page, setPage] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const [pseudoFull, setPseudoFull] = useState(false);
  const [fullscreenPrompt, setFullscreenPrompt] = useState(false);
  const controlsVisible = true; // the call bar always stays visible, also in fullscreen and when tapping the screen
  const [pageAnim, setPageAnim] = useState<{ dir: "next" | "prev"; n: number }>({ dir: "next", n: 0 });
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const [dockHeight, setDockHeight] = useState(0);
  const dockRef = useRef<HTMLDivElement>(null);
  const fullScreenStateRef = useRef(false);
  const [topSpeaker, setTopSpeaker] = useState("");
  const [messageToast, setMessageToast] = useState<{ id: number; name: string; text: string } | null>(null);
  const [presenceToasts, setPresenceToasts] = useState<Array<{ id: number; kind: "joined" | "left"; name: string; picture: string }>>([]);
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
  useCallWakeLock(room);
  useCallKeepAlive(room);
  const pip = useRoomPictureInPicture(room, meeting.title, onLeave);
  // Back button inside the call: stay in the room and float the call (picture-in-picture) instead of dropping out of it.
  useBackClose(isActive, () => {
    if (document.visibilityState === "hidden") return;
    // Already floating and the person is back in the page: Back returns the call to its normal view.
    if (pip.active) { void pip.exit(); return; }
    void (pip.supported ? pip.enterAuto() : Promise.resolve(false)).then((floated) => {
      if (!floated) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "You're still in the call. Press Home to float it, or use Leave to exit." } }));
    });
  }, true);
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
          pushReaction(`${data.id}-${Math.random().toString(36).slice(2, 6)}`, data.emoji, participant?.name || "A participant");
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

  // Register the logged-in account even when an existing stored LiveKit token is reused after a refresh.
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
    overlayOpenRef.current = messagesOpen || reactionsOpen || deviceMenu !== null || moreOpen || videoQualityMenuOpen;
  }, [messagesOpen, reactionsOpen, deviceMenu, moreOpen, videoQualityMenuOpen]);
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
      const picture = participantPicture(participant.metadata, participant.identity);
      setPresenceToasts((current) => [...current.slice(-2), { id, kind, name, picture }]);
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
    if (!deviceMenu) return;
    const onOutside = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const inside = (name: string) => Boolean(target?.closest(`[data-popover="${name}"]`));
      if (deviceMenu && !inside(deviceMenu)) setDeviceMenu(null);
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [deviceMenu]);

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
        window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: action === "request-unmute" ? "Mic request sent." : "Camera request sent." } }));
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
    setEmojiOrder(orderedReactions(recordEmojiUsage(emoji)));
    const id = `${localIdentity}-${Date.now()}`;
    pushReaction(id, emoji, localParticipant.name || "You");
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
        // Already fullscreen: a tap on the stage never exits it and never hides the call bar (the toggle button does that).
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

  const goToPage = (target: number) => {
    const next = Math.max(0, Math.min(pages - 1, target));
    if (next === currentPage) return;
    setPageAnim((current) => ({ dir: next > currentPage ? "next" : "prev", n: current.n + 1 }));
    setPage(next);
  };
  // Horizontal swipe on the participant area: swipe left for the next screen of people, right for the previous one.
  const onPageTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    swipeStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, t: Date.now() } : null;
  };
  const onPageTouchEnd = (event: ReactTouchEvent) => {
    const start = swipeStart.current; swipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || pages < 2 || screenShare) return;
    const dx = touch.clientX - start.x; const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4 || Date.now() - start.t > 900) return;
    goToPage(currentPage + (dx < 0 ? 1 : -1));
  };
  // Opening any tab (messages, people, notes, a private chat…) closes the emoji picker straight away.
  useEffect(() => { if (messagesOpen || peopleOpen || notesOpen || directContact) setReactionsOpen(false); }, [messagesOpen, peopleOpen, notesOpen, directContact]);
  const openPeopleTab = () => { setPeopleViewTab("people"); setPeopleOpen(true); setMessagesOpen(false); setDirectContact(null); setNotesOpen(false); };
  const copyInviteLink = () => {
    const url = `${window.location.origin}/share/${encodeURIComponent(meeting.slug)}`;
    const done = () => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: `${kindOf(meeting) === "prayer" ? "Prayer" : "Meeting"} link copied.` } }));
    const fallback = () => { try { const box = document.createElement("textarea"); box.value = url; box.style.position = "fixed"; box.style.opacity = "0"; document.body.appendChild(box); box.select(); document.execCommand("copy"); box.remove(); done(); } catch { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: url } })); } };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(fallback); else fallback();
  };

  // Rotating tips: one at a time, spaced out, and only when nothing else needs the person's attention.
  const tipsBusy = messagesOpen || peopleOpen || notesOpen || moreOpen || reactionsOpen || Boolean(deviceMenu) || videoQualityMenuOpen || Boolean(directContact) || Boolean(messageToast) || Boolean(moderatorRequest) || Boolean(privateNotice) || fullscreenPrompt || presenceToasts.length > 0 || Boolean(mediaModal) || Boolean(screenShare);
  const weakNet = useWeakNetworkTip(room);
  const { tip: activeTip, hide: hideTip, dismissForever: dismissTip } = useRoomTips((): RoomTip[] => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    const installEvent = (window as unknown as { __pwaPrompt?: PwaPromptEvent }).__pwaPrompt;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const list: Array<RoomTip | false> = [
      !fullScreen && { id: "fullscreen", text: "Enter full screen for a bigger, cleaner view of the room.", actionLabel: "Enter full screen", onAction: () => void toggleFullscreen() },
      !isMicrophoneEnabled && { id: "mic", text: "Want to speak? Your microphone is off. Turn it on with the microphone button.", actionLabel: "Turn on microphone", onAction: () => void toggleMedia("microphone") },
      pip.supported && !pip.active && { id: "pip", text: "Need another app? Tap PiP at the top to keep the call floating while you use it.", actionLabel: "Float the call", onAction: () => void pip.toggle() },
      !standalone && (Boolean(installEvent) || isIos) && { id: "install", text: installEvent ? "Install MEET ENIHAKOLE for faster joining and a steadier call." : "Install MEET ENIHAKOLE: tap Share in Safari, then Add to Home Screen.", actionLabel: installEvent ? "Install app" : undefined, onAction: installEvent ? () => { void installEvent.prompt().catch(() => undefined); (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = undefined; } : undefined },
      { id: "notes", text: "Write prayer points together in shared Notes. Swipe the call bar to find it.", actionLabel: "Open notes", onAction: () => { setNotesOpen(true); setMessagesOpen(false); setPeopleOpen(false); } },
      { id: "reactions", text: "Send a quick 🙏 or 👏 with the emoji button without interrupting anyone.", actionLabel: "Open reactions", onAction: () => { setMoreOpen(false); setReactionsOpen(true); } },
      role !== "host" && { id: "hand", text: "Swipe the call bar to find Raise hand when you would like to speak." },
      { id: "private", text: "You can send someone a private message from the People tab.", actionLabel: "Open people", onAction: openPeopleTab },
      role === "host" && { id: "invite", text: `Invite others: swipe the call bar and tap the link button to copy the ${kindOf(meeting)} link.`, actionLabel: "Copy link", onAction: copyInviteLink },
    ];
    return list.filter((item): item is RoomTip => Boolean(item));
  }, tipsBusy || weakNet.visible);

  return <div className={`conference-fullscreen-target ${fullScreen ? "is-fullscreen" : ""} ${pseudoFull ? "is-pseudo-fullscreen" : ""} ${fullScreen && controlsVisible ? "controls-shown" : ""}`} data-theme={theme} ref={fullScreenRef} style={{ "--dock-space": controlsVisible ? (fullScreen ? `${dockHeight}px` : `${dockHeight || 110}px`) : "0px", "--dock-h": `${dockHeight || 110}px` } as CSSProperties}>
    <div className="conference-media-area">
      <RoomAudioRenderer muted={speakerOff} />
      <div className="room-top-stack">
        <div className="room-top-bar">
          <div className="room-top-title" title={meeting.title}><span>{meeting.title}</span></div>
          <button type="button" className="room-top-people" onClick={openPeopleTab} aria-label={`${participants.length} ${participants.length === 1 ? "person" : "people"} in the meeting. Open the people list`} title="See who is in the meeting"><Users size={14}/><b>{participants.length}</b><span>{participants.length === 1 ? "person" : "people"}</span></button>
          <button type="button" className={`room-top-pip ${pip.active ? "is-active" : ""}`} onClick={() => { if (!pip.supported) { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Picture-in-picture isn't available in this browser." } })); return; } void pip.toggle(); }} aria-pressed={pip.active} title={pip.active ? "Close the floating window" : "Keep the call floating while you use other apps"}><PictureInPicture2 size={14}/><span>{pip.active ? "Close" : "PiP"}</span></button>
        </div>
        {RECORDING_UI_ENABLED && recordingState && <div className={`meeting-recording-banner meeting-recording-${recordingState.status}`} role="status" aria-live="polite"><span className="meeting-recording-dot"/><b>{recordingState.status === "recording" ? "Recording" : recordingState.status === "consent_pending" ? "Waiting for recording consent" : recordingState.status === "uploading" ? "Saving recording" : recordingState.status === "ready" ? "Recording saved" : recordingState.status === "failed" ? "Recording upload failed" : recordingState.status === "declined" ? "Recording declined" : "Recording"}</b>{recordingState.status === "consent_pending" && <small>{recordingState.consents.filter((item) => item.decision === "accepted").length}/{recordingState.consents.length} approved</small>}{recordingState.status === "uploading" && <><small>{recordingState.uploadProgressPercent || 0}% uploaded</small><span className="meeting-recording-progress"><i style={{ width: `${Math.max(0, Math.min(100, recordingState.uploadProgressPercent || 0))}%` }}/></span></>}</div>}
        {participants.filter((participant) => raisedHands[participant.identity]).map((participant) => <div className="raised-hand-chip" key={participant.identity} title={`${participantName(participant) || "Participant"} raised a hand`}><Hand size={13}/><span>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " (You)" : ""}</span></div>)}
      </div>
      <div className={`participant-grid-wrap no-swipe ${screenShare ? "has-screen-share" : ""}`} onTouchStart={onPageTouchStart} onTouchEnd={onPageTouchEnd} onTouchCancel={() => { swipeStart.current = null; }}>
        {screenShare && <ScreenShareStage key={screenShare.participant.identity} screenShare={screenShare} onStop={() => void toggleScreenShare()} onSwitch={() => void toggleScreenShare(true)}/>}
        <div className={`participant-grid participant-grid-count-${visibleParticipants.length || 1} ${pageAnim.n > 0 ? `page-in-${pageAnim.dir}-${pageAnim.n % 2}` : ""} ${spotlightIdentity && visibleParticipants.some((item) => item.participant.identity === spotlightIdentity) ? "has-spotlight" : ""}`}>
          {visibleParticipants.map(({ participant, trackRef }) => {
            const isHost = getParticipantRole(participant) === "host";
            const hand = Boolean(raisedHands[participant.identity]);
            const speaking = participant.identity === localIdentity ? localVoiceActivity.speaking : participant.isSpeaking;
            const cameraVideoOn = isTrackReference(trackRef!) && Boolean(trackRef!.publication?.track) && !trackRef!.publication?.isMuted;
            return <div className={`participant-card ${speaking && cameraVideoOn ? "participant-speaking" : ""} ${cameraVideoOn ? "participant-cam-on" : "participant-cam-off"} ${isHost ? "participant-host" : ""} ${participant.identity === localIdentity ? "participant-local" : ""} ${participant.identity === spotlightIdentity ? "participant-spotlight" : ""}`} key={participant.identity} onClick={(event) => { if (participant.isLocal) return; if (!(event.target as HTMLElement).closest(".participant-avatar-stack, .participant-name-copy")) return; setPersonSheetId(participant.identity); }}>
              <ParticipantTile trackRef={trackRef!} />
              <ParticipantAvatar trackRef={trackRef!} participant={participant} />
              {isHost && <span className="participant-role-label">HOST</span>}
              <div className="participant-name-overlay"><span className="participant-name-copy" title={participantName(participant) || "Participant"}><b>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " · You" : ""}</b></span><span className="participant-badges"><MicOffBadge participant={participant}/>{hand && <span className="raised-hand-badge" title="Raised hand"><Hand size={15}/></span>}{speaking && <span className="speaker-mic" title="Speaking" aria-label="Speaking"><Mic size={14}/></span>}</span></div>
            </div>;
          })}
        </div>
        <ReactionLayer/>
        {pages > 1 && <ParticipantDots pages={pages} current={currentPage} onSelect={goToPage}/>}
      </div>
      <div id="room-call-controls" className={`room-control-dock rd-dock ${controlsVisible ? "dock-open" : "dock-hidden"}`} ref={dockRef} aria-hidden={!controlsVisible}>
        <RdCarousel
          leave={<RdButton label="Leave the meeting" danger onClick={onLeaveClick ?? onLeave} icon={<RdHangupIcon/>}/>}
          pages={(() => {
            const first: ReactNode[] = [
              <div className="rd-slot" key="mic">
                <RdButton label={isMicrophoneEnabled ? "Turn microphone off" : "Turn microphone on"} on={isMicrophoneEnabled} onClick={() => void toggleMedia("microphone")} icon={<RdMicIcon off={!isMicrophoneEnabled}/>}/>
                <button type="button" data-popover="audioinput" className="rd-chevron" onClick={() => setDeviceMenu(deviceMenu === "audioinput" ? null : "audioinput")} aria-label="Choose microphone" title="Choose microphone"><ChevronDown size={11} strokeWidth={3}/></button>
              </div>,
              <div className="rd-slot" key="speaker"><RdButton label={speakerOff ? "Turn speaker on" : "Turn speaker off"} on={!speakerOff} onClick={() => setSpeakerOff((value) => !value)} icon={<RdSpeakerIcon off={speakerOff}/>}/></div>,
              <div className="rd-slot" key="reactions" data-popover="reactions"><RdButton label="Send a reaction" on={reactionsOpen} onClick={() => { setDeviceMenu(null); setMoreOpen(false); setReactionsOpen((open) => !open); }} icon={<Smile size={26} strokeWidth={2.2}/>} aria-haspopup="dialog" aria-expanded={reactionsOpen}/></div>,
              <div className="rd-slot" key="messages"><RdButton label="Open room messages" on={messagesOpen} onClick={() => { setMessagesOpen(true); setPeopleOpen(false); setDirectContact(null); setNotesOpen(false); }} icon={<MessageCircle size={24} strokeWidth={2.2}/>} badge={chatMessages.length > 0 ? <i className="rd-badge">{chatMessages.length > 99 ? "99+" : chatMessages.length}</i> : null}/></div>,
            ];
            const rest: Array<ReactNode | false> = [
              <div className="rd-slot" key="camera">
                <RdButton label={isCameraEnabled ? "Turn camera off" : "Turn camera on"} on={isCameraEnabled} onClick={() => void toggleMedia("camera")} icon={<RdCameraIcon off={!isCameraEnabled}/>}/>
                <button type="button" data-popover="videoinput" className="rd-chevron" onClick={() => setDeviceMenu(deviceMenu === "videoinput" ? null : "videoinput")} aria-label="Choose camera" title="Choose camera"><ChevronDown size={11} strokeWidth={3}/></button>
              </div>,
              <div className="rd-slot" key="people"><RdButton label="See who is in the meeting" on={peopleOpen} onClick={() => { setPeopleViewTab("people"); setPeopleOpen(true); setMessagesOpen(false); setDirectContact(null); setNotesOpen(false); }} icon={<Users size={24} strokeWidth={2.2}/>} badge={<i className="rd-badge rd-badge-count">{participants.length}</i>}/></div>,
              <div className="rd-slot" key="hand"><RdButton label={handRaised ? "Lower your hand" : "Raise your hand"} on={handRaised} onClick={() => { void toggleHand(); }} icon={<Hand size={24} strokeWidth={2.2}/>}/></div>,
              <div className="rd-slot" key="share"><RdButton label={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"} on={isScreenShareEnabled} onClick={() => { void toggleScreenShare(); }} icon={<RdShareIcon/>}/></div>,
              <div className="rd-slot" key="notes"><RdButton label="Open collaborative meeting notes" onClick={() => { setNotesOpen(true); setMessagesOpen(false); setPeopleOpen(false); setDirectContact(null); }} icon={<FileText size={24} strokeWidth={2.2}/>}/></div>,
              <div className="rd-slot" key="link"><RdButton label={kindOf(meeting) === "prayer" ? "Copy prayer link" : "Copy meeting link"} onClick={copyInviteLink} icon={<Link2 size={24} strokeWidth={2.2}/>}/></div>,
              <div className="rd-slot" key="quality"><RdButton label="Choose camera video quality" on={videoQualityMenuOpen} onClick={() => { setVideoQualityMenuOpen(true); setDeviceMenu(null); }} icon={<Settings2 size={24} strokeWidth={2.2}/>}/></div>,
              RECORDING_UI_ENABLED && role === "host" && <div className="rd-slot" key="record"><RdButton label={recordingState?.status === "recording" ? "Stop audio recording" : recordingState?.status === "failed" && recordingState.canRetry ? "Retry audio upload" : "Start audio-only recording"} on={recordingState?.status === "recording"} disabled={recordingBusy || recordingState?.status === "uploading" || recordingState?.status === "consent_pending"} onClick={() => recordingState?.status === "recording" ? void stopRecording() : recordingState?.status === "uploading" || recordingState?.status === "consent_pending" ? undefined : recordingState?.status === "failed" && recordingState.canRetry ? void retryRecordingUpload() : void startRecording()} icon={recordingBusy ? <LoaderCircle size={24} className="spin"/> : <span className="meeting-recording-dot rd-record-dot"/>}/></div>,
              <div className="rd-slot" key="theme"><RdButton label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"} onClick={() => { toggleTheme(); }} icon={theme === "light" ? <Moon size={24} strokeWidth={2.2}/> : <Sun size={24} strokeWidth={2.2}/>}/></div>,
              <div className="rd-slot" key="fullscreen"><RdButton label={fullScreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => { void toggleFullscreen(); }} icon={fullScreen ? <Minimize2 size={24} strokeWidth={2.2}/> : <Maximize2 size={24} strokeWidth={2.2}/>}/></div>,
              role === "host" && <div className="rd-slot" key="end"><RdButton label="End for everyone" danger disabled={ending} onClick={() => { onEndForEveryone(); }} icon={<X size={24} strokeWidth={2.4}/>}/></div>,
            ];
            const extras = rest.filter((item): item is ReactNode => Boolean(item));
            const sections: ReactNode[][] = [first];
            for (let i = 0; i < extras.length; i += 4) sections.push(extras.slice(i, i + 4));
            return sections;
          })()}/>
      </div>
      {reactionsOpen && <div className="rd-emoji-layer"><div className="rd-emoji-pop" data-popover="reactions" role="group" aria-label="Choose a reaction"><header className="rd-emoji-head"><b>Reactions</b><button type="button" className="rd-emoji-close" onClick={() => setReactionsOpen(false)} aria-label="Close reactions"><X size={16}/></button></header><EmojiRow className="rd-emoji-grid rd-emoji-row">{emojiOrder.map((emoji) => <button type="button" key={emoji} onClick={() => { void react(emoji); }} aria-label={`Send ${emoji}`}><PickerEmoji emoji={emoji}/></button>)}</EmojiRow></div></div>}
      {moreOpen && <div className="rd-more-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoreOpen(false); }}>
        <section className="rd-more-sheet" role="dialog" aria-modal="true" aria-label="More call actions">
          <header className="rd-more-head">{moreView === "reactions" ? <button type="button" className="rd-more-icon" onClick={() => setMoreView("actions")} aria-label="Back to actions"><ArrowLeft size={18}/></button> : <span className="rd-more-grip" aria-hidden="true"/>}<b>{moreView === "reactions" ? "Send a reaction" : "More"}</b><button type="button" className="rd-more-icon" onClick={() => setMoreOpen(false)} aria-label="Close"><X size={18}/></button></header>
          {moreView === "reactions" ? <EmojiRow className="rd-more-emojis rd-emoji-row">{emojiOrder.map((emoji) => <button type="button" key={emoji} onClick={() => { void react(emoji); setMoreOpen(false); }} aria-label={`Send ${emoji}`}><PickerEmoji emoji={emoji}/></button>)}</EmojiRow> : <div className="rd-more-grid">
            <RdButton label={handRaised ? "Lower your hand" : "Raise your hand"} on={handRaised} onClick={() => { void toggleHand(); setMoreOpen(false); }} icon={<Hand size={24} strokeWidth={2.2}/>}/>
            <RdButton label={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"} on={isScreenShareEnabled} onClick={() => { setMoreOpen(false); void toggleScreenShare(); }} icon={<RdShareIcon/>}/>
            <RdButton label="Open collaborative meeting notes" onClick={() => { setMoreOpen(false); setNotesOpen(true); setMessagesOpen(false); setPeopleOpen(false); setDirectContact(null); }} icon={<FileText size={24} strokeWidth={2.2}/>}/>
            <RdButton label={kindOf(meeting) === "prayer" ? "Copy prayer link" : "Copy meeting link"} onClick={() => { setMoreOpen(false); copyInviteLink(); }} icon={<Link2 size={24} strokeWidth={2.2}/>}/>
            <RdButton label="Choose camera video quality" on={videoQualityMenuOpen} onClick={() => { setMoreOpen(false); setVideoQualityMenuOpen(true); setDeviceMenu(null); }} icon={<Settings2 size={24} strokeWidth={2.2}/>}/>
            {RECORDING_UI_ENABLED && role === "host" && <RdButton label={recordingState?.status === "recording" ? "Stop audio recording" : recordingState?.status === "failed" && recordingState.canRetry ? "Retry audio upload" : "Start audio-only recording"} on={recordingState?.status === "recording"} disabled={recordingBusy || recordingState?.status === "uploading" || recordingState?.status === "consent_pending"} onClick={() => recordingState?.status === "recording" ? void stopRecording() : recordingState?.status === "uploading" || recordingState?.status === "consent_pending" ? undefined : recordingState?.status === "failed" && recordingState.canRetry ? void retryRecordingUpload() : void startRecording()} icon={recordingBusy ? <LoaderCircle size={24} className="spin"/> : <span className="meeting-recording-dot rd-record-dot"/>}/>}
            <RdButton label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"} onClick={() => { toggleTheme(); setMoreOpen(false); }} icon={theme === "light" ? <Moon size={24} strokeWidth={2.2}/> : <Sun size={24} strokeWidth={2.2}/>}/>
            <RdButton label={fullScreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => { void toggleFullscreen(); setMoreOpen(false); }} icon={fullScreen ? <Minimize2 size={24} strokeWidth={2.2}/> : <Maximize2 size={24} strokeWidth={2.2}/>}/>
            {role === "host" && <RdButton label="End for everyone" danger disabled={ending} onClick={() => { setMoreOpen(false); onEndForEveryone(); }} icon={<X size={24} strokeWidth={2.4}/>}/>}
          </div>}
        </section>
      </div>}
      {deviceMenu && <DeviceSheet kind={deviceMenu} devices={inputDevices.filter((device) => device.kind === deviceMenu)} activeId={room.getActiveDevice(deviceMenu) || ""} onPick={(id) => void chooseDevice(deviceMenu, id)} onClose={() => setDeviceMenu(null)} onPickOutput={(id) => { void room.switchActiveDevice("audiooutput", id).then(() => setDeviceMenu(null)).catch(() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "This browser could not switch the speaker." } }))); }} activeOutputId={room.getActiveDevice("audiooutput") || ""}/>}
      {videoQualityMenuOpen && <RoomSheet title="Video quality" subtitle="Choose how clearly your camera is sent and received" className="rs-quality" onClose={() => setVideoQualityMenuOpen(false)}>
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
            </RoomSheet>}
    </div>
    {(fullscreenPrompt || moderatorRequest || privateNotice || presenceToasts.length > 0 || messageToast || activeTip || weakNet.visible) && <div className="room-bottom-notifications" aria-live="polite">
      {fullscreenPrompt && !fullScreen && <div className="fullscreen-fallback-prompt" role="status"><span>Fullscreen needs your permission. Tap once to enter.</span><button type="button" onClick={() => void toggleFullscreen()}>Enter fullscreen <Maximize2 size={15}/></button></div>}
      {moderatorRequest && <div className="moderator-request-banner" role="status"><span>{moderatorRequest.hostName}: turn on your {moderatorRequest.media === "microphone" ? "mic" : "camera"}?</span><button type="button" onClick={() => void acceptModeratorRequest()}>Allow</button><button type="button" className="request-dismiss" onClick={() => setModeratorRequest(null)} aria-label="Dismiss request"><X size={15}/></button></div>}
      {privateNotice && <div className="room-private-notice" role="status"><span className="room-message-toast-icon"><MessageCircle size={16}/></span><span className="room-private-body"><b>{privateNotice.name}</b><span>Sent you a private message</span></span><button type="button" onClick={() => openPrivateContact(privateNotice)}>Open chat</button><button type="button" className="notice-dismiss" onClick={() => setPrivateNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}
      {presenceToasts.length > 0 && <div className="room-presence-stack" aria-live="polite">{presenceToasts.map((toast) => <div className={`room-presence-toast room-presence-${toast.kind}`} key={toast.id} role="status"><ProfilePhoto src={toast.picture} name={toast.name} size={96} className="room-presence-avatar"/><span className="room-presence-text"><b>{toast.name}</b> {toast.kind === "joined" ? "joined the meeting" : "left the meeting"}</span></div>)}</div>}
      {messageToast && <button type="button" className="room-message-toast" key={messageToast.id} onClick={() => { setMessagesOpen(true); setPeopleOpen(false); }} aria-label={`Open message from ${messageToast.name}`}><span className="room-message-toast-icon"><MessageCircle size={16}/></span><span className="room-message-toast-body"><b>{messageToast.name}</b><span>{messageToast.text}</span></span></button>}
      {weakNet.visible && <RoomTipCard tip={weakNet.tip} onHide={weakNet.hide} onDismissForever={weakNet.dismissForever}/>}
      {activeTip && !messageToast && <RoomTipCard tip={activeTip} onHide={hideTip} onDismissForever={dismissTip}/>}
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
    {messagesOpen && <div className="messages-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMessagesOpen(false); }}><section className="messages-modal" role="dialog" aria-modal="true" aria-label="Meeting messages"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div className="meeting-panel-heading"><b>Meeting messages</b><small>Chat with everyone in this room</small></div><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Close messages"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className="meeting-panel-tab meeting-panel-tab-active" aria-current="page">Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setPeopleViewTab("people"); setPeopleOpen(true); }}>People</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setPeopleViewTab("private"); setPeopleOpen(true); }}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setMessagesOpen(false); setNotesOpen(true); }}>Notes</button></nav><div className="messages-modal-body">{chatMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No messages yet</b><span>Send a note to everyone in this {kindOf(meeting)}.</span></div> : chatMessages.map((message, index) => {
          const own = message.from?.identity === localIdentity;
          const senderName = message.from?.name || (own ? "You" : "Choir guest");
          const nextSender = chatMessages[index + 1]?.from?.identity;
          const showAvatar = nextSender === undefined || nextSender !== message.from?.identity;
          return <div className={`chat-row ${own ? "chat-row-own" : ""}`} key={`${message.timestamp}-${index}`}>{showAvatar ? <ProfilePhoto src={message.from ? participantPicture(message.from.metadata, message.from.identity) : ""} name={message.from ? participantName(message.from) || senderName : senderName} size={96} className="chat-avatar"/> : <span className="chat-avatar-spacer" aria-hidden="true"/>}<article className={`chat-message ${own ? "chat-message-own" : ""}`}><span className="chat-message-author">{senderName}</span><p>{message.message}</p><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article></div>;
        })}<div ref={chatEndRef}/></div><form className="messages-composer" onSubmit={sendMessage}><input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message…" maxLength={2000} aria-label="Message"/><button className="button button-primary" type="submit" disabled={!messageText.trim() || isSending} aria-label="Send message"><Send size={17}/></button></form></section></div>}
    {peopleOpen && <div className="messages-modal-backdrop people-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPeopleOpen(false); }}><section className="messages-modal people-modal" role="dialog" aria-modal="true" aria-label="People and private chats"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setPeopleOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div className="meeting-panel-heading"><b>{peopleViewTab === "people" ? "People" : "Private chats"}</b><small>{peopleViewTab === "people" ? `${participants.length} currently online · presence updates live` : `${recentConversations.length} saved conversations`}</small></div><button className="room-icon-button" onClick={() => setPeopleOpen(false)} aria-label="Close people"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className={`meeting-panel-tab ${peopleViewTab === "people" ? "meeting-panel-tab-active" : ""}`} aria-current={peopleViewTab === "people" ? "page" : undefined} onClick={() => setPeopleViewTab("people")}>People</button><button type="button" className={`meeting-panel-tab ${peopleViewTab === "private" ? "meeting-panel-tab-active" : ""}`} aria-current={peopleViewTab === "private" ? "page" : undefined} onClick={() => setPeopleViewTab("private")}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setPeopleOpen(false); setMessagesOpen(true); }}>Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setPeopleOpen(false); setNotesOpen(true); }}>Notes</button></nav><div className="people-directory-body">{peopleViewTab === "people" ? <><div className="people-online-heading"><span><span className="people-online-dot"/> Online now</span><b>{participants.length}</b></div>{[...participants].sort((a, b) => getParticipantRole(a) === getParticipantRole(b) ? participantName(a).localeCompare(participantName(b)) : getParticipantRole(a) === "host" ? -1 : 1).map((person) => {
      const isSelf = person.identity === localIdentity;
      const micMuted = person.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true;
      const cameraMuted = person.getTrackPublication(Track.Source.Camera)?.isMuted ?? true;
      const isHostPerson = getParticipantRole(person) === "host";
      return <article className="people-person-row" key={person.identity}><ProfilePhoto src={participantPicture(person.metadata, person.identity)} name={participantName(person)} size={128} className="people-person-avatar"/><div className="people-person-details"><div className="people-person-title"><b>{participantName(person) || "Participant"}{isSelf ? " · You" : ""}</b>{isHostPerson && <span className="people-host-tag">HOST</span>}</div><small><span className="people-online-dot"/> Connected {person.isSpeaking ? "· Speaking" : ""}{micMuted ? " · Mic off" : " · Mic on"}{cameraMuted ? " · Camera off" : " · Camera on"}</small></div>{!isSelf && <div className="people-person-actions"><button type="button" onClick={() => void focusParticipant(person.identity)} title={spotlightIdentity === person.identity ? "Clear participant focus" : "Bring participant into the main view"}>{spotlightIdentity === person.identity ? "Unfocus" : "Focus"}</button><button type="button" onClick={() => openPrivateConversation(person)} title={`Private message ${participantName(person) || "participant"}`}><MessageCircle size={15}/><span>Message</span></button>{role === "host" && !isHostPerson && <button type="button" className="people-more-trigger" onClick={() => setHostMenuIdentity(person.identity)} aria-haspopup="dialog" aria-label={`Host actions for ${participantName(person) || "participant"}`} title="Host actions"><ChevronDown size={16}/></button>}</div>}{isSelf && <span className="people-you-tag">You</span>}</article>;
    })}{participants.length === 1 && <div className="people-alone-note">You are the only person connected right now.</div>}</> : <section className="people-recent-conversations"><div className="people-recent-heading">Saved private conversations</div>{recentConversations.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No private conversations yet</b><span>Start a one-to-one conversation from the People tab.</span></div> : recentConversations.map((contact) => {
      const online = participants.some((person) => participantUserId(person) === contact.userId);
      return <button type="button" className="people-recent-row" key={contact.userId} onClick={() => openPrivateContact({ userId: contact.userId, identity: "", name: contact.name, picture: contact.picture })}><ProfilePhoto src={contact.picture} name={contact.name} size={96} className="people-person-avatar"/><span className="people-recent-copy"><b>{contact.name}</b><small>{contact.lastMessage}</small></span><span className={`people-recent-status ${online ? "is-online" : ""}`}>{online ? "Online" : "Saved"}</span></button>;
    })}</section>}</div></section></div>}
    {role === "host" && hostMenuIdentity && (() => {
      const target = participants.find((item) => item.identity === hostMenuIdentity);
      if (!target || target.isLocal) return null;
      const targetName = participantName(target) || "Participant";
      const micMuted = target.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true;
      const cameraMuted = target.getTrackPublication(Track.Source.Camera)?.isMuted ?? true;
      const busy = moderationBusy === target.identity;
      const act = (action: "mute-mic" | "disable-camera" | "remove" | "ban" | "request-unmute" | "request-camera") => { setHostMenuIdentity(null); void moderateParticipant(target, action); };
      return <RoomSheet title={targetName} subtitle="Host actions" className="rs-host-actions" onClose={() => setHostMenuIdentity(null)}>
        <div className="host-actions-list">
          <button type="button" className="rs-option" disabled={busy} onClick={() => act(micMuted ? "request-unmute" : "mute-mic")}><span className="rs-option-icon">{micMuted ? <Mic size={16}/> : <MicOff size={16}/>}</span><span className="rs-option-label">{micMuted ? "Request microphone" : "Mute microphone"}</span></button>
          <button type="button" className="rs-option" disabled={busy} onClick={() => act(cameraMuted ? "request-camera" : "disable-camera")}><span className="rs-option-icon">{cameraMuted ? <Video size={16}/> : <VideoOff size={16}/>}</span><span className="rs-option-label">{cameraMuted ? "Request camera" : "Disable camera"}</span></button>
          <button type="button" className="rs-option host-action-danger" disabled={busy} onClick={() => act("remove")}><span className="rs-option-icon"><LogOut size={16}/></span><span className="rs-option-label">Remove from meeting</span></button>
          <button type="button" className="rs-option host-action-danger" disabled={busy} onClick={() => act("ban")}><span className="rs-option-icon"><X size={16}/></span><span className="rs-option-label">Remove and block re-entry</span></button>
        </div>
      </RoomSheet>;
    })()}
    {personSheetId && (() => {
      const target = participants.find((item) => item.identity === personSheetId);
      if (!target || target.isLocal) return null;
      const targetName = participantName(target) || "Participant";
      const targetHost = getParticipantRole(target) === "host";
      const canMessage = Boolean(participantUserId(target));
      const micMuted = target.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true;
      const cameraMuted = target.getTrackPublication(Track.Source.Camera)?.isMuted ?? true;
      const busy = moderationBusy === target.identity;
      const closeSheet = () => setPersonSheetId(null);
      const act = (action: "mute-mic" | "disable-camera" | "remove" | "ban" | "request-unmute" | "request-camera") => { closeSheet(); void moderateParticipant(target, action); };
      return <RoomSheet title={targetName} subtitle={targetHost ? "Host" : "Participant"} className="rs-host-actions rs-person-actions" onClose={closeSheet}>
        <div className="person-sheet-hero"><ProfilePhoto src={participantPicture(target.metadata, target.identity)} name={targetName} size={192} className="person-sheet-avatar"/><span><b>{targetName}</b><small>{micMuted ? "Mic off" : "Mic on"} · {cameraMuted ? "Camera off" : "Camera on"}</small></span></div>
        <div className="host-actions-list">
          {canMessage && <button type="button" className="rs-option" onClick={() => { closeSheet(); void openPrivateConversation(target); }}><span className="rs-option-icon"><MessageCircle size={16}/></span><span className="rs-option-label">Message privately</span></button>}
          <button type="button" className="rs-option" onClick={() => { closeSheet(); focusParticipant(target.identity); }}><span className="rs-option-icon"><Users size={16}/></span><span className="rs-option-label">{spotlightIdentity === target.identity ? "Clear focus" : "Bring into main view"}</span></button>
          {role === "host" && !targetHost && <>
            <button type="button" className="rs-option" disabled={busy} onClick={() => act(micMuted ? "request-unmute" : "mute-mic")}><span className="rs-option-icon">{micMuted ? <Mic size={16}/> : <MicOff size={16}/>}</span><span className="rs-option-label">{micMuted ? "Request microphone" : "Mute microphone"}</span></button>
            <button type="button" className="rs-option" disabled={busy} onClick={() => act(cameraMuted ? "request-camera" : "disable-camera")}><span className="rs-option-icon">{cameraMuted ? <Video size={16}/> : <VideoOff size={16}/>}</span><span className="rs-option-label">{cameraMuted ? "Request camera" : "Disable camera"}</span></button>
            <button type="button" className="rs-option host-action-danger" disabled={busy} onClick={() => act("remove")}><span className="rs-option-icon"><LogOut size={16}/></span><span className="rs-option-label">Remove from meeting</span></button>
            <button type="button" className="rs-option host-action-danger" disabled={busy} onClick={() => act("ban")}><span className="rs-option-icon"><X size={16}/></span><span className="rs-option-label">Remove and block re-entry</span></button>
          </>}
        </div>
      </RoomSheet>;
    })()}
    {directContact && <div className="messages-modal-backdrop private-chat-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDirectContact(null); }}><section className="messages-modal private-chat-modal" role="dialog" aria-modal="true" aria-label={`Private conversation with ${directContact.name}`}><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setDirectContact(null)} aria-label="Back to call"><ArrowLeft size={18}/></button><ProfilePhoto src={directContact.picture} name={directContact.name} size={64} className="private-chat-avatar"/><div className="meeting-panel-heading"><b>{directContact.name}</b><small>Private one-to-one conversation</small></div><button className="room-icon-button" onClick={() => setDirectContact(null)} aria-label="Close private messages"><X size={18}/></button></header><nav className="meeting-panel-tabs" aria-label="Meeting tools"><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setPeopleViewTab("people"); setPeopleOpen(true); }}>People</button><button type="button" className="meeting-panel-tab meeting-panel-tab-active" aria-current="page" onClick={() => { setDirectContact(null); setPeopleViewTab("private"); setPeopleOpen(true); }}>Private chats</button><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setMessagesOpen(true); }}>Messages</button><button type="button" className="meeting-panel-tab" onClick={() => { setDirectContact(null); setNotesOpen(true); }}>Notes</button></nav><div className="messages-modal-body private-chat-body">{privateLoading ? <div className="messages-empty"><LoaderCircle size={23} className="spin"/><span>Loading private conversation…</span></div> : privateMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No private messages yet</b><span>Only you and {directContact.name} can see this conversation.</span></div> : privateMessages.map((message, index) => {
          const own = message.senderUserId === localUserId;
          const showAvatar = privateMessages[index + 1]?.senderUserId !== message.senderUserId;
          return <div className={`chat-row ${own ? "chat-row-own" : ""}`} key={message.id}>{showAvatar ? <ProfilePhoto src={own ? participantPicture(room.localParticipant.metadata, localIdentity) : directContact.picture} name={own ? participantName(room.localParticipant) || "You" : message.senderName || directContact.name} size={96} className="chat-avatar"/> : <span className="chat-avatar-spacer" aria-hidden="true"/>}<article className={`chat-message ${own ? "chat-message-own" : ""}`}><span className="chat-message-author">{own ? "You" : message.senderName}</span><p>{message.message}</p><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article></div>;
        })}<div ref={privateChatEndRef}/></div><form className="messages-composer" onSubmit={sendPrivateMessage}><input value={privateDraft} onChange={(event) => setPrivateDraft(event.target.value)} placeholder={`Message ${directContact.name} privately…`} maxLength={2000} aria-label="Private message"/><button className="button button-primary" type="submit" disabled={!privateDraft.trim() || privateSending || privateLoading} aria-label="Send private message">{privateSending ? <LoaderCircle size={17} className="spin"/> : <Send size={17}/>}</button></form></section></div>}
    {role === "host" && <span className="room-host-sr" aria-hidden="true">{meeting.ownerName} is hosting</span>}
  </div>;
}

/** Shown when someone presses Join without being identified: a centred dialog on desktop and a bottom sheet on phones (shared Modal), so they can pick Google or Guest straight away. */
function JoinIdentityModal({ onClose, onGoogleCredential, onGuest }: { onClose: () => void; onGoogleCredential: (credential: string) => Promise<void>; onGuest: () => void }) {
  return <Modal onClose={onClose} wide={false}>
    <div className="auth-modal-content join-identity-modal">
      <span className="modal-brand-icon"><AudioLines size={23}/></span>
      <p className="section-overline">ONE QUICK STEP</p>
      <h2>How would you like to join?</h2>
      <p className="modal-subtitle">Continue with Google, or join as a guest with just your name.</p>
      <div className="form-stack">
        <GoogleContinueButton onCredential={(credential) => void onGoogleCredential(credential)}/>
        <div className="guest-access-divider"><span>OR</span></div>
        <button type="button" className="guest-continue-button" onClick={onGuest}><UserRound size={18}/><span>Continue as Guest</span></button>
      </div>
      <p className="auth-legal"><ShieldCheck size={13}/> Guest access is limited to this meeting.</p>
    </div>
  </Modal>;
}

/** Switch profile for a logged-in person: pick another Google account or continue as a guest. Closing it changes nothing, so the current account stays logged in. */
function SwitchProfileModal({ user, error, onClose, onGoogleCredential, onGuest }: { user: User; error: string; onClose: () => void; onGoogleCredential: (credential: string) => Promise<void>; onGuest: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Modal onClose={onClose} wide={false}>
    <div className="auth-modal-content join-identity-modal">
      <span className="modal-brand-icon"><Repeat size={22}/></span>
      <p className="section-overline">SWITCH PROFILE</p>
      <h2>Who is joining?</h2>
      <p className="modal-subtitle">Choose another Google account or join as a guest. Close this and you stay logged in as {user.displayName}.</p>
      <div className="join-identity switch-profile-current"><ProfilePhoto src={user.picture} name={user.displayName} className="join-identity-photo"/><span><b>{user.displayName}</b><small>{user.email} · current</small></span></div>
      <div className="form-stack">
        <GoogleContinueButton onCredential={(credential) => { setBusy(true); void onGoogleCredential(credential).finally(() => setBusy(false)); }}/>
        {busy && <div className="auth-busy"><LoaderCircle size={16} className="spin"/> Switching…</div>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="guest-access-divider"><span>OR</span></div>
        <button type="button" className="guest-continue-button" onClick={onGuest}><UserRound size={18}/><span>Continue as Guest</span></button>
      </div>
      <p className="auth-legal"><ShieldCheck size={13}/> Your current account is only left once the new profile is ready.</p>
    </div>
  </Modal>;
}

/** Asks a guest for first and last name (one field each). Works as a bottom sheet on phones through the shared Modal. */
function GuestNameModal({ initialName, onClose, onSave }: { initialName: string; onClose: () => void; onSave: (displayName: string) => Promise<void> }) {
  const parts = initialName.trim().split(/\s+/).filter(Boolean);
  const [firstName, setFirstName] = useState(parts[0] || "");
  const [lastName, setLastName] = useState(parts.slice(1).join(" "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const clean = (value: string) => value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const fullName = [clean(firstName), clean(lastName)].filter(Boolean).join(" ");
  const ready = Boolean(clean(firstName)) && Boolean(clean(lastName));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true); setError("");
    try { await onSave(fullName); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your name. Please try again."); setSaving(false); }
  }
  return <Modal onClose={onClose} wide={false}>
    <form className="auth-modal-content guest-modal-content" onSubmit={(event) => void submit(event)} noValidate>
      <div className="guest-modal-avatar-slot" aria-hidden="true">{clean(firstName) ? <ProfilePhoto key={Array.from(clean(firstName))[0]?.toUpperCase()} name={clean(firstName)} className="guest-modal-avatar" size={160}/> : null}</div>
      <p className="section-overline">CONTINUE AS GUEST</p>
      <h2>What should we call you?</h2>
      <p className="modal-subtitle">Your name is shown to everyone in the room. No account or email is required.</p>
      <div className="guest-modal-fields">
        <label htmlFor="guest-first-name"><span>First name</span><input id="guest-first-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="e.g. Mugisha" autoComplete="given-name" maxLength={40} autoFocus/></label>
        <label htmlFor="guest-last-name"><span>Last name</span><input id="guest-last-name" value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="e.g. Chretien" autoComplete="family-name" maxLength={40}/></label>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button type="submit" className="button button-primary button-full guest-modal-save" disabled={!ready || saving}>{saving ? <><LoaderCircle size={16} className="spin"/> Saving…</> : "Save"}</button>
      <p className="auth-legal"><ShieldCheck size={13}/> Guest access is limited to this meeting.</p>
    </form>
  </Modal>;
}

function AuthModal({ onClose, onAuthenticated, currentName }: { onClose: () => void; onAuthenticated: (user: User, token: string) => void; currentName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleCredential(credential: string) {
    setBusy(true); setError("");
    try {
      const result = await api.googleSignIn(credential);
      await preloadPhotoBriefly(result.user.picture, 512, 1200);
      onAuthenticated(result.user, result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not log in with Google.");
    } finally { setBusy(false); }
  }

  return <Modal onClose={onClose} wide={false}>
    <div className="auth-modal-content"><span className="modal-brand-icon"><AudioLines size={23}/></span><p className="section-overline">WELCOME TO MEET ENIHAKOLE</p><h2>{currentName ? "Change account" : "Good to have you here."}</h2><p className="modal-subtitle">{currentName ? "Choose another Google account to switch. Until then you stay logged in as the current account — closing this keeps everything as it is." : "Continue with Google to log in or create your account. We use your Google name and profile photo — no password needed."}</p>
      <div className="form-stack">
        <GoogleContinueButton onCredential={(credential) => void handleCredential(credential)}/>
        {busy && <div className="auth-busy"><LoaderCircle size={16} className="spin"/> Logging you in…</div>}
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
    if (!meetingType) { setStep(1); setError("Choose whether this is a prayer or a meeting."); return; }
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
      setError(cause instanceof Error ? cause.message : `Could not create this ${meetingType === "prayer" ? "prayer" : "meeting"}.`);
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
        <p className="section-overline">{meetingType === "prayer" ? "CREATE A PRAYER" : meetingType === "meeting" ? "CREATE A MEETING" : "CREATE A PRAYER OR MEETING"}</p>
        <h2>{step === 1 ? "What would you like to create?" : step === 2 ? (meetingType === "prayer" ? "Describe your Online Prayer." : "Give your meeting a name.") : "Choose when to meet."}</h2>
        <p className="modal-subtitle">{step === 1 ? "Choose whether to create a prayer or a meeting." : step === 2 ? "Add a clear title and a short description for participants." : "Set the date, time, and planned duration. Joining opens automatically at the scheduled start."}</p>
        {step === 1 && <div className="gathering-type-options" role="group" aria-label="Session type">
          <button type="button" className={`gathering-type-card ${meetingType === "meeting" ? "is-selected" : ""}`} aria-pressed={meetingType === "meeting"} onClick={() => { setMeetingType("meeting"); setError(""); }}><span><Users size={22}/></span><b>Meeting</b><small>Private meeting accessible through its invitation link.</small></button>
          <button type="button" className={`gathering-type-card ${meetingType === "prayer" ? "is-selected" : ""}`} aria-pressed={meetingType === "prayer"} onClick={() => { setMeetingType("prayer"); setError(""); }}><span><HeartHandshake size={22}/></span><b>Online Prayer</b><small>Publicly discoverable before, during, and after the prayer.</small></button>
        </div>}
        {step === 2 && <div className="form-stack schedule-form">
          <label className="field-label">{meetingType === "prayer" ? "Prayer title" : "Meeting title"}<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder={meetingType === "prayer" ? "e.g. Wednesday morning prayer" : "e.g. Choir planning meeting"} required autoFocus/></label>
          <label className="field-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} minLength={3} maxLength={1000} placeholder="Describe the purpose of this session and what participants can expect." required/></label>
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
    </div> : <div className="schedule-success"><div className="modal-scroll-body"><span className="success-icon"><CheckCircle2 size={27}/></span><p className="section-overline">YOUR INVITATION IS READY</p><h2>It's all set.</h2><p className="modal-subtitle">{created.meeting.meetingType === "prayer" ? "Your Online Prayer is listed publicly. Share the invitation too." : "Your private meeting is ready. Only people with this invitation link can open it."}</p><div className="success-meeting-preview"><img src={meetingImage(created.meeting)} alt="Meeting cover"/><div><b>{created.meeting.title}</b><small>{formatDate(created.meeting.startsAt, {}, created.meeting.timezone)} · {created.meeting.durationMinutes} min</small></div></div><div className="share-url-box"><Link2 size={15}/><span>{created.shareUrl}</span><button className="icon-button" onClick={copyShare} aria-label="Copy link"><Copy size={15}/></button></div></div><div className="success-actions modal-footer-fixed"><button className="button button-primary button-full" onClick={() => void shareMeeting()}><Share2 size={16}/> Share invitation</button><Link className="button button-soft button-full" to={`/meeting/${created.meeting.slug}`} onClick={onClose}>Open {meetingType === "prayer" ? "prayer" : "meeting"} page <ArrowRight size={16}/></Link><button className="text-action centered-action" onClick={onClose}>Back to workspace</button></div></div>}
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
  useBackClose(true, requestClose);

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
  const [tip, setTip] = useState<{ message: string; id: number } | null>(null);
  useEffect(() => {
    let timer = 0;
    const onTip = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      setTip({ message: detail.message, id: Date.now() });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTip(null), 9000);
    };
    window.addEventListener("meet-tip", onTip);
    return () => { window.clearTimeout(timer); window.removeEventListener("meet-tip", onTip); };
  }, []);
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
  const tipNode = tip && portalTarget ? createPortal(<div className="global-tip-lane" key={tip.id}><div className="room-tip global-tip" role="status"><span className="room-tip-icon"><Lightbulb size={16}/></span><span className="room-tip-body"><span className="room-tip-text">{tip.message}</span></span><button type="button" className="room-tip-close" onClick={() => setTip(null)} aria-label="Dismiss tip"><X size={14}/></button></div></div>, portalTarget) : null;
  if ((!toast || !portalTarget) && !tipNode) return null;
  if (!toast || !portalTarget) return tipNode;
  return <>{tipNode}{createPortal(<div className="toast-message" role="status"><span className="toast-check"><Check size={15}/></span><span>{toast.message}</span>{toast.action && toast.shareUrl && <button onClick={() => void navigator.clipboard.writeText(toast.shareUrl!)}>{toast.action}</button>}<button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14}/></button></div>, portalTarget)}</>;
}
