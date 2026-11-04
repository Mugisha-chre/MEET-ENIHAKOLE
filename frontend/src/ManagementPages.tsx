import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ProfilePhoto } from "./google";

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

export function RecordingsPage() {
  const [recordings, setRecordings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const result = await api.myRecordings(); setRecordings(result.recordings); setError(""); }
    catch (cause) { setError(messageOf(cause, "Could not load your recordings.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function play(id: string) {
    setBusyId(id); setError("");
    try { const result = await api.recordingPlayback(id); setPlayingId(id); setPlaybackUrl(result.playbackUrl); }
    catch (cause) { setError(messageOf(cause, "This recording could not be opened.")); }
    finally { setBusyId(null); }
  }

  return <div className="management-page page-enter">
    <div className="management-heading"><div><p className="section-overline">YOUR MEETING LIBRARY</p><h1>Recordings</h1><p>Private recordings from meetings you hosted or attended.</p></div><button className="button button-soft" onClick={() => void load()}>Refresh</button></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {playingId && playbackUrl && <section className="recording-player-panel"><div className="recording-player-heading"><div><b>{recordings.find((item) => item.id === playingId)?.meetingTitle || "Meeting recording"}</b><small>Secure playback link expires automatically.</small></div><button className="button button-soft button-small" onClick={() => { setPlayingId(null); setPlaybackUrl(""); }}>Close player</button></div><video key={playbackUrl} className="recording-player" controls playsInline preload="metadata" src={playbackUrl} onError={() => { setPlaybackUrl(""); setPlayingId(null); setError("The temporary playback link expired. Select Play again to generate a fresh secure link."); }}/></section>}
    {loading ? <div className="management-empty">Loading recordings…</div> : recordings.length === 0 ? <div className="management-empty"><b>No saved recordings yet</b><span>When a meeting you join is recorded and the upload finishes, it will appear here.</span></div> : <div className="management-recording-grid">{recordings.map((item) => <article className="management-recording-card" key={item.id}><div className="management-recording-art"><span>▶</span><small>{duration(item.durationSeconds)}</small></div><div className="management-recording-copy"><b>{item.meetingTitle}</b><span>Hosted by {item.hostName}</span><small>{formatDate(item.startedAt)} · {formatBytes(item.fileSize)}</small><small>{item.participants?.length || 0} participants</small></div><button className="button button-primary button-small" onClick={() => void play(item.id)} disabled={busyId === item.id}>{busyId === item.id ? "Opening…" : "Play recording"}</button></article>)}</div>}
  </div>;
}

const ADMIN_TABS = ["Overview", "Meetings", "Users", "Recordings", "Activity"] as const;
// Recording tools and inventory remain in source for a later release, but are hidden from users for now.
const RECORDING_UI_ENABLED = false;
type AdminTab = typeof ADMIN_TABS[number];
type PageInfo = { page: number; limit: number; total: number; totalPages: number };
const EMPTY_PAGE: PageInfo = { page: 1, limit: 20, total: 0, totalPages: 1 };

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
  const [overview, setOverview] = useState<any>(null);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [recentEvents, setRecentEvents] = useState<any[]>([]);
  const [meetingPage, setMeetingPage] = useState(1);
  const [userPage, setUserPage] = useState(1);
  const [userStatus, setUserStatusFilter] = useState("");
  const [recordingPage, setRecordingPage] = useState(1);
  const [activityPage, setActivityPage] = useState(1);
  const [recentActivityPage, setRecentActivityPage] = useState(1);
  const [recentActivitySearch, setRecentActivitySearch] = useState("");
  const [recentActivityCategory, setRecentActivityCategory] = useState("");
  const [recentActivitySort, setRecentActivitySort] = useState("newest");
  const [meetingPagination, setMeetingPagination] = useState<PageInfo>(EMPTY_PAGE);
  const [userPagination, setUserPagination] = useState<PageInfo>(EMPTY_PAGE);
  const [recordingPagination, setRecordingPagination] = useState<PageInfo>(EMPTY_PAGE);
  const [activityPagination, setActivityPagination] = useState<PageInfo>(EMPTY_PAGE);
  const [recentActivityPagination, setRecentActivityPagination] = useState<PageInfo>(EMPTY_PAGE);
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
  const [loading, setLoading] = useState({ overview: true, meetings: true, users: true, recordings: true, activity: true, recentActivity: true, attendance: false });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sectionErrors, setSectionErrors] = useState({ overview: "", meetings: "", users: "", recordings: "", activity: "", recentActivity: "", attendance: "" });

  const loadOverview = useCallback(async () => {
    setLoading((current) => ({ ...current, overview: true }));
    try { setOverview(await api.adminOverview()); setSectionErrors((current) => ({ ...current, overview: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load platform analytics."); setSectionErrors((current) => ({ ...current, overview: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, overview: false })); }
  }, []);
  const loadMeetings = useCallback(async () => {
    setLoading((current) => ({ ...current, meetings: true }));
    try { const result = await api.adminMeetings(meetingPage, meetingSearch, meetingStatus, meetingSort); setMeetings(result.meetings || []); setMeetingPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, meetings: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load meetings."); setSectionErrors((current) => ({ ...current, meetings: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, meetings: false })); }
  }, [meetingPage, meetingSearch, meetingStatus, meetingSort]);
  const loadUsers = useCallback(async () => {
    setLoading((current) => ({ ...current, users: true }));
    try { const result = await api.adminUsers(search, userPage, userSort, userStatus); setUsers(result.users || []); setUserPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, users: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load accounts."); setSectionErrors((current) => ({ ...current, users: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, users: false })); }
  }, [search, userPage, userSort, userStatus]);
  const loadRecordings = useCallback(async () => {
    setLoading((current) => ({ ...current, recordings: true }));
    try { const result = await api.adminRecordings(recordingPage, recordingSearch, recordingStatus, recordingSort); setRecordings(result.recordings || []); setRecordingPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, recordings: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load recordings."); setSectionErrors((current) => ({ ...current, recordings: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, recordings: false })); }
  }, [recordingPage, recordingSearch, recordingStatus, recordingSort]);
  const loadEvents = useCallback(async () => {
    setLoading((current) => ({ ...current, activity: true }));
    try { const result = await api.adminActivity(activityPage, activitySearch, activityCategory, activitySort); setEvents(result.events || []); setActivityPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, activity: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load activity."); setSectionErrors((current) => ({ ...current, activity: message })); setError(message); }
    finally { setLoading((current) => ({ ...current, activity: false })); }
  }, [activityPage, activitySearch, activityCategory, activitySort]);
  const loadRecentActivity = useCallback(async () => {
    setLoading((current) => ({ ...current, recentActivity: true }));
    try { const result = await api.adminActivity(recentActivityPage, recentActivitySearch, recentActivityCategory, recentActivitySort); setRecentEvents(result.events || []); setRecentActivityPagination(result.pagination || EMPTY_PAGE); setSectionErrors((current) => ({ ...current, recentActivity: "" })); }
    catch (cause) { const message = messageOf(cause, "Could not load recent system activity."); setSectionErrors((current) => ({ ...current, recentActivity: message })); setError(message); }
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
    try { await api.adminTerminateMeeting(meeting.slug); await Promise.all([loadMeetings(), loadOverview(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not terminate this meeting.")); }
    finally { setBusy(""); }
  }
  async function deleteMeeting(meeting: any) {
    if (!window.confirm(`Permanently delete “${meeting.title}”? This removes the meeting, its attendance history, private meeting messages, and associated recordings from Cloudinary and Backblaze B2. This cannot be undone.`)) return;
    setBusy(`delete-meeting:${meeting.slug}`); setError("");
    try { await api.adminDeleteMeeting(meeting.slug); await Promise.all([loadMeetings(), loadOverview(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not delete the meeting. If a recording is still finalizing, retry after upload completes.")); }
    finally { setBusy(""); }
  }
  async function setUserStatus(user: any, status: "active" | "suspended") {
    const action = status === "suspended" ? "Suspend" : "Reactivate";
    if (!window.confirm(`${action} ${user.displayName} (${user.email})? ${status === "suspended" ? "All current sessions will be revoked." : "They will be able to sign in again."}`)) return;
    setBusy(`user:${user.id}`); setError("");
    try { await api.adminSetUserStatus(user.id, status); await Promise.all([loadUsers(), loadOverview(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not update account status.")); }
    finally { setBusy(""); }
  }
  async function deleteUser(user: any) {
    if (!window.confirm(`Permanently delete ${user.displayName} (${user.email})? This also deletes meetings they host, their meeting recordings, attendance data, private messages, and active sessions. This cannot be undone.`)) return;
    setBusy(`delete-user:${user.id}`); setError("");
    try { await api.adminDeleteUser(user.id); await Promise.all([loadUsers(), loadOverview(), loadMeetings(), loadRecordings(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not delete this account. Any recording that is still finalizing must finish first.")); }
    finally { setBusy(""); }
  }
  async function deleteRecording(item: any) {
    if (!window.confirm(`Permanently delete the recording of “${item.meetingTitle}”? The authenticated Cloudinary video, derived media, and all Backblaze B2 staging versions will be removed.`)) return;
    const id = String(item._id); setBusy(`delete-recording:${id}`); setError("");
    try { await api.adminDeleteRecording(id); await Promise.all([loadRecordings(), loadOverview(), loadEvents()]); }
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
      <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recent system activity</h2><p>Latest persisted backend and audit events.</p></div><button className="text-action" onClick={() => setTab("Activity")}>View all activity</button></div><div className="admin-filters"><input className="admin-search" value={recentActivitySearch} onChange={(event) => { setRecentActivitySearch(event.target.value); setRecentActivityPage(1); }} placeholder="Search recent activity" aria-label="Search recent activity"/><select className="admin-filter-select" aria-label="Filter recent activity" value={recentActivityCategory} onChange={(event) => { setRecentActivityCategory(event.target.value); setRecentActivityPage(1); }}><option value="">All categories</option>{["traffic", "page_view", "auth", "meeting", ...(RECORDING_UI_ENABLED ? ["recording"] : []), "admin", "system"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select><select className="admin-filter-select" aria-label="Sort recent activity" value={recentActivitySort} onChange={(event) => { setRecentActivitySort(event.target.value); setRecentActivityPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div>{loading.recentActivity ? <AdminPanelSkeleton rows={5}/> : sectionErrors.recentActivity ? <AdminRetry message={sectionErrors.recentActivity} onRetry={() => void loadRecentActivity()}/> : <ActivityList events={recentEvents}/>}<AdminPagination value={recentActivityPagination} onChange={setRecentActivityPage}/></section>
    </>}

    {tab === "Meetings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Meeting management</h2><p>Paginated meeting records with hosts, attendance, schedules and administrative controls.</p></div><div className="admin-filters"><input className="admin-search" value={meetingSearch} onChange={(event) => { setMeetingSearch(event.target.value); setMeetingPage(1); }} placeholder="Search title, slug or host" aria-label="Search meetings"/><select className="admin-filter-select" value={meetingStatus} onChange={(event) => { setMeetingStatus(event.target.value); setMeetingPage(1); }}><option value="">All statuses</option><option value="scheduled">Scheduled</option><option value="live">Live</option><option value="ended">Ended</option><option value="cancelled">Cancelled</option></select><select className="admin-filter-select" aria-label="Sort meetings" value={meetingSort} onChange={(event) => { setMeetingSort(event.target.value); setMeetingPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>{loading.meetings ? <AdminPanelSkeleton rows={6}/> : sectionErrors.meetings ? <AdminRetry message={sectionErrors.meetings} onRetry={() => void loadMeetings()}/> : meetings.length === 0 ? <div className="admin-inline-empty">No matching meetings.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting</th><th>Status</th><th>Schedule / duration</th><th>People</th>{RECORDING_UI_ENABLED && <th>Recording</th>}<th>Actions</th></tr></thead><tbody>{meetings.map((meeting) => <tr key={meeting.slug}><td><b>{meeting.title}</b><small>{meeting.ownerName} · {meeting.slug}</small></td><td><span className={`admin-status admin-status-${meeting.status}`}>{meeting.status}</span></td><td>{formatDate(meeting.startedAt || meeting.startsAt)}<small>{meeting.durationMinutes} min planned</small></td><td>{meeting.onlineNow} online<small>{meeting.attendanceCount} attendance records</small></td>{RECORDING_UI_ENABLED && <td>{meeting.recordingStatus || "idle"}<small>{meeting.recordingCount} recordings</small></td>}<td><div className="admin-row-actions"><button onClick={() => void openAttendance(meeting)}>Attendance</button>{meeting.status === "live" && <button className="admin-danger-link" disabled={busy === `terminate:${meeting.slug}`} onClick={() => void terminate(meeting)}>{busy === `terminate:${meeting.slug}` ? "Ending…" : "Terminate"}</button>}<button className="admin-danger-link" disabled={busy === `delete-meeting:${meeting.slug}`} onClick={() => void deleteMeeting(meeting)}>{busy === `delete-meeting:${meeting.slug}` ? "Deleting…" : "Delete"}</button></div></td></tr>)}</tbody></table></div>}<AdminPagination value={meetingPagination} onChange={setMeetingPage}/></section>}

    {tab === "Users" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Platform accounts and sessions</h2><p>Only public account fields and session activity are shown.</p></div><div className="admin-filters"><input className="admin-search" value={search} onChange={(event) => { setSearch(event.target.value); setUserPage(1); }} placeholder="Search name or email" aria-label="Search accounts"/><select className="admin-filter-select" aria-label="Filter account status" value={userStatus} onChange={(event) => { setUserStatusFilter(event.target.value); setUserPage(1); }}><option value="">All account statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select><select className="admin-filter-select" aria-label="Sort accounts" value={userSort} onChange={(event) => { setUserSort(event.target.value); setUserPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>{loading.users ? <AdminPanelSkeleton rows={6}/> : sectionErrors.users ? <AdminRetry message={sectionErrors.users} onRetry={() => void loadUsers()}/> : users.length === 0 ? <div className="admin-inline-empty">No matching user accounts.</div> : <div className="admin-user-list">{users.map((user) => <article className="admin-user-row" key={user.id}><ProfilePhoto name={user.displayName} src={user.picture} className="admin-user-photo" size={96}/><div className="admin-user-main"><b>{user.displayName}</b><span>{user.email}</span><small>{user.platformRole === "system_admin" ? "System administrator" : "Registered account"} · Created {formatDate(user.createdAt)}</small><small>{user.sessions?.length || 0} valid session(s) {user.sessions?.length ? `· Last active ${formatDate(user.sessions[0].lastSeenAt)}` : ""}</small>{user.sessions?.slice(0, 2).map((session: any, index: number) => <small key={`${session.createdAt}-${index}`} title={session.userAgent || "Browser session"}>{session.userAgent || "Browser session"}</small>)}</div><span className={`admin-status admin-status-${user.accountStatus}`}>{user.accountStatus}</span>{user.platformRole !== "system_admin" && <><button className={user.accountStatus === "suspended" ? "admin-action-button" : "admin-danger-button"} disabled={busy === `user:${user.id}`} onClick={() => void setUserStatus(user, user.accountStatus === "suspended" ? "active" : "suspended")}>{user.accountStatus === "suspended" ? "Reactivate" : "Suspend"}</button><button className="admin-danger-button" disabled={busy === `delete-user:${user.id}`} onClick={() => void deleteUser(user)}>{busy === `delete-user:${user.id}` ? "Deleting…" : "Delete account"}</button></>}</article>)}</div>}<AdminPagination value={userPagination} onChange={setUserPage}/></section>}

    {tab === "Recordings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recording inventory</h2><p>Consent, egress, upload, 30-day retention and deletion states from the database.</p></div><div className="admin-filters"><input className="admin-search" value={recordingSearch} onChange={(event) => { setRecordingSearch(event.target.value); setRecordingPage(1); }} placeholder="Search meeting or host" aria-label="Search recordings"/><select className="admin-filter-select" value={recordingStatus} onChange={(event) => { setRecordingStatus(event.target.value); setRecordingPage(1); }}><option value="">All statuses</option>{["consent_pending", "recording", "uploading", "ready", "failed", "declined"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select><select className="admin-filter-select" aria-label="Sort recordings" value={recordingSort} onChange={(event) => { setRecordingSort(event.target.value); setRecordingPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>{loading.recordings ? <AdminPanelSkeleton rows={6}/> : sectionErrors.recordings ? <AdminRetry message={sectionErrors.recordings} onRetry={() => void loadRecordings()}/> : recordings.length === 0 ? <div className="admin-inline-empty">No matching recording requests.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting / host</th><th>Status</th><th>Participants</th><th>Started / ended</th><th>Expires</th><th>Duration / size</th><th>Actions</th></tr></thead><tbody>{recordings.map((item) => <tr key={String(item._id)}><td><b>{item.meetingTitle}</b><small>{item.hostName} · {item.meetingSlug}</small></td><td><span className={`admin-status admin-status-${item.status}`}>{item.status}</span>{item.status === "uploading" && <small>{item.uploadProgressPercent || 0}% uploaded</small>}{item.lastError && <small title={item.lastError}>Upload issue</small>}{item.lastDeletionError && <small title={item.lastDeletionError}>Cleanup retry scheduled</small>}</td><td>{item.participants?.length || 0}</td><td>{formatDate(item.startedAt)}<small>{formatDate(item.endedAt)}</small></td><td>{formatDate(item.expiresAt)}</td><td>{duration(item.durationSeconds)}<small>{formatBytes(item.fileSize)} · {item.uploadAttempts || 0} upload attempts</small></td><td><button className="admin-danger-link" disabled={busy === `delete-recording:${String(item._id)}`} onClick={() => void deleteRecording(item)}>{busy === `delete-recording:${String(item._id)}` ? "Deleting…" : "Delete"}</button></td></tr>)}</tbody></table></div>}<AdminPagination value={recordingPagination} onChange={setRecordingPage}/></section>}

    {tab === "Activity" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>System activity and audit log</h2><p>Searchable, paginated backend events and administrator actions.</p></div><div className="admin-filters"><input className="admin-search" value={activitySearch} onChange={(event) => { setActivitySearch(event.target.value); setActivityPage(1); }} placeholder="Search action, actor or route" aria-label="Search activity"/><select className="admin-filter-select" value={activityCategory} onChange={(event) => { setActivityCategory(event.target.value); setActivityPage(1); }}><option value="">All categories</option>{["traffic", "page_view", "auth", "meeting", ...(RECORDING_UI_ENABLED ? ["recording"] : []), "admin", "system"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select><select className="admin-filter-select" aria-label="Sort activity" value={activitySort} onChange={(event) => { setActivitySort(event.target.value); setActivityPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>{loading.activity ? <AdminPanelSkeleton rows={8}/> : sectionErrors.activity ? <AdminRetry message={sectionErrors.activity} onRetry={() => void loadEvents()}/> : <ActivityList events={events}/>}<AdminPagination value={activityPagination} onChange={setActivityPage}/></section>}

    {selectedMeeting && <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedMeeting(null); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-label={`Attendance for ${selectedMeeting.title}`}><header><div><h2>{selectedMeeting.title}</h2><p>Attendance sessions · repeat visits are listed separately.</p></div><button onClick={() => setSelectedMeeting(null)} aria-label="Close attendance">×</button></header>{loading.attendance ? <AdminPanelSkeleton rows={5}/> : sectionErrors.attendance ? <AdminRetry message={sectionErrors.attendance} onRetry={() => void openAttendance(selectedMeeting, attendancePagination.page)}/> : attendance.length === 0 ? <div className="admin-inline-empty">No attendance events have been recorded for this meeting yet. Configure the LiveKit room webhook to capture connection events.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Participant</th><th>Identity type</th><th>Joined</th><th>Left</th><th>Duration</th></tr></thead><tbody>{attendance.map((item) => <tr key={item.identity}><td><b>{item.displayName}</b></td><td>{item.isGuest ? "Guest" : "Google account"}{item.onlineNow && <small>Online now</small>}</td><td>{formatDate(item.joinedAt)}</td><td>{formatDate(item.leftAt)}</td><td>{duration(item.durationSeconds)}</td></tr>)}</tbody></table></div>}{!loading.attendance && !sectionErrors.attendance && attendance.length > 0 && <AdminPagination value={attendancePagination} onChange={(page) => void openAttendance(selectedMeeting, page)}/>}</section></div>}
    <div className="admin-footer-note">Last update: {formatDate(overview?.generatedAt)} · Analytics and records are queried from MongoDB and LiveKit. List views load one page at a time.</div>
  </div>;
}

function ActivityList({ events }: { events: any[] }) {
  if (!events.length) return <div className="admin-inline-empty">No recent events have been recorded.</div>;
  return <div className="admin-activity-list">{events.map((event, index) => <article className="admin-activity-row" key={String(event._id || `${event.action}-${index}`)}><span className={`admin-activity-icon activity-${event.category || "system"}`}>{String(event.category || "SYS").slice(0, 1).toUpperCase()}</span><div><b>{String(event.action || "system_event").replaceAll("_", " ")}</b><small>{event.actorName || "System"}{event.meetingSlug ? ` · ${event.meetingSlug}` : ""}{event.path ? ` · ${event.path}` : ""}</small></div><time>{formatDate(event.createdAt)}</time></article>)}</div>;
}
