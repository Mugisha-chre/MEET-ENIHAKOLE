import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AudioLines, CalendarCheck, CalendarX, LoaderCircle, Pause, Play, RefreshCw, Volume2, VolumeX } from "lucide-react";
import { api, getAuthToken } from "./api";
import { ProfilePhoto } from "./google";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { patchCache, readCache, writeCache } from "./cache";

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function duration(seconds: number) {
  if (!seconds || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatBytes(bytes: number) {
  if (!bytes || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function AudioRecordingPlayer({ src, title }: { src: string; title: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durationValue, setDurationValue] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [playError, setPlayError] = useState("");
  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    setPlayError("");
    if (audio.paused) {
      try { await audio.play(); setPlaying(true); }
      catch { setPlayError("Playback was blocked. Tap play again or check your device audio settings."); }
    } else { audio.pause(); setPlaying(false); }
  }
  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(value)) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }
  function setAudioVolume(value: number) {
    const next = Math.max(0, Math.min(1, value));
    setVolume(next);
    if (audioRef.current) audioRef.current.volume = next;
  }
  return <section className="audio-recording-player" aria-label={`Audio player for ${title}`}>
    <audio ref={audioRef} src={src} preload="metadata" onLoadedMetadata={(event) => setDurationValue(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onDurationChange={(event) => setDurationValue(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setPlayError("This audio file could not be loaded. Close the player and try again."); }}/>
    <button type="button" className="audio-player-play" onClick={() => void toggle()} aria-label={playing ? "Pause recording" : "Play recording"}>{playing ? <Pause size={19} fill="currentColor"/> : <Play size={19} fill="currentColor"/>}</button>
    <div className="audio-player-timeline"><div className="audio-player-title"><b>{title}</b><span>{formatAudioTime(currentTime)} / {formatAudioTime(durationValue)}</span></div><input aria-label="Recording timeline" type="range" min={0} max={Math.max(1, durationValue)} step={0.1} value={Math.min(currentTime, durationValue || 0)} onChange={(event) => seek(Number(event.target.value))} style={{ "--audio-progress": `${durationValue > 0 ? currentTime / durationValue * 100 : 0}%` } as CSSProperties}/></div>
    <label className="audio-player-volume" title="Volume"><Volume2 size={17}/><input aria-label="Playback volume" type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => setAudioVolume(Number(event.target.value))}/></label>
    {playError && <span className="audio-player-error" role="alert">{playError}</span>}
  </section>;
}

// Compact in-card controls (volume · timeline · play/pause) that replace the Listen button
// on the exact recording card the person opened. Loads and starts playing automatically.
function RecordingCardControls({ src, title, durationHint, onPlayingChange }: { src: string; title: string; durationHint: number; onPlayingChange?: (playing: boolean) => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durationValue, setDurationValue] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [playError, setPlayError] = useState("");
  useEffect(() => { onPlayingChange?.(playing); }, [playing, onPlayingChange]);
  useEffect(() => () => onPlayingChange?.(false), [onPlayingChange]);
  const total = durationValue > 0 ? durationValue : Math.max(0, durationHint || 0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0.9;
    audio.play().then(() => setPlaying(true)).catch(() => setPlayError("Tap play to start listening."));
  }, [src]);
  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    setPlayError("");
    if (audio.paused) {
      try { await audio.play(); setPlaying(true); }
      catch { setPlayError("Playback was blocked. Tap play again or check your device audio settings."); }
    } else { audio.pause(); setPlaying(false); }
  }
  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(value)) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }
  function changeVolume(value: number) {
    const next = Math.max(0, Math.min(1, value));
    setVolume(next);
    if (audioRef.current) audioRef.current.volume = next;
  }
  const readDuration = (audio: HTMLAudioElement) => setDurationValue(Number.isFinite(audio.duration) ? audio.duration : 0);
  return <div className="audio-card-controls" aria-label={`Audio controls for ${title}`}>
    <audio ref={audioRef} src={src} preload="auto" onLoadedMetadata={(event) => readDuration(event.currentTarget)} onDurationChange={(event) => readDuration(event.currentTarget)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setPlayError("This audio file could not be loaded. Try Listen again."); }}/>
    <div className="audio-card-volume">
      <button type="button" className="audio-card-round" onClick={() => setVolumeOpen((open) => !open)} aria-label="Volume" aria-expanded={volumeOpen}>{volume === 0 ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button>
      {volumeOpen && <div className="audio-card-volume-pop"><input aria-label="Playback volume" type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => changeVolume(Number(event.target.value))} style={{ "--audio-progress": `${volume * 100}%` } as CSSProperties}/></div>}
    </div>
    <div className="audio-card-timeline">
      <input aria-label="Recording timeline" type="range" min={0} max={Math.max(1, total)} step={0.1} value={Math.min(currentTime, total || 0)} onChange={(event) => seek(Number(event.target.value))} style={{ "--audio-progress": `${total > 0 ? Math.min(100, currentTime / total * 100) : 0}%` } as CSSProperties}/>
      <span>{formatAudioTime(currentTime)} / {formatAudioTime(total)}</span>
    </div>
    <button type="button" className="audio-card-round" onClick={() => void toggle()} aria-label={playing ? "Pause recording" : "Play recording"}>{playing ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>
    {playError && <span className="audio-card-error" role="alert">{playError}</span>}
  </div>;
}

// Skeleton shaped like a recording card, shown while recordings load and until a card scrolls into view.
function AudioCardSkeleton() {
  return <article className="management-recording-card audio-recording-card audio-card-skeleton" aria-hidden="true"><div className="audio-card-stage"><span className="audio-card-ring audio-card-ring-1"/><span className="audio-card-ring audio-card-ring-2"/><div className="audio-card-body"><span className="audio-skel audio-skel-icon"/><span className="audio-skel audio-skel-kind"/><span className="audio-skel audio-skel-title"/><span className="audio-skel audio-skel-line"/><span className="audio-skel audio-skel-line audio-skel-line-short"/><span className="audio-skel audio-skel-line"/></div><div className="audio-card-actions audio-card-actions-skel"><div className="audio-card-controls audio-card-controls-skel"><span className="audio-skel audio-skel-round"/><div className="audio-card-timeline"><span className="audio-skel audio-skel-track"/><span className="audio-skel audio-skel-time"/></div><span className="audio-skel audio-skel-round"/></div></div></div></article>;
}

// Mounts its children only once they are about to scroll into view (lazy loading); a skeleton holds the space until then.
function LazyMount({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return <div className="lazy-mount" ref={ref}>{visible ? children : fallback}</div>;
}

// Signed playback links stay valid for a while, so reopening a recording reuses the last one instead of asking the server again.
const playbackCache = new Map<string, { url: string; expiresAt: number }>();

export function RecordingsPage() {
  // Cache-first: saved recordings paint instantly (keyed per signed-in account), then the list refreshes quietly in the background.
  const cacheKey = `recordings:${(getAuthToken() || "").slice(-12) || "public"}`;
  const [recordings, setRecordings] = useState<any[]>(() => readCache<any[]>(cacheKey)?.value ?? []);
  const [loading, setLoading] = useState(() => !readCache(cacheKey));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const handlePlayingChange = useCallback((value: boolean) => setAudioPlaying(value), []);

  const load = useCallback(async () => {
    const cached = readCache<any[]>(cacheKey);
    if (!cached) setLoading(true);
    setRefreshing(true);
    try {
      const [publicResult, privateResult] = await Promise.all([
        api.publicPrayerRecordings(),
        getAuthToken() ? api.myRecordings().catch(() => ({ recordings: [] })) : Promise.resolve({ recordings: [] }),
      ]);
      const combined = [...privateResult.recordings.map((item) => ({ ...item, public: Boolean((item as any).public), meetingType: (item as any).meetingType || "meeting" })), ...publicResult.recordings];
      const unique = combined.filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index);
      unique.sort((a, b) => new Date(b.endedAt || b.startedAt || 0).getTime() - new Date(a.endedAt || a.startedAt || 0).getTime());
      writeCache(cacheKey, unique);
      setRecordings((current) => sameData(current, unique) ? current : unique);
      setError("");
    } catch (cause) { if (!cached) setError(messageOf(cause, "Could not load audio recordings.")); }
    finally { setLoading(false); setRefreshing(false); }
  }, [cacheKey]);
  useEffect(() => { void load(); }, [load]);

  async function play(item: any) {
    setError("");
    const saved = playbackCache.get(item.id);
    if (saved && saved.expiresAt > Date.now()) { setPlayingId(item.id); setPlaybackUrl(saved.url); return; }
    setBusyId(item.id);
    try {
      const result = await api.recordingPlayback(item.id, item.public ? undefined : item.meetingSlug);
      playbackCache.set(item.id, { url: result.playbackUrl, expiresAt: Date.now() + Math.max(30, (result.expiresInSeconds || 300) - 45) * 1000 });
      setPlayingId(item.id); setPlaybackUrl(result.playbackUrl);
    } catch (cause) { setError(messageOf(cause, "This audio recording could not be opened.")); }
    finally { setBusyId(null); }
  }

  return <div className="management-page page-enter">
    <div className="management-heading"><div><p className="section-overline">LISTEN BACK TO YOUR GATHERINGS</p><h1>Recorded Prayers</h1><p>Public online prayer recordings and private recordings from gatherings you hosted or attended.</p></div><button className="button button-soft refresh-button" onClick={() => void load()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "spin" : ""}/> {refreshing ? "Refreshing…" : "Refresh"}</button></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading ? <div className="management-recording-grid" aria-busy="true" aria-label="Loading audio recordings">{Array.from({ length: 6 }, (_, index) => <AudioCardSkeleton key={index}/>)}</div> : recordings.length === 0 ? <div className="management-empty"><b>No completed audio recordings yet</b><span>Finished public online prayers and recordings from gatherings you attended will appear here.</span></div> : <div className="management-recording-grid">{recordings.map((item) => <LazyMount key={item.id} fallback={<AudioCardSkeleton/>}><article className={`management-recording-card audio-recording-card ${playingId === item.id && audioPlaying ? "audio-card-playing" : ""}`}><div className="audio-card-stage"><span className="audio-card-ring audio-card-ring-1"/><span className="audio-card-ring audio-card-ring-2"/><div className="audio-card-body"><span className="audio-card-icon">{playingId === item.id && audioPlaying ? <span className="audio-card-eq" aria-hidden="true"><i/><i/><i/><i/><i/></span> : <AudioLines size={30}/>}</span><i className="audio-card-kind">{item.public ? "PUBLIC PRAYER" : "PRIVATE AUDIO"}</i><b>{item.meetingTitle}</b><span className="audio-card-host">Hosted by {item.hostName}</span><small>{formatDate(item.startedAt)} · {formatBytes(item.fileSize)}</small><small>{item.participants?.length || 0} participants · Expires {formatDate(item.expiresAt)}</small></div><div className="audio-card-actions">{playingId === item.id && playbackUrl ? <RecordingCardControls key={playbackUrl} src={playbackUrl} title={item.meetingTitle} durationHint={item.durationSeconds} onPlayingChange={handlePlayingChange}/> : <button type="button" className="audio-card-listen" onClick={() => void play(item)} disabled={busyId === item.id}>{busyId === item.id ? <><LoaderCircle size={16} className="spin"/> Opening…</> : "Listen"}</button>}</div></div></article></LazyMount>)}</div>}
  </div>;
}

const ADMIN_TABS = ["Overview", "Meetings", "Users", "Recordings", "Activity"] as const;
// Audio-only recording inventory is available to authorized viewers.
const RECORDING_UI_ENABLED = true;
type AdminTab = typeof ADMIN_TABS[number];
const SORT_OPTIONS: SelectOption[] = [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }];
const ACTIVITY_CATEGORY_OPTIONS: SelectOption[] = [{ value: "", label: "All categories" }, ...["traffic", "page_view", "auth", "meeting", ...(RECORDING_UI_ENABLED ? ["recording"] : []), "admin", "system"].map((value) => ({ value, label: value.replaceAll("_", " ") }))];
const MEETING_STATUS_OPTIONS: SelectOption[] = [{ value: "", label: "All statuses" }, { value: "scheduled", label: "Scheduled" }, { value: "live", label: "Live" }, { value: "ended", label: "Ended" }, { value: "cancelled", label: "Cancelled" }];
const USER_STATUS_OPTIONS: SelectOption[] = [{ value: "", label: "All account statuses" }, { value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }];
const RECORDING_STATUS_OPTIONS: SelectOption[] = [{ value: "", label: "All statuses" }, ...["consent_pending", "recording", "uploading", "ready", "failed", "declined"].map((value) => ({ value, label: value.replaceAll("_", " ") }))];

type PageInfo = { page: number; limit: number; total: number; totalPages: number };
const EMPTY_PAGE: PageInfo = { page: 1, limit: 20, total: 0, totalPages: 1 };

// ---- Cache-first (stale-while-revalidate) helpers shared by the Recordings and Admin pages.
const sameData = (a: unknown, b: unknown) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
const adminKey = (name: string, ...parts: Array<string | number>) => `admin:${name}:${parts.join("|")}`;
const cachedAdmin = (name: string, ...parts: Array<string | number>) => readCache<any>(adminKey(name, ...parts))?.value;
// Removes one record from every cached page of a list and keeps the cached totals in step, without refetching the list.
function dropCachedRecord(prefix: string, field: string, match: (item: any) => boolean) {
  patchCache<any>((key) => key.startsWith(prefix), (value) => {
    const list: any[] = value?.[field] || [];
    const next = list.filter((item) => !match(item));
    if (next.length === list.length) return value;
    const pagination = value.pagination;
    const total = Math.max(0, (pagination?.total || 0) - (list.length - next.length));
    return { ...value, [field]: next, pagination: pagination ? { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / (pagination.limit || 20))) } : pagination };
  });
}
// Merges changed fields into one record of every cached page of a list.
function patchCachedRecord(prefix: string, field: string, match: (item: any) => boolean, patch: Record<string, unknown>) {
  patchCache<any>((key) => key.startsWith(prefix), (value) => {
    const list: any[] = value?.[field] || [];
    if (!list.some(match)) return value;
    return { ...value, [field]: list.map((item) => match(item) ? { ...item, ...patch } : item) };
  });
}
const shrinkPagination = (current: PageInfo): PageInfo => { const total = Math.max(0, current.total - 1); return { ...current, total, totalPages: Math.max(1, Math.ceil(total / (current.limit || 20))) }; };


type TrendRow = { day: string; pageViews: number; requests: number; meetingsCreated?: number; meetingsStarted?: number; meetingsEnded?: number };
type BreakdownItem = { label: string; value: number };

function AdminPagination({ value, onChange }: { value: PageInfo; onChange: (page: number) => void }) {
  const first = value.total === 0 ? 0 : (value.page - 1) * value.limit + 1;
  const last = Math.min(value.page * value.limit, value.total);
  return <div className="admin-pagination" aria-label="Record pagination">
    <small>Showing {first.toLocaleString()}–{last.toLocaleString()} of {value.total.toLocaleString()}</small>
    <div><button type="button" disabled={value.page <= 1} onClick={() => onChange(Math.max(1, value.page - 1))}>Previous</button><span>Page {value.page} of {value.totalPages}</span><button type="button" disabled={value.page >= value.totalPages} onClick={() => onChange(Math.min(value.totalPages, value.page + 1))}>Next</button></div>
  </div>;
}

function AdminMetricSkeleton() {
  return <div className="admin-metric-grid">{Array.from({ length: 11 }, (_, i) => <div className="admin-metric-card admin-skeleton-card" key={i}><i/><b/></div>)}</div>;
}
function AdminPanelSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="admin-skeleton-list" aria-label="Loading records">{Array.from({ length: rows }, (_, i) => <div className="admin-skeleton-row" key={i}><i/><span/><b/></div>)}</div>;
}
function AdminChartSkeleton() {
  return <div className="admin-chart-skeleton" aria-label="Loading chart"><i/><i/><i/><i/><i/><i/><i/></div>;
}
function AdminRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="admin-inline-error" role="alert"><span>{message}</span><button type="button" onClick={onRetry}>Retry</button></div>;
}

function TrafficLineChart({ rows }: { rows: TrendRow[] }) {
  if (!rows.length) return <div className="admin-inline-empty">No traffic events are available for the selected 30-day period yet.</div>;
  const max = Math.max(1, ...rows.flatMap((row) => [row.pageViews || 0, row.requests || 0]));
  const xFor = (index: number) => rows.length === 1 ? 300 : 24 + index * (552 / (rows.length - 1));
  const yFor = (value: number) => 162 - (Number(value || 0) / max) * 128;
  const pagePoints = rows.map((row, index) => `${xFor(index)},${yFor(row.pageViews)}`).join(" ");
  const requestPoints = rows.map((row, index) => `${xFor(index)},${yFor(row.requests)}`).join(" ");
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 4), Math.floor((rows.length - 1) / 2), Math.floor((rows.length - 1) * 3 / 4), rows.length - 1])];
  return <div className="admin-svg-chart-wrap">
    <svg className="admin-svg-chart" viewBox="0 0 600 205" role="img" aria-label="Daily page views and API requests for the last 30 days">
      {[34, 76, 118, 162].map((y) => <line key={y} x1="24" x2="576" y1={y} y2={y} className="admin-chart-gridline"/>)}
      <polyline points={pagePoints} className="admin-line-pageviews"/>
      <polyline points={requestPoints} className="admin-line-requests"/>
      {rows.map((row, index) => <g key={row.day}><circle cx={xFor(index)} cy={yFor(row.pageViews)} r="3.2" className="admin-point-pageviews"><title>{row.day}: {row.pageViews} page views</title></circle><circle cx={xFor(index)} cy={yFor(row.requests)} r="3.2" className="admin-point-requests"><title>{row.day}: {row.requests} API requests</title></circle></g>)}
      {labelIndexes.map((index) => <text key={rows[index].day} x={xFor(index)} y="190" textAnchor="middle" className="admin-chart-axis-label">{rows[index].day.slice(5)}</text>)}
    </svg>
    <div className="admin-chart-legend"><span><i className="legend-pageviews"/> Page views</span><span><i className="legend-requests"/> API requests</span></div>
  </div>;
}

function MeetingBars({ rows }: { rows: TrendRow[] }) {
  if (!rows.length || !rows.some((row) => Number(row.meetingsCreated || 0) || Number(row.meetingsStarted || 0) || Number(row.meetingsEnded || 0))) {
    return <div className="admin-inline-empty">No meeting lifecycle events have been collected in the last 30 days.</div>;
  }
  const max = Math.max(1, ...rows.flatMap((row) => [row.meetingsCreated || 0, row.meetingsStarted || 0, row.meetingsEnded || 0]));
  const shown = rows.filter((_, index) => index % Math.max(1, Math.ceil(rows.length / 12)) === 0 || index === rows.length - 1);
  return <div className="admin-meeting-bars">{shown.map((row) => <div className="admin-meeting-bar-day" key={row.day} title={`${row.day}: ${row.meetingsCreated || 0} created, ${row.meetingsStarted || 0} started, ${row.meetingsEnded || 0} ended`}>
    <div className="admin-meeting-bar-group"><i style={{ height: `${(Number(row.meetingsCreated || 0) / max) * 100}%` }}/><b style={{ height: `${(Number(row.meetingsStarted || 0) / max) * 100}%` }}/><em style={{ height: `${(Number(row.meetingsEnded || 0) / max) * 100}%` }}/></div><small>{row.day.slice(5)}</small>
  </div>)}</div>;
}

function AdminDonut({ title, description, items, emptyLabel }: { title: string; description: string; items: BreakdownItem[]; emptyLabel: string }) {
  const palette = ["#c37f99", "#7f9cae", "#d7b56d", "#8bb89b", "#a18dc4", "#ce8e71"];
  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.value || 0)), 0);
  const circumference = 2 * Math.PI * 43;
  let offset = 0;
  return <section className="admin-panel admin-donut-panel"><div className="admin-panel-heading"><div><h2>{title}</h2><p>{description}</p></div><small>{total.toLocaleString()} total</small></div>
    {total <= 0 ? <div className="admin-inline-empty">{emptyLabel}</div> : <div className="admin-donut-content"><svg className="admin-donut" viewBox="0 0 120 120" role="img" aria-label={`${title} distribution, ${total} total`}><g transform="rotate(-90 60 60)"><circle cx="60" cy="60" r="43" className="admin-donut-track"/>{items.filter((item) => item.value > 0).map((item, index) => { const length = (item.value / total) * circumference; const currentOffset = offset; offset += length; return <circle key={`${item.label}-${index}`} cx="60" cy="60" r="43" fill="none" stroke={palette[index % palette.length]} strokeWidth="15" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-currentOffset}><title>{item.label}: {item.value} ({Math.round(item.value / total * 100)}%)</title></circle>; })}</g><text x="60" y="57" textAnchor="middle" className="admin-donut-total">{total.toLocaleString()}</text><text x="60" y="70" textAnchor="middle" className="admin-donut-caption">records</text></svg><div className="admin-donut-legend">{items.filter((item) => item.value > 0).map((item) => <div key={item.label}><span><i style={{ background: palette[items.indexOf(item) % palette.length] }}/>{item.label}</span><b>{item.value.toLocaleString()}</b></div>)}</div></div>}
  </section>;
}

export function AdminCenterPage() {
  const [tab, setTab] = useState<AdminTab>("Overview");
  const [overview, setOverview] = useState<any>(() => readCache<any>("admin:overview")?.value ?? null);
  const [meetings, setMeetings] = useState<any[]>(() => cachedAdmin("meetings", 1, "", "newest")?.meetings ?? []);
  const [users, setUsers] = useState<any[]>(() => cachedAdmin("users", 1, "", "newest")?.users ?? []);
  const [recordings, setRecordings] = useState<any[]>(() => cachedAdmin("recordings", 1, "", "newest")?.recordings ?? []);
  const [events, setEvents] = useState<any[]>(() => cachedAdmin("activity", 1, "", "newest")?.events ?? []);
  const [recentEvents, setRecentEvents] = useState<any[]>(() => cachedAdmin("recent-activity", 1, "", "newest")?.events ?? []);
  const [meetingPage, setMeetingPage] = useState(1);
  const [userPage, setUserPage] = useState(1);
  const [userStatus, setUserStatusFilter] = useState("");
  const [recordingPage, setRecordingPage] = useState(1);
  const [activityPage, setActivityPage] = useState(1);
  const [recentActivityPage, setRecentActivityPage] = useState(1);
  const [recentActivitySearch, setRecentActivitySearch] = useState("");
  const [recentActivityCategory, setRecentActivityCategory] = useState("");
  const [recentActivitySort, setRecentActivitySort] = useState("newest");
  const [meetingPagination, setMeetingPagination] = useState<PageInfo>(() => cachedAdmin("meetings", 1, "", "newest")?.pagination ?? EMPTY_PAGE);
  const [userPagination, setUserPagination] = useState<PageInfo>(() => cachedAdmin("users", 1, "", "newest")?.pagination ?? EMPTY_PAGE);
  const [recordingPagination, setRecordingPagination] = useState<PageInfo>(() => cachedAdmin("recordings", 1, "", "newest")?.pagination ?? EMPTY_PAGE);
  const [activityPagination, setActivityPagination] = useState<PageInfo>(() => cachedAdmin("activity", 1, "", "newest")?.pagination ?? EMPTY_PAGE);
  const [recentActivityPagination, setRecentActivityPagination] = useState<PageInfo>(() => cachedAdmin("recent-activity", 1, "", "newest")?.pagination ?? EMPTY_PAGE);
  const [search, setSearch] = useState("");
  const [meetingSearch, setMeetingSearch] = useState("");
  const [recordingSearch, setRecordingSearch] = useState("");
  const [activitySearch, setActivitySearch] = useState("");
  const [meetingStatus, setMeetingStatus] = useState("");
  const [recordingStatus, setRecordingStatus] = useState("");
  const [activityCategory, setActivityCategory] = useState("");
  const [meetingSort, setMeetingSort] = useState("newest");
  const [userSort, setUserSort] = useState("newest");
  const [recordingSort, setRecordingSort] = useState("newest");
  const [activitySort, setActivitySort] = useState("newest");
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [attendancePagination, setAttendancePagination] = useState<PageInfo>(EMPTY_PAGE);
  const [loading, setLoading] = useState(() => ({ overview: !readCache("admin:overview"), meetings: !cachedAdmin("meetings", 1, "", "newest"), users: !cachedAdmin("users", 1, "", "newest"), recordings: !cachedAdmin("recordings", 1, "", "newest"), activity: !cachedAdmin("activity", 1, "", "newest"), recentActivity: !cachedAdmin("recent-activity", 1, "", "newest"), attendance: false }));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sectionErrors, setSectionErrors] = useState({ overview: "", meetings: "", users: "", recordings: "", activity: "", recentActivity: "", attendance: "" });

  // Every section is cache-first: cached rows render immediately (no skeleton), then fresh data is fetched in the
  // background and swapped in quietly only if something actually changed. Skeletons only show on a truly empty cache.
  const loadOverview = useCallback(async () => {
    const hasCache = Boolean(readCache("admin:overview"));
    if (!hasCache) setLoading((current) => ({ ...current, overview: true }));
    try { const result = await api.adminOverview(); writeCache("admin:overview", result); setOverview((current: any) => sameData(current, result) ? current : result); setSectionErrors((current) => ({ ...current, overview: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load platform analytics."); setSectionErrors((current) => ({ ...current, overview: message })); if (!hasCache) setError(message); }
    finally { setLoading((current) => ({ ...current, overview: false })); }
  }, []);
  const loadMeetings = useCallback(async () => {
    const key = meetingSearch ? "" : adminKey("meetings", meetingPage, meetingStatus, meetingSort);
    const cached = key ? readCache<any>(key)?.value : null;
    if (cached) { setMeetings(cached.meetings || []); setMeetingPagination(cached.pagination || EMPTY_PAGE); setLoading((current) => ({ ...current, meetings: false })); }
    else setLoading((current) => ({ ...current, meetings: true }));
    try {
      const result = await api.adminMeetings(meetingPage, meetingSearch, meetingStatus, meetingSort);
      if (key) writeCache(key, result);
      setMeetings((current) => sameData(current, result.meetings) ? current : (result.meetings || [])); setMeetingPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, meetings: "" }));
    }
    catch (cause) { const message = messageOf(cause, "Could not load meetings."); setSectionErrors((current) => ({ ...current, meetings: message })); if (!cached) setError(message); }
    finally { setLoading((current) => ({ ...current, meetings: false })); }
  }, [meetingPage, meetingSearch, meetingStatus, meetingSort]);
  const loadUsers = useCallback(async () => {
    const key = search ? "" : adminKey("users", userPage, userStatus, userSort);
    const cached = key ? readCache<any>(key)?.value : null;
    if (cached) { setUsers(cached.users || []); setUserPagination(cached.pagination || EMPTY_PAGE); setLoading((current) => ({ ...current, users: false })); }
    else setLoading((current) => ({ ...current, users: true }));
    try {
      const result = await api.adminUsers(search, userPage, userSort, userStatus);
      if (key) writeCache(key, result);
      setUsers((current) => sameData(current, result.users) ? current : (result.users || [])); setUserPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, users: "" }));
    }
    catch (cause) { const message = messageOf(cause, "Could not load accounts."); setSectionErrors((current) => ({ ...current, users: message })); if (!cached) setError(message); }
    finally { setLoading((current) => ({ ...current, users: false })); }
  }, [search, userPage, userSort, userStatus]);
  const loadRecordings = useCallback(async () => {
    const key = recordingSearch ? "" : adminKey("recordings", recordingPage, recordingStatus, recordingSort);
    const cached = key ? readCache<any>(key)?.value : null;
    if (cached) { setRecordings(cached.recordings || []); setRecordingPagination(cached.pagination || EMPTY_PAGE); setLoading((current) => ({ ...current, recordings: false })); }
    else setLoading((current) => ({ ...current, recordings: true }));
    try {
      const result = await api.adminRecordings(recordingPage, recordingSearch, recordingStatus, recordingSort);
      if (key) writeCache(key, result);
      setRecordings((current) => sameData(current, result.recordings) ? current : (result.recordings || [])); setRecordingPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, recordings: "" }));
    }
    catch (cause) { const message = messageOf(cause, "Could not load recordings."); setSectionErrors((current) => ({ ...current, recordings: message })); if (!cached) setError(message); }
    finally { setLoading((current) => ({ ...current, recordings: false })); }
  }, [recordingPage, recordingSearch, recordingStatus, recordingSort]);
  const loadEvents = useCallback(async () => {
    const key = activitySearch ? "" : adminKey("activity", activityPage, activityCategory, activitySort);
    const cached = key ? readCache<any>(key)?.value : null;
    if (cached) { setEvents(cached.events || []); setActivityPagination(cached.pagination || EMPTY_PAGE); setLoading((current) => ({ ...current, activity: false })); }
    else setLoading((current) => ({ ...current, activity: true }));
    try {
      const result = await api.adminActivity(activityPage, activitySearch, activityCategory, activitySort);
      if (key) writeCache(key, result);
      setEvents((current) => sameData(current, result.events) ? current : (result.events || [])); setActivityPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, activity: "" }));
    }
    catch (cause) { const message = messageOf(cause, "Could not load activity."); setSectionErrors((current) => ({ ...current, activity: message })); if (!cached) setError(message); }
    finally { setLoading((current) => ({ ...current, activity: false })); }
  }, [activityPage, activitySearch, activityCategory, activitySort]);
  const loadRecentActivity = useCallback(async () => {
    const key = recentActivitySearch ? "" : adminKey("recent-activity", recentActivityPage, recentActivityCategory, recentActivitySort);
    const cached = key ? readCache<any>(key)?.value : null;
    if (cached) { setRecentEvents(cached.events || []); setRecentActivityPagination(cached.pagination || EMPTY_PAGE); setLoading((current) => ({ ...current, recentActivity: false })); }
    else setLoading((current) => ({ ...current, recentActivity: true }));
    try {
      const result = await api.adminActivity(recentActivityPage, recentActivitySearch, recentActivityCategory, recentActivitySort);
      if (key) writeCache(key, result);
      setRecentEvents((current) => sameData(current, result.events) ? current : (result.events || [])); setRecentActivityPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, recentActivity: "" }));
    }
    catch (cause) { const message = messageOf(cause, "Could not load recent system activity."); setSectionErrors((current) => ({ ...current, recentActivity: message })); if (!cached) setError(message); }
    finally { setLoading((current) => ({ ...current, recentActivity: false })); }
  }, [recentActivityPage, recentActivitySearch, recentActivityCategory, recentActivitySort]);

  // Load each admin section on first visit rather than fetching every record
  // collection while the Overview tab is visible. Each section owns its own
  // skeleton/error state and only requests its current page.
  useEffect(() => { if (tab === "Overview") { void loadOverview(); void loadRecentActivity(); } }, [tab, loadOverview, loadRecentActivity]);
  useEffect(() => {
    document.querySelector<HTMLElement>(`.admin-tabs [role="tab"][aria-selected="true"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [tab]);
  useEffect(() => { if (tab === "Meetings") void loadMeetings(); }, [tab, loadMeetings]);
  useEffect(() => { if (tab === "Users") void loadUsers(); }, [tab, loadUsers]);
  useEffect(() => { if (tab === "Recordings") void loadRecordings(); }, [tab, loadRecordings]);
  useEffect(() => { if (tab === "Activity") void loadEvents(); }, [tab, loadEvents]);
  useEffect(() => {
    if (tab !== "Overview") return;
    const timer = window.setInterval(() => { void loadOverview(); void loadRecentActivity(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [tab, loadOverview, loadRecentActivity]);

  async function refreshAll() {
    setError("");
    if (tab === "Overview") await Promise.all([loadOverview(), loadRecentActivity()]);
    else if (tab === "Meetings") await loadMeetings();
    else if (tab === "Users") await loadUsers();
    else if (tab === "Recordings") await loadRecordings();
    else await loadEvents();
  }
  async function openAttendance(meeting: any, page = 1) {
    setSelectedMeeting(meeting); setAttendance([]); setLoading((current) => ({ ...current, attendance: true }));
    try { const result = await api.adminAttendance(meeting.slug, page); setAttendance(result.attendance || []); setAttendancePagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, attendance: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load meeting attendance."); setSectionErrors((current) => ({ ...current, attendance: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, attendance: false })); }
  }
  async function terminate(meeting: any) {
    if (!window.confirm(`Terminate “${meeting.title}” for everyone? This immediately disconnects all participants.`)) return;
    setBusy(`terminate:${meeting.slug}`); setError("");
    try {
      await api.adminTerminateMeeting(meeting.slug);
      // Only the affected record changes; the rest of the list and its cache stay untouched.
      const patch = { status: "ended", onlineNow: 0 };
      setMeetings((current) => current.map((item) => item.slug === meeting.slug ? { ...item, ...patch } : item));
      patchCachedRecord("admin:meetings:", "meetings", (item) => item.slug === meeting.slug, patch);
      void loadOverview();
    }
    catch (cause) { setError(messageOf(cause, "Could not terminate this meeting.")); }
    finally { setBusy(""); }
  }
  async function deleteMeeting(meeting: any) {
    if (!window.confirm(`Permanently delete “${meeting.title}”? This removes the meeting, its attendance history, private meeting messages, and associated recordings from Cloudinary and Backblaze B2. This cannot be undone.`)) return;
    setBusy(`delete-meeting:${meeting.slug}`); setError("");
    try {
      await api.adminDeleteMeeting(meeting.slug);
      setMeetings((current) => current.filter((item) => item.slug !== meeting.slug)); setMeetingPagination(shrinkPagination);
      dropCachedRecord("admin:meetings:", "meetings", (item) => item.slug === meeting.slug);
      // The meeting's recordings were removed with it; drop only those rows from the recording list too.
      setRecordings((current) => current.filter((item) => item.meetingSlug !== meeting.slug));
      dropCachedRecord("admin:recordings:", "recordings", (item) => item.meetingSlug === meeting.slug);
      if (meetings.length <= 1 && meetingPage > 1) setMeetingPage(meetingPage - 1);
      void loadOverview();
    }
    catch (cause) { setError(messageOf(cause, "Could not delete the meeting. If a recording is still finalizing, retry after upload completes.")); }
    finally { setBusy(""); }
  }
  async function setUserStatus(user: any, status: "active" | "suspended") {
    const action = status === "suspended" ? "Suspend" : "Reactivate";
    if (!window.confirm(`${action} ${user.displayName} (${user.email})? ${status === "suspended" ? "All current sessions will be revoked." : "They will be able to sign in again."}`)) return;
    setBusy(`user:${user.id}`); setError("");
    try {
      const result = await api.adminSetUserStatus(user.id, status);
      const patch: Record<string, unknown> = { ...result.user, ...(status === "suspended" ? { sessions: [] } : {}) };
      if (userStatus && userStatus !== status) {
        // The updated account no longer matches the active status filter, so only that row leaves the list.
        setUsers((current) => current.filter((item) => item.id !== user.id)); setUserPagination(shrinkPagination);
        dropCachedRecord("admin:users:", "users", (item) => item.id === user.id);
      } else {
        setUsers((current) => current.map((item) => item.id === user.id ? { ...item, ...patch } : item));
        patchCachedRecord("admin:users:", "users", (item) => item.id === user.id, patch);
      }
      void loadOverview();
    }
    catch (cause) { setError(messageOf(cause, "Could not update account status.")); }
    finally { setBusy(""); }
  }
  async function setMeetingPermission(user: any, allowed: boolean) {
    const verb = allowed ? "grant" : "revoke";
    if (!window.confirm(`${allowed ? "Allow" : "Prevent"} ${user.displayName} (${user.email}) from creating and scheduling meetings? This permission takes effect on their next authorization check.`)) return;
    setBusy(`meeting-permission:${user.id}`); setError("");
    try {
      const result = await api.adminSetMeetingPermission(user.id, allowed);
      const patch = { canCreateMeetings: result.user?.canCreateMeetings ?? allowed };
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, ...patch } : item));
      patchCachedRecord("admin:users:", "users", (item) => item.id === user.id, patch);
    }
    catch (cause) { setError(messageOf(cause, `Could not ${verb} meeting creation permission.`)); }
    finally { setBusy(""); }
  }

  async function deleteUser(user: any) {
    if (!window.confirm(`Permanently delete ${user.displayName} (${user.email})? This also deletes meetings they host, their meeting recordings, attendance data, private messages, and active sessions. This cannot be undone.`)) return;
    setBusy(`delete-user:${user.id}`); setError("");
    try {
      await api.adminDeleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id)); setUserPagination(shrinkPagination);
      dropCachedRecord("admin:users:", "users", (item) => item.id === user.id);
      // Their hosted meetings and recordings are gone too: drop just those rows, then let the lists revalidate quietly when visited.
      setRecordings((current) => current.filter((item) => String(item.hostUserId || "") !== user.id));
      dropCachedRecord("admin:recordings:", "recordings", (item) => String(item.hostUserId || "") === user.id);
      if (users.length <= 1 && userPage > 1) setUserPage(userPage - 1);
      void loadOverview();
    }
    catch (cause) { setError(messageOf(cause, "Could not delete this account. Any recording that is still finalizing must finish first.")); }
    finally { setBusy(""); }
  }
  async function deleteRecording(item: any) {
    if (!window.confirm(`Permanently delete the recording of “${item.meetingTitle}”? The authenticated Cloudinary video, derived media, and all Backblaze B2 staging versions will be removed.`)) return;
    const id = String(item._id); setBusy(`delete-recording:${id}`); setError("");
    try {
      await api.adminDeleteRecording(id);
      setRecordings((current) => current.filter((row) => String(row._id) !== id)); setRecordingPagination(shrinkPagination);
      dropCachedRecord("admin:recordings:", "recordings", (row) => String(row._id) === id);
      if (recordings.length <= 1 && recordingPage > 1) setRecordingPage(recordingPage - 1);
      void loadOverview();
    }
    catch (cause) { setError(messageOf(cause, "Could not delete the recording. Storage cleanup may be retried automatically.")); }
    finally { setBusy(""); }
  }

  const stats = overview?.stats || {};
  const trends: TrendRow[] = overview?.trends || [];
  const meetingBreakdown: BreakdownItem[] = overview?.meetingStatusBreakdown || [];
  const recordingBreakdown: BreakdownItem[] = overview?.recordingStatusBreakdown || [];

  return <div className="management-page admin-center-page page-enter">
    <div className="management-heading"><div><p className="section-overline">PLATFORM OPERATIONS</p><h1>System Admin Control Center</h1><p>Live operational data, account controls, meeting management, and audit history.</p></div><button className="button button-soft" onClick={() => void refreshAll()}>Refresh data</button></div>
    <div className="admin-access-note"><span className="admin-access-dot"/> Signed in with authorized system administrator permissions. Account credentials and session tokens are never displayed.</div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError("")}>Dismiss</button></div>}
    <div className="admin-tabs" role="tablist" aria-label="Admin sections">{ADMIN_TABS.filter((item) => RECORDING_UI_ENABLED || item !== "Recordings").map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "admin-tab admin-tab-active" : "admin-tab"} onClick={() => { setTab(item); setSelectedMeeting(null); }}>{item}</button>)}</div>

    {tab === "Overview" && <>
      {loading.overview && !overview?.stats ? <AdminMetricSkeleton/> : sectionErrors.overview && !overview?.stats ? <AdminRetry message={sectionErrors.overview} onRetry={() => void loadOverview()}/> : <div className="admin-metric-grid">{[
        ["Total meetings", stats.totalMeetings], ["Active meetings", stats.activeMeetings], ["Completed meetings", stats.completedMeetings],
        ["Registered accounts", stats.registeredAccounts], ["Active sessions", stats.activeSessions], ["Online participants", stats.onlineParticipants],
        ["Total participants", stats.uniqueParticipants], ["Guest participants · 30 days", stats.guestParticipants], ["Page views", stats.pageViews], ["Page loads", stats.pageLoads], ["API requests", stats.apiRequests],
      ].map(([label, value]) => <article className="admin-metric-card" key={String(label)}><span>{label}</span><b>{Number(value ?? 0).toLocaleString()}</b></article>)}</div>}
      <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Traffic and platform activity</h2><p>Daily page views and API requests · last 30 days · all timestamps are grouped by UTC day.</p></div><small>{overview?.range ? `${formatDate(overview.range.start)} – ${formatDate(overview.range.end)}` : "Last 30 days"}</small></div>{loading.overview && !overview?.stats ? <AdminChartSkeleton/> : sectionErrors.overview && !overview?.stats ? <AdminRetry message={sectionErrors.overview} onRetry={() => void loadOverview()}/> : <TrafficLineChart rows={trends}/>}</section>
      <div className={`admin-chart-grid ${RECORDING_UI_ENABLED ? "" : "admin-chart-grid-single"}`}>{loading.overview && !overview?.stats ? <><section className="admin-panel"><AdminChartSkeleton/></section>{RECORDING_UI_ENABLED && <section className="admin-panel"><AdminChartSkeleton/></section>}</> : sectionErrors.overview && !overview?.stats ? <section className="admin-panel"><AdminRetry message={sectionErrors.overview} onRetry={() => void loadOverview()}/></section> : <><AdminDonut title="Meeting lifecycle" description="Current database status for all meetings." items={meetingBreakdown} emptyLabel="No meeting records are available."/>{RECORDING_UI_ENABLED && <AdminDonut title="Recording inventory" description="Recording processing status across the platform." items={recordingBreakdown} emptyLabel="No recording requests are available."/>}</>}</div>
      <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Meeting activity breakdown</h2><p>Meetings created, started and ended based on saved platform events · last 30 days.</p></div></div>{loading.overview && !overview?.stats ? <AdminChartSkeleton/> : sectionErrors.overview && !overview?.stats ? <AdminRetry message={sectionErrors.overview} onRetry={() => void loadOverview()}/> : <><MeetingBars rows={trends}/><div className="admin-chart-legend"><span><i className="legend-meeting-created"/> Created</span><span><i className="legend-meeting-started"/> Started</span><span><i className="legend-meeting-ended"/> Ended</span></div></>}</section>
      <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recent system activity</h2><p>Latest persisted backend and audit events.</p></div><button className="text-action" onClick={() => setTab("Activity")}>View all activity</button></div><div className="admin-filters"><input className="admin-search" value={recentActivitySearch} onChange={(event) => { setRecentActivitySearch(event.target.value); setRecentActivityPage(1); }} placeholder="Search recent activity" aria-label="Search recent activity"/><CustomSelect className="admin-filter-select" ariaLabel="Filter recent activity" value={recentActivityCategory} options={ACTIVITY_CATEGORY_OPTIONS} onChange={(value) => { setRecentActivityCategory(value); setRecentActivityPage(1); }}/><CustomSelect className="admin-filter-select" ariaLabel="Sort recent activity" value={recentActivitySort} options={SORT_OPTIONS} onChange={(value) => { setRecentActivitySort(value); setRecentActivityPage(1); }}/></div>{loading.recentActivity ? <AdminPanelSkeleton rows={5}/> : sectionErrors.recentActivity ? <AdminRetry message={sectionErrors.recentActivity} onRetry={() => void loadRecentActivity()}/> : <ActivityList events={recentEvents}/>}<AdminPagination value={recentActivityPagination} onChange={setRecentActivityPage}/></section>
    </>}

    {tab === "Meetings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Meeting management</h2><p>Paginated meeting records with hosts, attendance, schedules and administrative controls.</p></div><div className="admin-filters"><input className="admin-search" value={meetingSearch} onChange={(event) => { setMeetingSearch(event.target.value); setMeetingPage(1); }} placeholder="Search title, slug or host" aria-label="Search meetings"/><CustomSelect className="admin-filter-select" ariaLabel="Filter meeting status" value={meetingStatus} options={MEETING_STATUS_OPTIONS} onChange={(value) => { setMeetingStatus(value); setMeetingPage(1); }}/><CustomSelect className="admin-filter-select" ariaLabel="Sort meetings" value={meetingSort} options={SORT_OPTIONS} onChange={(value) => { setMeetingSort(value); setMeetingPage(1); }}/></div></div>{loading.meetings ? <AdminPanelSkeleton rows={6}/> : sectionErrors.meetings ? <AdminRetry message={sectionErrors.meetings} onRetry={() => void loadMeetings()}/> : meetings.length === 0 ? <div className="admin-inline-empty">No matching meetings.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting</th><th>Status</th><th>Schedule / duration</th><th>People</th>{RECORDING_UI_ENABLED && <th>Recording</th>}<th>Actions</th></tr></thead><tbody>{meetings.map((meeting) => <tr key={meeting.slug}><td><b>{meeting.title}</b><small>{meeting.ownerName} · {meeting.slug}</small></td><td><span className={`admin-status admin-status-${meeting.status}`}>{meeting.status}</span></td><td>{formatDate(meeting.startedAt || meeting.startsAt)}<small>{meeting.durationMinutes} min planned</small></td><td>{meeting.onlineNow} online<small>{meeting.attendanceCount} attendance records</small></td>{RECORDING_UI_ENABLED && <td>{meeting.recordingStatus || "idle"}<small>{meeting.recordingCount} recordings</small></td>}<td><div className="admin-row-actions"><button onClick={() => void openAttendance(meeting)}>Attendance</button>{meeting.status === "live" && <button className="admin-danger-link" disabled={busy === `terminate:${meeting.slug}`} onClick={() => void terminate(meeting)}>{busy === `terminate:${meeting.slug}` ? "Ending…" : "Terminate"}</button>}<button className="admin-danger-link" disabled={busy === `delete-meeting:${meeting.slug}`} onClick={() => void deleteMeeting(meeting)}>{busy === `delete-meeting:${meeting.slug}` ? "Deleting…" : "Delete"}</button></div></td></tr>)}</tbody></table></div>}<AdminPagination value={meetingPagination} onChange={setMeetingPage}/></section>}

    {tab === "Users" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Platform accounts and sessions</h2><p>Only public account fields and session activity are shown.</p></div><div className="admin-filters"><input className="admin-search" value={search} onChange={(event) => { setSearch(event.target.value); setUserPage(1); }} placeholder="Search name or email" aria-label="Search accounts"/><CustomSelect className="admin-filter-select" ariaLabel="Filter account status" value={userStatus} options={USER_STATUS_OPTIONS} onChange={(value) => { setUserStatusFilter(value); setUserPage(1); }}/><CustomSelect className="admin-filter-select" ariaLabel="Sort accounts" value={userSort} options={SORT_OPTIONS} onChange={(value) => { setUserSort(value); setUserPage(1); }}/></div></div>{loading.users ? <AdminPanelSkeleton rows={6}/> : sectionErrors.users ? <AdminRetry message={sectionErrors.users} onRetry={() => void loadUsers()}/> : users.length === 0 ? <div className="admin-inline-empty">No matching user accounts.</div> : <div className="admin-user-list">{users.map((user) => <article className="admin-user-row" key={user.id}><ProfilePhoto name={user.displayName} src={user.picture} className="admin-user-photo" size={96}/><div className="admin-user-main"><b>{user.displayName}</b><span>{user.email}</span><small>{user.platformRole === "system_admin" ? "System administrator" : "Registered account"} · Created {formatDate(user.createdAt)}</small><small>{user.sessions?.length || 0} valid session(s) {user.sessions?.length ? `· Last active ${formatDate(user.sessions[0].lastSeenAt)}` : ""}</small>{user.sessions?.slice(0, 2).map((session: any, index: number) => <small key={`${session.createdAt}-${index}`} title={session.userAgent || "Browser session"}>{session.userAgent || "Browser session"}</small>)}</div><div className="admin-user-controls"><span className={`admin-status admin-status-${user.accountStatus}`}>{user.accountStatus}</span>{user.platformRole !== "system_admin" && (() => { const on = busy === `meeting-permission:${user.id}` ? !user.canCreateMeetings : Boolean(user.canCreateMeetings); return <button type="button" role="switch" aria-checked={on} aria-label={on ? "Can create meetings. Turn off" : "Meeting creation is off. Turn on"} className={`toggle-row toggle-row-switch admin-permission-switch ${on ? "is-on" : "is-off"}`} disabled={busy === `meeting-permission:${user.id}`} onClick={() => void setMeetingPermission(user, !user.canCreateMeetings)}><span className="toggle-icon"><span className="toggle-icon-swap" key={on ? "on" : "off"}>{on ? <CalendarCheck size={16}/> : <CalendarX size={16}/>}</span></span><span><b>{on ? "Can create meetings" : "Meeting creation off"}</b></span><span className="switch" aria-hidden="true"><span className="switch-knob"/></span></button>; })()}{user.platformRole !== "system_admin" && <div className="admin-user-buttons"><button type="button" className={user.accountStatus === "suspended" ? "admin-action-button" : "admin-danger-button"} disabled={busy === `user:${user.id}`} onClick={() => void setUserStatus(user, user.accountStatus === "suspended" ? "active" : "suspended")}>{user.accountStatus === "suspended" ? "Reactivate" : "Suspend"}</button><button type="button" className="admin-danger-button" disabled={busy === `delete-user:${user.id}`} onClick={() => void deleteUser(user)}>{busy === `delete-user:${user.id}` ? "Deleting…" : "Delete account"}</button></div>}</div></article>)}</div>}<AdminPagination value={userPagination} onChange={setUserPage}/></section>}

    {tab === "Recordings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recording inventory</h2><p>Consent, egress, upload, 30-day retention and deletion states from the database.</p></div><div className="admin-filters"><input className="admin-search" value={recordingSearch} onChange={(event) => { setRecordingSearch(event.target.value); setRecordingPage(1); }} placeholder="Search meeting or host" aria-label="Search recordings"/><CustomSelect className="admin-filter-select" ariaLabel="Filter recording status" value={recordingStatus} options={RECORDING_STATUS_OPTIONS} onChange={(value) => { setRecordingStatus(value); setRecordingPage(1); }}/><CustomSelect className="admin-filter-select" ariaLabel="Sort recordings" value={recordingSort} options={SORT_OPTIONS} onChange={(value) => { setRecordingSort(value); setRecordingPage(1); }}/></div></div>{loading.recordings ? <AdminPanelSkeleton rows={6}/> : sectionErrors.recordings ? <AdminRetry message={sectionErrors.recordings} onRetry={() => void loadRecordings()}/> : recordings.length === 0 ? <div className="admin-inline-empty">No matching recording requests.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting / host</th><th>Status</th><th>Participants</th><th>Started / ended</th><th>Expires</th><th>Duration / size</th><th>Actions</th></tr></thead><tbody>{recordings.map((item) => <tr key={String(item._id)}><td><b>{item.meetingTitle}</b><small>{item.hostName} · {item.meetingSlug}</small></td><td><span className={`admin-status admin-status-${item.status}`}>{item.status}</span>{item.status === "uploading" && <small>{item.uploadProgressPercent || 0}% uploaded</small>}{item.lastError && <small title={item.lastError}>Upload issue</small>}{item.lastDeletionError && <small title={item.lastDeletionError}>Cleanup retry scheduled</small>}</td><td>{item.participants?.length || 0}</td><td>{formatDate(item.startedAt)}<small>{formatDate(item.endedAt)}</small></td><td>{formatDate(item.expiresAt)}</td><td>{duration(item.durationSeconds)}<small>{formatBytes(item.fileSize)} · {item.uploadAttempts || 0} upload attempts</small></td><td><button className="admin-danger-link" disabled={busy === `delete-recording:${String(item._id)}`} onClick={() => void deleteRecording(item)}>{busy === `delete-recording:${String(item._id)}` ? "Deleting…" : "Delete"}</button></td></tr>)}</tbody></table></div>}<AdminPagination value={recordingPagination} onChange={setRecordingPage}/></section>}

    {tab === "Activity" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>System activity and audit log</h2><p>Searchable, paginated backend events and administrator actions.</p></div><div className="admin-filters"><input className="admin-search" value={activitySearch} onChange={(event) => { setActivitySearch(event.target.value); setActivityPage(1); }} placeholder="Search action, actor or route" aria-label="Search activity"/><CustomSelect className="admin-filter-select" ariaLabel="Filter activity category" value={activityCategory} options={ACTIVITY_CATEGORY_OPTIONS} onChange={(value) => { setActivityCategory(value); setActivityPage(1); }}/><CustomSelect className="admin-filter-select" ariaLabel="Sort activity" value={activitySort} options={SORT_OPTIONS} onChange={(value) => { setActivitySort(value); setActivityPage(1); }}/></div></div>{loading.activity ? <AdminPanelSkeleton rows={8}/> : sectionErrors.activity ? <AdminRetry message={sectionErrors.activity} onRetry={() => void loadEvents()}/> : <ActivityList events={events}/>}<AdminPagination value={activityPagination} onChange={setActivityPage}/></section>}

    {selectedMeeting && <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedMeeting(null); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-label={`Attendance for ${selectedMeeting.title}`}><header><div><h2>{selectedMeeting.title}</h2><p>Attendance sessions · repeat visits are listed separately.</p></div><button onClick={() => setSelectedMeeting(null)} aria-label="Close attendance">×</button></header>{loading.attendance ? <AdminPanelSkeleton rows={5}/> : sectionErrors.attendance ? <AdminRetry message={sectionErrors.attendance} onRetry={() => void openAttendance(selectedMeeting, attendancePagination.page)}/> : attendance.length === 0 ? <div className="admin-inline-empty">No attendance events have been recorded for this meeting yet. Configure the LiveKit room webhook to capture connection events.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Participant</th><th>Identity type</th><th>Joined</th><th>Left</th><th>Duration</th></tr></thead><tbody>{attendance.map((item) => <tr key={item.identity}><td><b>{item.displayName}</b></td><td>{item.isGuest ? "Guest" : "Google account"}{item.onlineNow && <small>Online now</small>}</td><td>{formatDate(item.joinedAt)}</td><td>{formatDate(item.leftAt)}</td><td>{duration(item.durationSeconds)}</td></tr>)}</tbody></table></div>}{!loading.attendance && !sectionErrors.attendance && attendance.length > 0 && <AdminPagination value={attendancePagination} onChange={(page) => void openAttendance(selectedMeeting, page)}/>}</section></div>}
    <div className="admin-footer-note">Last update: {formatDate(overview?.generatedAt)} · Analytics and records are queried from MongoDB and LiveKit. List views load one page at a time.</div>
  </div>;
}

function ActivityList({ events }: { events: any[] }) {
  if (!events.length) return <div className="admin-inline-empty">No recent events have been recorded.</div>;
  return <div className="admin-activity-list">{events.map((event, index) => <article className="admin-activity-row" key={String(event._id || `${event.action}-${index}`)}><span className={`admin-activity-icon activity-${event.category || "system"}`}>{String(event.category || "SYS").slice(0, 1).toUpperCase()}</span><div><b>{String(event.action || "system_event").replaceAll("_", " ")}</b><small>{event.actorName || "System"}{event.meetingSlug ? ` · ${event.meetingSlug}` : ""}{event.path ? ` · ${event.path}` : ""}</small></div><time>{formatDate(event.createdAt)}</time></article>)}</div>;
}
