import { useCallback, useEffect, useMemo, useState } from "react";
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
type AdminTab = typeof ADMIN_TABS[number];

export function AdminCenterPage() {
  const [tab, setTab] = useState<AdminTab>("Overview");
  const [overview, setOverview] = useState<any>(null);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => { const result = await api.adminOverview(); setOverview(result); }, []);
  const loadMeetings = useCallback(async () => { const result = await api.adminMeetings(); setMeetings(result.meetings || []); }, []);
  const loadUsers = useCallback(async () => { const result = await api.adminUsers(search); setUsers(result.users || []); }, [search]);
  const loadRecordings = useCallback(async () => { const result = await api.adminRecordings(); setRecordings(result.recordings || []); }, []);
  const loadEvents = useCallback(async () => { const result = await api.adminActivity(); setEvents(result.events || []); }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { await Promise.all([loadOverview(), loadMeetings(), loadUsers(), loadRecordings(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not load the admin control center.")); }
    finally { setLoading(false); }
  }, [loadOverview, loadMeetings, loadUsers, loadRecordings, loadEvents]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (tab !== "Overview") return;
    const timer = window.setInterval(() => { void loadOverview().catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, [tab, loadOverview]);
  useEffect(() => { if (tab === "Users") void loadUsers().catch((cause) => setError(messageOf(cause, "Could not load users."))); }, [tab, loadUsers]);

  async function openAttendance(meeting: any) {
    setSelectedMeeting(meeting); setAttendance([]); setBusy(`attendance:${meeting.slug}`);
    try { const result = await api.adminAttendance(meeting.slug); setAttendance(result.attendance || []); }
    catch (cause) { setError(messageOf(cause, "Could not load meeting attendance.")); }
    finally { setBusy(""); }
  }

  async function terminate(meeting: any) {
    if (!window.confirm(`Terminate “${meeting.title}” for everyone? This immediately disconnects all participants.`)) return;
    setBusy(`terminate:${meeting.slug}`); setError("");
    try { await api.adminTerminateMeeting(meeting.slug); await Promise.all([loadMeetings(), loadOverview(), loadEvents()]); }
    catch (cause) { setError(messageOf(cause, "Could not terminate this meeting.")); }
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

  const stats = overview?.stats || {};
  const maxTraffic = useMemo(() => Math.max(1, ...(overview?.trends || []).map((row: any) => Number(row.pageViews || 0) + Number(row.requests || 0))), [overview]);

  return <div className="management-page admin-center-page page-enter">
    <div className="management-heading"><div><p className="section-overline">PLATFORM OPERATIONS</p><h1>System Admin Control Center</h1><p>Live operational data, account controls, meeting management, and audit history.</p></div><button className="button button-soft" onClick={() => void refresh()} disabled={loading}>Refresh data</button></div>
    <div className="admin-access-note"><span className="admin-access-dot"/> Signed in with authorized system administrator permissions. Account credentials and session tokens are never displayed.</div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="admin-tabs" role="tablist" aria-label="Admin sections">{ADMIN_TABS.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "admin-tab admin-tab-active" : "admin-tab"} onClick={() => { setTab(item); setSelectedMeeting(null); }}>{item}</button>)}</div>

    {tab === "Overview" && <>
      {loading && !overview ? <div className="management-empty">Loading platform metrics…</div> : <>
        <div className="admin-metric-grid">{[
          ["Total meetings", stats.totalMeetings ?? 0], ["Active meetings", stats.activeMeetings ?? 0], ["Completed meetings", stats.completedMeetings ?? 0],
          ["Registered accounts", stats.registeredAccounts ?? 0], ["Active sessions", stats.activeSessions ?? 0], ["Online participants", stats.onlineParticipants ?? 0],
          ["Total participants", stats.uniqueParticipants ?? 0], ["Guest participants · 30 days", stats.guestParticipants ?? 0], ["Page views", stats.pageViews ?? 0], ["Page loads", stats.pageLoads ?? 0], ["API requests", stats.apiRequests ?? 0],
        ].map(([label, value]) => <article className="admin-metric-card" key={String(label)}><span>{label}</span><b>{Number(value).toLocaleString()}</b></article>)}</div>
        <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Traffic and platform activity</h2><p>Persisted page-view and API request events, last 30 days.</p></div><small>{formatDate(overview?.generatedAt)}</small></div>
          {!overview?.trends?.length ? <div className="admin-inline-empty">No traffic history has been collected in this period yet.</div> : <div className="admin-trend-chart">{overview.trends.map((row: any) => { const total = Number(row.pageViews || 0) + Number(row.requests || 0); return <div className="admin-trend-day" key={row.day} title={`${row.day}: ${row.pageViews} page views, ${row.requests} API requests`}><span className="admin-trend-bar"><i style={{ height: `${Math.max(3, Number(row.pageViews || 0) / maxTraffic * 100)}%` }}/><b style={{ height: `${Math.max(3, Number(row.requests || 0) / maxTraffic * 100)}%` }}/></span><small>{String(row.day).slice(5)}</small><em>{total}</em></div>; })}</div>}
          <div className="admin-chart-legend"><span><i className="legend-pageviews"/> Page views</span><span><i className="legend-requests"/> API requests</span></div>
        </section>
        <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recent system activity</h2><p>Latest recorded backend events.</p></div><button className="text-action" onClick={() => setTab("Activity")}>View all</button></div><ActivityList events={overview?.recentActivity || []}/></section>
      </>}
    </>}

    {tab === "Meetings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Meeting management</h2><p>Hosts, durations, actual attendance and recording status.</p></div><small>{meetings.length} loaded</small></div>{meetings.length === 0 ? <div className="admin-inline-empty">No meetings have been created yet.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting</th><th>Status</th><th>Schedule / duration</th><th>People</th><th>Recording</th><th>Actions</th></tr></thead><tbody>{meetings.map((meeting) => <tr key={meeting.slug}><td><b>{meeting.title}</b><small>{meeting.ownerName} · {meeting.slug}</small></td><td><span className={`admin-status admin-status-${meeting.status}`}>{meeting.status}</span></td><td>{formatDate(meeting.startedAt || meeting.startsAt)}<small>{meeting.durationMinutes} min planned</small></td><td>{meeting.onlineNow} online<small>{meeting.attendanceCount} attendance records</small></td><td>{meeting.recordingStatus || "idle"}<small>{meeting.recordingCount} recordings</small></td><td><div className="admin-row-actions"><button onClick={() => void openAttendance(meeting)}>Attendance</button>{meeting.status === "live" && <button className="admin-danger-link" disabled={busy === `terminate:${meeting.slug}`} onClick={() => void terminate(meeting)}>{busy === `terminate:${meeting.slug}` ? "Ending…" : "Terminate"}</button>}</div></td></tr>)}</tbody></table></div>}</section>}

    {tab === "Users" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Platform accounts and sessions</h2><p>Only public account fields and session activity are shown.</p></div><input className="admin-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" aria-label="Search accounts"/></div>{users.length === 0 ? <div className="admin-inline-empty">No matching user accounts.</div> : <div className="admin-user-list">{users.map((user) => <article className="admin-user-row" key={user.id}><ProfilePhoto name={user.displayName} src={user.picture} className="admin-user-photo" size={96}/><div className="admin-user-main"><b>{user.displayName}</b><span>{user.email}</span><small>{user.platformRole === "system_admin" ? "System administrator" : "Registered account"} · Created {formatDate(user.createdAt)}</small><small>{user.sessions?.length || 0} valid session(s) {user.sessions?.length ? `· Last active ${formatDate(user.sessions[0].lastSeenAt)}` : ""}</small>{user.sessions?.slice(0, 2).map((session: any, index: number) => <small key={`${session.createdAt}-${index}`} title={session.userAgent || "Browser session"}>{session.userAgent || "Browser session"}</small>)}</div><span className={`admin-status admin-status-${user.accountStatus}`}>{user.accountStatus}</span>{user.platformRole !== "system_admin" && <button className={user.accountStatus === "suspended" ? "admin-action-button" : "admin-danger-button"} disabled={busy === `user:${user.id}`} onClick={() => void setUserStatus(user, user.accountStatus === "suspended" ? "active" : "suspended")}>{user.accountStatus === "suspended" ? "Reactivate" : "Suspend"}</button>}</article>)}</div>}</section>}

    {tab === "Recordings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Recording inventory</h2><p>Consent, egress, upload and retention states from the database.</p></div><small>{recordings.length} latest</small></div>{recordings.length === 0 ? <div className="admin-inline-empty">No meeting recording requests yet.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Meeting / host</th><th>Status</th><th>Participants</th><th>Started / ended</th><th>Duration / size</th><th>Upload attempts</th></tr></thead><tbody>{recordings.map((item) => <tr key={String(item._id)}><td><b>{item.meetingTitle}</b><small>{item.hostName} · {item.meetingSlug}</small></td><td><span className={`admin-status admin-status-${item.status}`}>{item.status}</span>{item.status === "uploading" && <small>{item.uploadProgressPercent || 0}% uploaded</small>}{item.lastError && <small title={item.lastError}>Upload issue</small>}</td><td>{item.participants?.length || 0}</td><td>{formatDate(item.startedAt)}<small>{formatDate(item.endedAt)}</small></td><td>{duration(item.durationSeconds)}<small>{formatBytes(item.fileSize)}</small></td><td>{item.uploadAttempts || 0}</td></tr>)}</tbody></table></div>}</section>}

    {tab === "Activity" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>System activity and audit log</h2><p>Actions recorded by authentication, traffic, meeting, recording and admin endpoints.</p></div><small>{events.length} events</small></div><ActivityList events={events}/></section>}

    {selectedMeeting && <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedMeeting(null); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-label={`Attendance for ${selectedMeeting.title}`}><header><div><h2>{selectedMeeting.title}</h2><p>Attendance sessions · repeat visits are listed separately.</p></div><button onClick={() => setSelectedMeeting(null)} aria-label="Close attendance">×</button></header>{busy === `attendance:${selectedMeeting.slug}` ? <div className="management-empty">Loading attendance…</div> : attendance.length === 0 ? <div className="admin-inline-empty">No attendance events have been recorded for this meeting yet. Configure the LiveKit room webhook to capture connection events.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Participant</th><th>Identity type</th><th>Joined</th><th>Left</th><th>Duration</th></tr></thead><tbody>{attendance.map((item) => <tr key={item.identity}><td><b>{item.displayName}</b></td><td>{item.isGuest ? "Guest" : "Google account"}{item.onlineNow && <small>Online now</small>}</td><td>{formatDate(item.joinedAt)}</td><td>{formatDate(item.leftAt)}</td><td>{duration(item.durationSeconds)}</td></tr>)}</tbody></table></div>}</section></div>}
    <div className="admin-footer-note">Last update: {formatDate(overview?.generatedAt)} · Metrics are sourced from MongoDB and LiveKit room state, not sample dashboard data.</div>
  </div>;
}

function ActivityList({ events }: { events: any[] }) {
  if (!events.length) return <div className="admin-inline-empty">No recent events have been recorded.</div>;
  return <div className="admin-activity-list">{events.map((event, index) => <article className="admin-activity-row" key={String(event._id || `${event.action}-${index}`)}><span className={`admin-activity-icon activity-${event.category || "system"}`}>{String(event.category || "SYS").slice(0, 1).toUpperCase()}</span><div><b>{String(event.action || "system_event").replaceAll("_", " ")}</b><small>{event.actorName || "System"}{event.meetingSlug ? ` · ${event.meetingSlug}` : ""}{event.path ? ` · ${event.path}` : ""}</small></div><time>{formatDate(event.createdAt)}</time></article>)}</div>;
}
