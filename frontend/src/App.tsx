import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { LiveKitRoom, ParticipantTile, RoomAudioRenderer, useChat, useLocalParticipant, useParticipants, useRoomContext, useTracks } from "@livekit/components-react";
import { RoomEvent, Track, VideoPreset } from "livekit-client";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, AudioLines, CalendarClock, CalendarDays, Check,
  CheckCircle2, CircleHelp, Clock3, Copy, DoorOpen, HeartHandshake, Home,
  Link2, LoaderCircle, LogIn, LogOut, Menu, Mic, Plus, Share2, ShieldCheck,
  Sparkles, Users, Video, VideoIcon, X, Sun, Moon, ImagePlus, Trash2, MessageCircle,
  Hand, Send, MonitorUp, Maximize2, Minimize2, ChevronLeft, ChevronRight, Smile, ChevronDown, Download,
} from "lucide-react";
import { api, clearAuthToken, getAuthToken, saveAuthToken } from "./api";
import type { JoinSession, Meeting, User } from "./types";

interface AppContextValue {
  user: User | null;
  meetings: Meeting[];
  publicMeetings: Meeting[];
  loadingMeetings: boolean;
  refreshMeetings: () => Promise<void>;
  openAuth: () => void;
  openSchedule: (instant?: boolean) => void;
  signOut: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const THEME_STORAGE_KEY = "meet-enihakole-theme";

function getInitialTheme(): "light" | "dark" {
  try { return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
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

function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function meetingImage(meeting: Meeting) {
  return meeting.thumbnailUrl || "/og-default.png";
}

function getMeetingStateLabel(meeting: Meeting) {
  if (meeting.status === "live") return "Live now";
  if (meeting.status === "ended") return "Ended";
  if (meeting.status === "cancelled") return "Cancelled";
  return "Scheduled";
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [publicMeetings, setPublicMeetings] = useState<Meeting[]>([]);
  const [loadingMeetings, setLoadingMeetings] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [instantMode, setInstantMode] = useState(false);
  const [scheduleAfterAuth, setScheduleAfterAuth] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === "light" ? "dark" : "light");
  }, []);

  useEffect(() => {
    let resetTimer = 0;
    const onScroll = () => {
      document.documentElement.classList.add("is-scrolling");
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => document.documentElement.classList.remove("is-scrolling"), 850);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("scroll", onScroll, true); window.clearTimeout(resetTimer); document.documentElement.classList.remove("is-scrolling"); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Theme still applies for this session. */ }
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === "light" ? "#fbf7f2" : "#130d10";
  }, [theme]);

  const refreshMeetings = useCallback(async () => {
    setLoadingMeetings(true);
    const [mineResult, publicResult] = await Promise.allSettled([
      getAuthToken() ? api.myMeetings() : Promise.resolve({ meetings: [] as Meeting[] }),
      api.publicMeetings(),
    ]);
    setMeetings(mineResult.status === "fulfilled" ? mineResult.value.meetings : []);
    setPublicMeetings(publicResult.status === "fulfilled" ? publicResult.value.meetings : []);
    setLoadingMeetings(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      if (getAuthToken()) {
        try {
          const result = await api.me();
          if (!cancelled) setUser(result.user);
        } catch {
          clearAuthToken();
        }
      }
      if (!cancelled) await refreshMeetings();
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
  const openSchedule = useCallback((instant = false) => {
    setInstantMode(instant);
    if (!user) {
      setScheduleAfterAuth(true);
      setAuthOpen(true);
      return;
    }
    setScheduleOpen(true);
  }, [user]);
  const signOut = useCallback(() => {
    clearAuthToken();
    setUser(null);
    setMeetings([]);
    void refreshMeetings();
  }, [refreshMeetings]);

  const contextValue = useMemo<AppContextValue>(() => ({
    user, meetings, publicMeetings, loadingMeetings, refreshMeetings, openAuth, openSchedule, signOut, theme, toggleTheme,
  }), [user, meetings, publicMeetings, loadingMeetings, refreshMeetings, openAuth, openSchedule, signOut, theme, toggleTheme]);

  return (
    <AppContext.Provider value={contextValue}>
      <Routes>
        <Route path="/" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><Dashboard /></AppShell>} />
        <Route path="/meetings" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><MeetingsPage /></AppShell>} />
        <Route path="/meeting/:slug" element={<MeetingPage />} />
        <Route path="/room/:slug" element={<MeetingRoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {authOpen && <AuthModal onClose={() => { setAuthOpen(false); setScheduleAfterAuth(false); }} onAuthenticated={(nextUser, token) => {
        saveAuthToken(token);
        setUser(nextUser);
        setAuthOpen(false);
        if (scheduleAfterAuth) {
          setScheduleOpen(true);
          setScheduleAfterAuth(false);
        }
        void refreshMeetings();
      }} />}
      {scheduleOpen && <ScheduleModal instant={instantMode} onClose={() => setScheduleOpen(false)} onCreated={async () => {
        await refreshMeetings();
      }} />}
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

function InstallPwaButton() {
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const [deferred, setDeferred] = useState<PwaPromptEvent | null>(() => ((window as unknown as { __pwaPrompt?: PwaPromptEvent }).__pwaPrompt ?? null));
  const [installed, setInstalled] = useState(isStandalone);
  const [iosTip, setIosTip] = useState(false);
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

  return (
    <div className="pwa-install">
      {iosTip && <div className="pwa-install-tip" role="status">To install, tap <b>Share</b> in Safari, then choose <b>Add to Home Screen</b>.<button type="button" onClick={() => setIosTip(false)} aria-label="Close"><X size={14}/></button></div>}
      <button type="button" className="pwa-install-button" onClick={() => void install()} title="Install app" aria-label="Install MEET ENIHAKOLE app"><Download size={20}/><span>Install app</span></button>
    </div>
  );
}

function AppShell({ children, mobileNavOpen, setMobileNavOpen }: { children: ReactNode; mobileNavOpen: boolean; setMobileNavOpen: (v: boolean) => void }) {
  const { user, openAuth, openSchedule, signOut } = useAppContext();
  const location = useLocation();
  const active = location.pathname === "/meetings" ? "meetings" : "home";
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || window.innerWidth > 720) return;
      if (mobileNavOpen ? touch.clientX < 290 : touch.clientX <= 22) start = { x: touch.clientX, y: touch.clientY };
    };
    const onEnd = (event: TouchEvent) => {
      if (!start || window.innerWidth > 720) { start = null; return; }
      const touch = event.changedTouches[0];
      if (!touch) { start = null; return; }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 72 && Math.abs(dx) > Math.abs(dy) * 1.45) {
        if (!mobileNavOpen && dx > 0 && start.x <= 22) setMobileNavOpen(true);
        if (mobileNavOpen && dx < 0) setMobileNavOpen(false);
      }
      start = null;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => { document.removeEventListener("touchstart", onStart); document.removeEventListener("touchend", onEnd); };
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
          <Link to="/meetings" className={`side-link ${active === "meetings" ? "side-link-active" : ""}`}><CalendarDays size={18} /><span>My meetings</span></Link>
        </nav>
        <div className="sidebar-guidance">
          <div className="guidance-icon"><HeartHandshake size={18} /></div>
          <strong>A space to connect</strong>
          <p>Pray together, rehearse, and stay close — wherever life takes you.</p>
        </div>
        <div className="sidebar-bottom">
          <button className="side-link quiet-link" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Help centre will be added in a future release." } }))}><CircleHelp size={18} /><span>Help & support</span></button>
          <div className="sidebar-version">MEET ENIHAKOLE <span>EARLY ACCESS</span></div>
        </div>
      </aside>
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <div className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>ENIHAKOLE CHOIR</span><span className="breadcrumb-slash">/</span><strong>{active === "meetings" ? "My meetings" : "Workspace"}</strong></div>
          <div className="topbar-actions">
            <button className="topbar-help" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Use Start instant meeting for an immediate call, or Schedule a meeting to share a future invitation." } }))}><CircleHelp size={16} /><span>Need help?</span></button>
            <ThemeToggle />
            {user ? (
              <div className="profile-menu">
                <span className="profile-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
                <span className="profile-name">{user.displayName}</span>
                <button className="icon-button profile-signout" title="Sign out" aria-label="Sign out" onClick={signOut}><LogOut size={17} /></button>
              </div>
            ) : <button className="button button-soft button-small" onClick={openAuth}><LogIn size={16} /> Sign in</button>}
            <button className="button button-primary button-small topbar-create" onClick={() => openSchedule(false)}><Plus size={17} /> Schedule</button>
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="page-footer"><span>© {new Date().getFullYear()} MEET ENIHAKOLE</span><span>Made for connection, prayer, and community</span></footer>
      </div>
      <nav className={`mobile-bottom-nav mbn-${active}`} aria-label="Mobile navigation">
        <span className="mbn-bar" aria-hidden="true"/>
        <span className="mbn-bubble" aria-hidden="true"><span key={active} className="mbn-bubble-icon">{active === "home" ? <Home size={22}/> : <CalendarDays size={22}/>}</span></span>
        <Link to="/" className={active === "home" ? "mobile-nav-active" : ""} aria-current={active === "home" ? "page" : undefined}><Home size={20}/><span>Home</span></Link>
        <button type="button" className="mbn-fab" aria-label="Create meeting" onClick={() => openSchedule(false)}><Plus size={26} strokeWidth={2.4}/></button>
        <Link to="/meetings" className={active === "meetings" ? "mobile-nav-active" : ""} aria-current={active === "meetings" ? "page" : undefined}><CalendarDays size={20}/><span>My meetings</span></Link>
      </nav>
      <InstallPwaButton />
    </div>
  );
}

function Dashboard() {
  const { user, meetings, publicMeetings, loadingMeetings, openAuth, openSchedule } = useAppContext();
  const navigate = useNavigate();
  const upcoming = [...meetings, ...publicMeetings]
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
            <button className="button button-cream" onClick={() => openSchedule(true)}><Video size={17} /> Start instant meeting <ArrowRight size={16} /></button>
            <button className="hero-secondary" onClick={() => openSchedule(false)}><CalendarClock size={17} /> Schedule for later</button>
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
          <div className="stat-card"><span className="stat-icon stat-burgundy"><CalendarDays size={19}/></span><div><span className="stat-label">Upcoming meetings</span><strong>{loadingMeetings ? "—" : upcoming.filter((m) => m.status === "scheduled").length.toString().padStart(2, "0")}</strong><small>Ready when you are</small></div><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-gold"><Video size={19}/></span><div><span className="stat-label">Live right now</span><strong>{loadingMeetings ? "—" : String(liveCount).padStart(2, "0")}</strong><small>{liveCount ? "Join the conversation" : "Your room is waiting"}</small></div><span className="stat-sheen"/></div>
          <div className="stat-card"><span className="stat-icon stat-rose"><Users size={19}/></span><div><span className="stat-label">Your community</span><strong>ENIHAKOLE</strong><small>Stronger when connected</small></div><span className="stat-sheen"/></div>
        </div>
      </section>

      <section className="section-block meetings-section">
        <div className="section-heading"><div><p className="section-overline">DON'T MISS A MOMENT</p><h2>{nextMeeting?.status === "live" ? "Happening now" : "Coming together soon"}</h2></div><button className="button button-outline button-small" onClick={() => openSchedule(false)}><Plus size={15}/> Create a meeting</button></div>
        {loadingMeetings ? <div className="loading-surface"><LoaderCircle className="spin" size={24}/><span>Finding your next gathering…</span></div> : upcoming.length ? (
          <div className="meeting-card-grid">{upcoming.map((meeting) => <MeetingCard key={meeting.slug} meeting={meeting} />)}</div>
        ) : (
          <div className="empty-state"><div className="empty-icon"><CalendarClock size={23}/></div><div><h3>Your next gathering starts here</h3><p>Create a meeting and send the link to your choir. Everyone can join from a phone or computer.</p></div><button className="button button-primary" onClick={() => user ? openSchedule(false) : openAuth()}><Plus size={16}/> Schedule your first meeting</button></div>
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
      <Link to={`/meeting/${meeting.slug}`} className="meeting-cover" style={{ backgroundImage: `linear-gradient(90deg, rgba(29, 14, 20, .1), rgba(29, 14, 20, .05)), url("${meetingImage(meeting)}")` }}>
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
  const { user, meetings, publicMeetings, loadingMeetings, openAuth, openSchedule, refreshMeetings } = useAppContext();
  const visible = user ? meetings : publicMeetings;
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  const list = visible.filter((meeting) => {
    if (filter === "upcoming") return meeting.status === "scheduled" || meeting.status === "live";
    if (filter === "past") return meeting.status === "ended" || meeting.status === "cancelled";
    return true;
  }).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  useEffect(() => { void refreshMeetings(); }, [refreshMeetings]);
  return (
    <div className="meetings-page page-enter">
      <div className="page-title-row"><div><p className="eyebrow"><span className="eyebrow-dot"/> YOUR CALENDAR, TOGETHER</p><h1>My meetings</h1><p className="welcome-copy">Keep every prayer, rehearsal, and gathering in one place.</p></div><button className="button button-primary" onClick={() => user ? openSchedule(false) : openAuth()}><Plus size={17}/> Schedule a meeting</button></div>
      <div className="filter-bar"><div className="segmented-filter">{(["upcoming", "past", "all"] as const).map((value) => <button key={value} className={filter === value ? "filter-active" : ""} onClick={() => setFilter(value)}>{value === "upcoming" ? "Upcoming" : value === "past" ? "Past meetings" : "All meetings"}</button>)}</div><span className="meeting-count">{list.length} {list.length === 1 ? "meeting" : "meetings"}</span></div>
      {loadingMeetings ? <div className="loading-surface"><LoaderCircle className="spin" size={24}/><span>Loading meetings…</span></div> : list.length ? <div className="meeting-card-grid">{list.map((meeting) => <MeetingCard key={meeting.slug} meeting={meeting}/>)}</div> : <div className="empty-state empty-large"><div className="empty-icon"><CalendarDays size={23}/></div><div><h3>{filter === "past" ? "No past meetings yet" : "A fresh page for your next gathering"}</h3><p>{user ? "Your meetings will appear here as you schedule them." : "Sign in to create and manage meetings, or open an invitation link shared by your choir."}</p></div><button className="button button-primary" onClick={() => user ? openSchedule(false) : openAuth()}>{user ? <><Plus size={16}/> Schedule a meeting</> : <><LogIn size={16}/> Sign in to continue</>}</button></div>}
    </div>
  );
}

function MeetingPage() {
  const { slug = "" } = useParams();
  const { user, openAuth } = useAppContext();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.meeting(slug).then(({ meeting: result }) => {
      if (cancelled) return;
      setMeeting(result);
      setDisplayName(user?.displayName || "");
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load this meeting.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug, user]);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!meeting) return;
    if (!user && displayName.trim().length < 2) { setError("Enter your name before joining."); return; }
    setJoining(true); setError("");
    try {
      const result = await api.join(slug, displayName.trim());
      const session: JoinSession = { ...result, audio: micOn, video: cameraOn };
      sessionStorage.setItem(`meet-session:${slug}`, JSON.stringify(session));
      navigate(`/room/${encodeURIComponent(slug)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join this meeting.");
    } finally { setJoining(false); }
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

  return (
    <div className="meeting-landing">
      <header className="landing-topbar"><Link className="brand-lockup" to="/"><span className="brand-mark"><AudioLines size={22}/></span><span className="brand-words"><strong>MEET</strong><b>ENIHAKOLE</b><small>GATHER IN FAITH</small></span></Link><div className="landing-topbar-actions"><ThemeToggle/><button className="button button-soft button-small" onClick={share}><Share2 size={15}/> Share invitation</button></div></header>
      <main className="landing-layout">
        <section className="landing-details">
          <p className="eyebrow"><span className={`eyebrow-dot ${meeting.status === "live" ? "eyebrow-dot-live" : ""}`}/>{meeting.status === "live" ? "THE GATHERING IS LIVE" : ended ? "GATHERING CLOSED" : "YOU'RE INVITED"}</p>
          <h1>{meeting.title}</h1>
          <p className="landing-description">{meeting.description || "Join ENIHAKOLE CHOIR for a time to pray, connect, and lift our voices together."}</p>
          <div className="host-row"><span className="host-avatar"><AudioLines size={19}/></span><div><small>HOSTED BY</small><strong>{meeting.ownerName}</strong></div><span className="verified-host"><ShieldCheck size={14}/> Host</span></div>
          <div className="meeting-detail-list"><div><span className="detail-icon"><CalendarDays size={18}/></span><span><b>{formatDate(meeting.startsAt, { weekday: "long", year: "numeric" }, meeting.timezone)}</b><small>{formatTime(meeting.startsAt, meeting.timezone)} · {meeting.timezone || "Meeting time"}</small></span></div><div><span className="detail-icon"><Clock3 size={18}/></span><span><b>{meeting.durationMinutes} minutes</b><small>Planned gathering time</small></span></div><div><span className="detail-icon"><Users size={18}/></span><span><b>Join from anywhere</b><small>Phone, tablet, or computer</small></span></div></div>
          <button className="landing-share-link" onClick={share}><Link2 size={16}/> Share this invitation <ArrowRight size={15}/></button>
        </section>
        <section className="join-panel">
          <div className="join-cover" style={{ backgroundImage: `linear-gradient(180deg, rgba(23,12,16,.04), rgba(23,12,16,.58)), url("${meetingImage(meeting)}")` }}><div className="join-cover-brand"><AudioLines size={17}/> <span>MEET ENIHAKOLE</span></div><div className="join-cover-bottom"><span className="cover-tag">A PLACE TO GATHER</span><h2>One room.<br/><em>Many voices.</em></h2></div></div>
          <form className="join-form" onSubmit={join}>
            <div className="join-form-heading"><h2>{ended ? "This meeting has ended" : meeting.isOwner ? "Your meeting is ready" : meeting.status === "live" ? "Join the gathering" : "You're in the right place"}</h2><p>{ended ? "This invitation is no longer active." : meeting.isOwner ? "Start the room when you're ready. Your guests can join using the same link." : meeting.status === "live" ? "Enter your details and come on in." : "You can join as a guest when the host opens the room."}</p></div>
            {!user && !ended && <label className="field-label">Your name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="How should we call you?" minLength={2} maxLength={80} required autoComplete="name"/></label>}
            {!ended && <div className="join-preferences"><label className="toggle-row"><span className="toggle-icon"><VideoIcon size={16}/></span><span><b>Camera</b><small>Join with video</small></span><input type="checkbox" checked={cameraOn} onChange={(event) => setCameraOn(event.target.checked)} /></label><label className="toggle-row"><span className="toggle-icon"><Mic size={16}/></span><span><b>Microphone</b><small>Join with audio</small></span><input type="checkbox" checked={micOn} onChange={(event) => setMicOn(event.target.checked)} /></label></div>}
            {error && <div className="inline-error" role="alert">{error}{error.includes("Sign in") && <button type="button" className="error-link" onClick={openAuth}>Sign in</button>}</div>}
            {ended ? <Link to="/" className="button button-soft button-full"><ArrowLeft size={16}/> Back to home</Link> : <button className="button button-primary button-full join-submit" type="submit" disabled={joining}>{joining ? <LoaderCircle size={17} className="spin"/> : meeting.isOwner ? <Video size={17}/> : <DoorOpen size={17}/>} {joining ? "Preparing your room…" : meeting.isOwner ? "Start meeting" : meeting.status === "live" ? "Join meeting" : "Check room availability"}<ArrowRight size={16}/></button>}
            <p className="join-footnote"><ShieldCheck size={13}/> Your camera and microphone are only requested when you enter the room.</p>
          </form>
        </section>
      </main>
      <footer className="landing-footer"><span>© {new Date().getFullYear()} MEET ENIHAKOLE</span><span>Built for togetherness.</span></footer>
    </div>
  );
}

function MeetingRoomPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<JoinSession | null>(null);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`meet-session:${slug}`);
      if (raw) setSession(JSON.parse(raw) as JoinSession);
    } catch { setSession(null); }
  }, [slug]);

  async function endForEveryone() {
    if (!session || session.role !== "host") return;
    const confirmed = window.confirm("End this meeting for everyone in the room?");
    if (!confirmed) return;
    setEnding(true); setEndError("");
    try {
      await api.endMeeting(slug);
      sessionStorage.removeItem(`meet-session:${slug}`);
      navigate(`/meeting/${encodeURIComponent(slug)}`);
    } catch (cause) {
      setEndError(cause instanceof Error ? cause.message : "Could not end the meeting.");
    } finally { setEnding(false); }
  }

  if (!session) return <StandaloneError message="Your room session is missing or expired. Open the invitation again to rejoin." action={<Link className="button button-primary" to={`/meeting/${slug}`}>Return to meeting</Link>}/>;

  return (
    <div className="conference-page">
      <header className="conference-topbar"><Link to={`/meeting/${slug}`} className="conference-brand"><span className="brand-mark"><AudioLines size={19}/></span><span><b>MEET ENIHAKOLE</b><small>{session.meeting.title}</small></span></Link><div className="conference-room-status">IN THE ROOM <span className="conference-divider"/> {session.role === "host" ? "HOST" : "PARTICIPANT"}</div><div className="conference-header-actions"><ThemeToggle/><button className="button button-soft button-small" onClick={() => navigate(`/meeting/${slug}`)}><ArrowLeft size={15}/> Leave room</button></div></header>
      {endError && <div className="room-alert" role="alert">{endError}</div>}
      {disconnected && <div className="room-alert" role="status">You have disconnected from the call. <button onClick={() => navigate(`/meeting/${slug}`)}>Return to meeting</button></div>}
      <main className="conference-main">
        <div className="conference-title-row"><div><p className="section-overline">ENIHAKOLE CHOIR · LIVE CONFERENCE</p><h1>{session.meeting.title}</h1></div><div className="conference-tools"><span className="encrypted-pill"><ShieldCheck size={14}/> Secure connection</span>{session.role === "host" && <button className="button button-danger button-small" onClick={() => void endForEveryone()} disabled={ending}>{ending ? <LoaderCircle size={15} className="spin"/> : <X size={15}/>} End for everyone</button>}</div></div>
        <div className="conference-stage">
          <LiveKitRoom
            token={session.token}
            serverUrl={session.serverUrl}
            connect={true}
            audio={session.audio}
            video={session.video}
            options={{
              adaptiveStream: true,
              dynacast: true,
              videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
              publishDefaults: {
                videoEncoding: { maxBitrate: 1_500_000, maxFramerate: 30 },
                videoSimulcastLayers: [new VideoPreset(640, 360, 500_000, 20), new VideoPreset(320, 180, 150_000, 15)],
              },
            }}
            onDisconnected={() => setDisconnected(true)}
          >
            <ConferenceWorkspace meeting={session.meeting} role={session.role} onLeave={() => navigate(`/meeting/${slug}`)} onEndForEveryone={() => void endForEveryone()} ending={ending}/>
          </LiveKitRoom>
        </div>
        <div className="conference-bottom-note"><span><ShieldCheck size={15}/> {session.meeting.visibility === "public" ? "This gathering is publicly listed." : "This meeting uses an unlisted invitation link."}</span><span>For the clearest call, use headphones and a stable connection.</span></div>
      </main>
    </div>
  );
}

type RoomSignal = { kind: "hand"; raised: boolean } | { kind: "reaction"; emoji: string; id: string };
type FloatingReaction = { id: string; emoji: string; name: string };
const REACTION_SET = ["🙏", "❤️", "👏", "🙌", "😊", "🎉", "✨", "💛", "🕊️", "👍"];

function ConferenceWorkspace({ meeting, role, onLeave, onEndForEveryone, ending }: { meeting: Meeting; role: "host" | "participant"; onLeave: () => void; onEndForEveryone: () => void; ending: boolean }) {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const trackRefs = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const { chatMessages, send, isSending } = useChat();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Record<string, boolean>>({});
  const [handRaised, setHandRaised] = useState(false);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [page, setPage] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const localIdentity = localParticipant.identity;
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
          const item = { id: data.id, emoji: data.emoji, name: participant?.name || "A participant" };
          setReactions((current) => [...current.slice(-5), item]);
          window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== item.id)), 3200);
        }
      } catch { /* Ignore unrelated or malformed room data. */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room]);

  useEffect(() => {
    const onFullscreen = () => setFullScreen(document.fullscreenElement === fullScreenRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chatMessages.length, messagesOpen]);

  async function broadcast(signal: RoomSignal) {
    try {
      await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), { reliable: true, topic: "meet-enihakole-ui" });
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Your action could not be sent. Check your connection." } }));
    }
  }
  async function chooseDevice(kind: "audioinput" | "videoinput", deviceId: string) {
    try {
      await room.switchActiveDevice(kind, deviceId);
      setDeviceMenu(null);
    } catch {
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Could not switch that device. Check browser permissions and try again." } }));
    }
  }
  async function toggleHand() {
    const next = !handRaised;
    setHandRaised(next);
    setRaisedHands((current) => ({ ...current, [localIdentity]: next }));
    await broadcast({ kind: "hand", raised: next });
  }
  async function react(emoji: string) {
    setReactionsOpen(false);
    const id = `${localIdentity}-${Date.now()}`;
    setReactions((current) => [...current.slice(-5), { id, emoji, name: localParticipant.name || "You" }]);
    window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== id)), 3200);
    await broadcast({ kind: "reaction", emoji, id });
  }
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const message = messageText.trim();
    if (!message || isSending) return;
    try { await send(message); setMessageText(""); }
    catch { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Could not send that message. Please retry." } })); }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (fullScreenRef.current?.requestFullscreen) await fullScreenRef.current.requestFullscreen();
    } catch { window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Fullscreen is not available in this browser." } })); }
  }

  const getParticipantRole = (participant: typeof participants[number]) => {
    try { return JSON.parse(participant.metadata || "{}").role === "host" ? "host" : "participant"; } catch { return "participant"; }
  };
  const orderedParticipants = [...participants].sort((a, b) => {
    const aHost = getParticipantRole(a) === "host"; const bHost = getParticipantRole(b) === "host";
    if (aHost !== bHost) return aHost ? -1 : 1;
    if (a.isSpeaking !== b.isSpeaking) return a.isSpeaking ? -1 : 1;
    if (a.identity === localIdentity) return -1;
    if (b.identity === localIdentity) return 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });
  const tracksByIdentity = new Map(trackRefs.map((trackRef) => [trackRef.participant.identity, trackRef]));
  const visualParticipants = orderedParticipants.map((participant) => ({ participant, trackRef: tracksByIdentity.get(participant.identity) })).filter((item) => item.trackRef);
  const pages = Math.max(1, Math.ceil(visualParticipants.length / 8));
  const currentPage = Math.min(page, pages - 1);
  const visibleParticipants = visualParticipants.slice(currentPage * 8, currentPage * 8 + 8);

  return <div className={`conference-fullscreen-target ${fullScreen ? "is-fullscreen" : ""}`} ref={fullScreenRef}>
    <div className="conference-media-area">
      <RoomAudioRenderer />
      <div className="participant-grid-wrap">
        <div className={`participant-grid participant-grid-count-${visibleParticipants.length || 1}`}>
          {visibleParticipants.map(({ participant, trackRef }) => {
            const isHost = getParticipantRole(participant) === "host";
            const hand = Boolean(raisedHands[participant.identity]);
            return <div className={`participant-card ${participant.isSpeaking ? "participant-speaking" : ""} ${isHost ? "participant-host" : ""}`} key={participant.identity}>
              <ParticipantTile trackRef={trackRef!} />
              <div className="participant-name-overlay"><span className="participant-name-copy"><b>{participant.name || participant.identity}{participant.identity === localIdentity ? " (You)" : ""}</b><small>{isHost ? "HOST" : "PARTICIPANT"}</small></span><span className="participant-badges">{hand && <span className="raised-hand-badge" title="Raised hand"><Hand size={15}/></span>}{participant.isSpeaking && <span className="speaker-badge" title="Speaking"><AudioLines size={14}/></span>}</span></div>
            </div>;
          })}
        </div>
        {reactions.length > 0 && <div className="reaction-float-stack" aria-live="polite">{reactions.map((reaction) => <div className="reaction-float" key={reaction.id}><span>{reaction.emoji}</span><b>{reaction.name}</b></div>)}</div>}
        {pages > 1 && <div className="participant-pagination"><span>Screen {currentPage + 1} of {pages} · {visualParticipants.length} participants</span><div><button className="room-icon-button" onClick={() => setPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0} aria-label="Previous participant screen"><ChevronLeft size={18}/></button><button className="room-icon-button" onClick={() => setPage(Math.min(pages - 1, currentPage + 1))} disabled={currentPage >= pages - 1} aria-label="Next participant screen"><ChevronRight size={18}/></button></div></div>}
      </div>
      <div className="room-control-dock">
        <div className="room-control-group">
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isMicrophoneEnabled ? "control-disabled" : ""}`} onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)} title={isMicrophoneEnabled ? "Turn microphone off" : "Turn microphone on"}><Mic size={18}/><span>{isMicrophoneEnabled ? "Mic" : "Unmute"}</span></button><button className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "audioinput" ? null : "audioinput")} aria-label="Choose microphone" title="Choose microphone"><ChevronDown size={14}/></button>{deviceMenu === "audioinput" && <div className="room-device-menu">{inputDevices.filter((device) => device.kind === "audioinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("audioinput", device.deviceId)}>{device.label || `Microphone ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "audioinput").length === 0 && <span>No microphones found</span>}</div>}</div>
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isCameraEnabled ? "control-disabled" : ""}`} onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled)} title={isCameraEnabled ? "Turn camera off" : "Turn camera on"}><VideoIcon size={18}/><span>{isCameraEnabled ? "Camera" : "Camera off"}</span></button><button className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "videoinput" ? null : "videoinput")} aria-label="Choose camera" title="Choose camera"><ChevronDown size={14}/></button>{deviceMenu === "videoinput" && <div className="room-device-menu">{inputDevices.filter((device) => device.kind === "videoinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("videoinput", device.deviceId)}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "videoinput").length === 0 && <span>No cameras found</span>}</div>}</div>
          <button className={`room-control-button ${isScreenShareEnabled ? "control-selected" : ""}`} onClick={() => void localParticipant.setScreenShareEnabled(!isScreenShareEnabled)} title={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}><MonitorUp size={18}/><span>Share</span></button>
          <button className={`room-control-button ${handRaised ? "control-selected" : ""}`} onClick={() => void toggleHand()} title={handRaised ? "Lower your hand" : "Raise your hand"}><Hand size={18}/><span>{handRaised ? "Lower hand" : "Raise hand"}</span></button>
          <div className="reaction-control-wrap"><button className={`room-control-button ${reactionsOpen ? "control-selected" : ""}`} onClick={() => setReactionsOpen((open) => !open)} title="Send an emoji or sticker reaction"><Smile size={18}/><span>React</span></button>{reactionsOpen && <div className="reaction-picker" role="dialog" aria-label="Choose a reaction">{REACTION_SET.map((emoji) => <button key={emoji} onClick={() => void react(emoji)} aria-label={`Send ${emoji}`}>{emoji}</button>)}</div>}</div>
          <button className={`room-control-button message-control ${messagesOpen ? "control-selected" : ""}`} onClick={() => setMessagesOpen(true)} title="Open messages"><MessageCircle size={18}/><span>Messages</span>{chatMessages.length > 0 && <i>{chatMessages.length}</i>}</button>
        </div>
        <div className="room-control-side"><button className="room-icon-button fullscreen-control" onClick={() => void toggleFullscreen()} aria-label={fullScreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullScreen ? "Exit fullscreen" : "Fullscreen"}>{fullScreen ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>{role === "host" && <button className="room-icon-button room-end-button" onClick={onEndForEveryone} disabled={ending} title="End for everyone" aria-label="End for everyone"><X size={18}/></button>}<button className="room-leave-button" onClick={onLeave}><DoorOpen size={17}/><span>Leave</span></button></div>
      </div>
    </div>
    {messagesOpen && <div className="messages-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMessagesOpen(false); }}><section className="messages-modal" role="dialog" aria-modal="true" aria-label="Meeting messages"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div><b>Meeting messages</b><small>Chat with everyone in this room</small></div><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Close messages"><X size={18}/></button></header><div className="messages-modal-body">{chatMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No messages yet</b><span>Send a note to everyone in this gathering.</span></div> : chatMessages.map((message, index) => <article className={`chat-message ${message.from?.identity === localIdentity ? "chat-message-own" : ""}`} key={`${message.timestamp}-${index}`}><span className="chat-message-author">{message.from?.name || (message.from?.identity === localIdentity ? "You" : "Choir guest")}</span><p>{message.message}</p><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article>)}<div ref={chatEndRef}/></div><form className="messages-composer" onSubmit={sendMessage}><input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message…" maxLength={2000} aria-label="Message"/><button className="button button-primary" type="submit" disabled={!messageText.trim() || isSending} aria-label="Send message"><Send size={17}/></button></form></section></div>}
    {role === "host" && <span className="room-host-sr" aria-hidden="true">{meeting.ownerName} is hosting</span>}
  </div>;
}

function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (user: User, token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = mode === "login"
        ? await api.login({ email, password })
        : await api.register({ displayName, email, password });
      onAuthenticated(result.user, result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally { setBusy(false); }
  }

  return <Modal onClose={onClose} wide={false}>
    <div className="auth-modal-content"><span className="modal-brand-icon"><AudioLines size={23}/></span><p className="section-overline">WELCOME TO YOUR GATHERING SPACE</p><h2>{mode === "login" ? "Good to have you here." : "Let's get you connected."}</h2><p className="modal-subtitle">{mode === "login" ? "Sign in to schedule meetings and manage your invitations." : "Create an account to host and schedule choir meetings."}</p>
      <div className="auth-tabs"><button className={mode === "login" ? "auth-tab-active" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button><button className={mode === "register" ? "auth-tab-active" : ""} onClick={() => { setMode("register"); setError(""); }}>Create account</button></div>
      <form onSubmit={submit} className="form-stack">
        {mode === "register" && <label className="field-label">Full name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" minLength={2} maxLength={80} autoComplete="name" required/></label>}
        <label className="field-label">Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required/></label>
        <label className="field-label">Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Your password"} minLength={mode === "register" ? 8 : 1} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required/></label>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button type="submit" className="button button-primary button-full" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin"/> : mode === "login" ? <LogIn size={16}/> : <CheckCircle2 size={16}/>} {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}<ArrowRight size={16}/></button>
      </form><p className="auth-legal"><ShieldCheck size={13}/> Your account is used to manage the meetings you host.</p>
    </div>
  </Modal>;
}

const DURATION_OPTIONS = [{ value: "15", label: "15 minutes" }, { value: "30", label: "30 minutes" }, { value: "45", label: "45 minutes" }, { value: "60", label: "1 hour" }, { value: "90", label: "1.5 hours" }, { value: "120", label: "2 hours" }, { value: "180", label: "3 hours" }, { value: "240", label: "4 hours" }];
function DurationPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = DURATION_OPTIONS.find((item) => item.value === value) || DURATION_OPTIONS[3];
  return <div className="custom-picker-wrap"><button type="button" className="custom-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><Clock3 size={16}/><span>{selected.label}</span><ChevronRight size={15} className={open ? "picker-chevron-open" : "picker-chevron"}/></button>{open && <><button className="picker-dismiss" aria-label="Close duration options" onClick={() => setOpen(false)}/><div className="custom-picker-menu duration-picker-menu" role="listbox" aria-label="Meeting duration">{DURATION_OPTIONS.map((option) => <button type="button" key={option.value} role="option" aria-selected={value === option.value} className={value === option.value ? "custom-picker-option picker-option-active" : "custom-picker-option"} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}{value === option.value && <Check size={15}/>}</button>)}</div></>}</div>;
}
function CustomDateTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const datePart = value.slice(0, 10);
  const timePart = value.slice(11, 16) || "12:00";
  const selectedDate = new Date(`${datePart || localDateTimeValue(new Date()).slice(0, 10)}T12:00:00`);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [shownMonth, setShownMonth] = useState(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  useEffect(() => { setShownMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1)); }, [datePart]);
  const firstDay = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1).getDay();
  const dayCount = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 0).getDate();
  const today = localDateTimeValue(new Date()).slice(0, 10);
  const slots = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index * 15 / 60)).padStart(2, "0")}:${String(index * 15 % 60).padStart(2, "0")}`);
  const updateDate = (date: string) => onChange(`${date}T${timePart}`);
  return <div className="custom-datetime"><div className="custom-datetime-row"><div className="custom-picker-wrap date-picker-wrap"><button type="button" className="custom-picker-trigger" onClick={() => setCalendarOpen((current) => !current)} aria-expanded={calendarOpen}><CalendarDays size={16}/><span>{selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><ChevronRight size={15} className={calendarOpen ? "picker-chevron-open" : "picker-chevron"}/></button>{calendarOpen && <><button className="picker-dismiss" aria-label="Close calendar" onClick={() => setCalendarOpen(false)}/><div className="custom-calendar-popover"><div className="calendar-month-row"><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={16}/></button><b>{shownMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={16}/></button></div><div className="calendar-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="calendar-days">{Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`}/>)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const date = `${shownMonth.getFullYear()}-${String(shownMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; const isPast = date < today; return <button type="button" key={date} disabled={isPast} className={`${date === datePart ? "calendar-day-active" : ""} ${date === today ? "calendar-day-today" : ""}`} onClick={() => { updateDate(date); setCalendarOpen(false); }}>{day}</button>; })}</div></div></>}</div><label className="custom-time-wrap"><Clock3 size={16}/><select aria-label="Meeting time" value={timePart} onChange={(event) => onChange(`${datePart}T${event.target.value}`)}>{slots.map((time) => <option value={time} key={time}>{new Date(`2000-01-01T${time}:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</option>)}</select></label></div><input className="visually-hidden-date-value" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} min={localDateTimeValue(new Date(Date.now() - 60_000))} tabIndex={-1} aria-hidden="true"/></div>;
}

function ScheduleModal({ instant, onClose, onCreated }: { instant: boolean; onClose: () => void; onCreated: (meeting: Meeting, shareUrl: string) => void }) {
  const [title, setTitle] = useState(instant ? "Choir prayer gathering" : "ENIHAKOLE choir meeting");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(localDateTimeValue(new Date(Date.now() + (instant ? 0 : 15 * 60_000))));
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [visibility, setVisibility] = useState<"link" | "public">("link");
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState("");
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ meeting: Meeting; shareUrl: string } | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Kigali";

  useEffect(() => {
    if (!thumbnailFile) { setThumbnailPreview(""); return; }
    const objectUrl = URL.createObjectURL(thumbnailFile);
    setThumbnailPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [thumbnailFile]);

  function selectThumbnail(file?: File) {
    if (!file) { setThumbnailFile(null); return; }
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      setError("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("The thumbnail must be 8 MB or smaller.");
      return;
    }
    setError("");
    setThumbnailFile(file);
  }

  async function uploadThumbnail(): Promise<string> {
    if (!thumbnailFile) return "";
    setThumbnailUploading(true);
    try {
      // Resize/compress before sending to the API. This also avoids browser-to-Cloudinary
      // CORS/network failures and keeps the Cloudinary secret exclusively on the server.
      const bitmap = await createImageBitmap(thumbnailFile);
      const scale = Math.min(1, 1600 / bitmap.width, 900 / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser could not prepare this image. Please try another photo.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const dataUrl = canvas.toDataURL("image/webp", 0.84);
      const result = await api.uploadMeetingThumbnail(dataUrl);
      return result.secureUrl;
    } catch (cause) {
      if (cause instanceof Error && cause.message) throw cause;
      throw new Error("The cover image could not be uploaded. Check your connection and Cloudinary configuration, then try again.");
    } finally {
      setThumbnailUploading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!startsAt || !Number.isFinite(new Date(startsAt).getTime()) || new Date(startsAt).getTime() < Date.now() - 60_000) {
      setError("Choose a valid date and time that is not in the past.");
      return;
    }
    setBusy(true);
    try {
      const thumbnailUrl = await uploadThumbnail();
      const result = await api.createMeeting({
        title: title.trim(), description: description.trim(), startsAt: new Date(startsAt).toISOString(),
        durationMinutes: Number(durationMinutes), timezone, visibility, thumbnailUrl,
      });
      const shareUrl = `${window.location.origin}/share/${encodeURIComponent(result.meeting.slug)}`;
      const resultWithFrontendShare = { ...result, shareUrl };
      setCreated(resultWithFrontendShare);
      onCreated(result.meeting, shareUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this meeting.");
    } finally { setBusy(false); }
  }

  async function copyShare() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.shareUrl);
      window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Meeting invitation copied to clipboard." } }));
    } catch { setError(`Copy this link: ${created.shareUrl}`); }
  }

  async function shareMeeting() {
    if (!created) return;
    try {
      if (navigator.share) await navigator.share({ title: created.meeting.title, text: "You are invited to join MEET ENIHAKOLE.", url: created.shareUrl });
      else await copyShare();
    } catch { /* Native share sheet can be dismissed without action. */ }
  }

  return <Modal onClose={onClose}>
    {!created ? <div className="schedule-modal-content"><div className="modal-heading-row"><span className="modal-brand-icon"><CalendarClock size={22}/></span><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19}/></button></div><p className="section-overline">MAKE IT A MOMENT TO REMEMBER</p><h2>{instant ? "Start a gathering now." : "Plan your next gathering."}</h2><p className="modal-subtitle">{instant ? "Create a room, then share the invitation with your choir." : "Set a time and send everyone one simple link to join."}</p>
      <form onSubmit={submit} className="form-stack schedule-form">
        <label className="field-label">Meeting title<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder="e.g. Wednesday prayer meeting" required/></label>
        <label className="field-label">Description <span className="optional-label">OPTIONAL</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={1000} placeholder="Add a short note to help people know what this gathering is for."/></label>
        <div className="form-row"><label className="field-label">Date and time<CustomDateTimePicker value={startsAt} onChange={setStartsAt} /></label><label className="field-label">Duration<DurationPicker value={durationMinutes} onChange={setDurationMinutes} /></label></div>
        <div className="field-label">Invitation access<div className="visibility-options"><button type="button" className={`visibility-option ${visibility === "link" ? "visibility-selected" : ""}`} onClick={() => setVisibility("link")}><span className="visibility-option-icon"><Link2 size={17}/></span><span><b>Anyone with the link</b><small>Best for choir WhatsApp groups</small></span>{visibility === "link" && <CheckCircle2 size={17}/>}</button><button type="button" className={`visibility-option ${visibility === "public" ? "visibility-selected" : ""}`} onClick={() => setVisibility("public")}><span className="visibility-option-icon"><Users size={17}/></span><span><b>Public listing</b><small>Show it on the home page</small></span>{visibility === "public" && <CheckCircle2 size={17}/>}</button></div></div>
        <div className="field-label thumbnail-field"><span>Meeting thumbnail <span className="optional-label">OPTIONAL</span></span>
          <div className={`thumbnail-upload ${thumbnailPreview ? "thumbnail-upload-has-image" : ""}`} role="button" tabIndex={0} onClick={() => fileInputRef.current?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInputRef.current?.click(); } }} onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("thumbnail-drag-over"); }} onDragLeave={(event) => event.currentTarget.classList.remove("thumbnail-drag-over")} onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("thumbnail-drag-over"); selectThumbnail(event.dataTransfer.files?.[0]); }}>
            <input ref={fileInputRef} className="thumbnail-hidden-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { selectThumbnail(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
            {thumbnailPreview ? <img className="thumbnail-upload-preview" src={thumbnailPreview} alt="Selected meeting thumbnail preview"/> : <span className="thumbnail-upload-placeholder"><ImagePlus size={25}/><b>Add a cover image</b><small>Click to browse or drag a photo here. Shown in WhatsApp and other shared-link previews.</small></span>}
            {thumbnailFile && <button type="button" className="icon-button thumbnail-remove-button" onClick={(event) => { event.stopPropagation(); setThumbnailFile(null); setError(""); }} aria-label="Remove selected thumbnail" title="Remove image"><Trash2 size={15}/></button>}
          </div><small className="field-help">JPG, PNG, or WebP up to 8 MB. The image is optimized and uploaded securely to Cloudinary when you create the meeting. If no image is selected, the default MEET ENIHAKOLE cover is used.</small></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="schedule-modal-footer"><span className="modal-timezone"><Clock3 size={14}/>{timezone}</span><button className="button button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : instant ? <Video size={16}/> : <CalendarDays size={16}/>} {thumbnailUploading ? "Uploading image…" : busy ? "Creating…" : instant ? "Create meeting room" : "Schedule meeting"}<ArrowRight size={15}/></button></div>
      </form>
    </div> : <div className="schedule-success"><span className="success-icon"><CheckCircle2 size={27}/></span><p className="section-overline">YOUR INVITATION IS READY</p><h2>It's all set.</h2><p className="modal-subtitle">Share this meeting invitation with your choir. The link opens a page with the meeting thumbnail and details.</p><div className="success-meeting-preview"><img src={meetingImage(created.meeting)} alt="Meeting cover"/><div><b>{created.meeting.title}</b><small>{formatDate(created.meeting.startsAt, {}, created.meeting.timezone)} · {created.meeting.durationMinutes} min</small></div></div><div className="share-url-box"><Link2 size={15}/><span>{created.shareUrl}</span><button className="icon-button" onClick={copyShare} aria-label="Copy link"><Copy size={15}/></button></div><div className="success-actions"><button className="button button-primary button-full" onClick={() => void shareMeeting()}><Share2 size={16}/> Share invitation</button><Link className="button button-soft button-full" to={`/meeting/${created.meeting.slug}`} onClick={onClose}>Open meeting page <ArrowRight size={16}/></Link><button className="text-action centered-action" onClick={onClose}>Back to workspace</button></div></div>}
  </Modal>;
}

function Modal({ children, onClose, wide = true }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.classList.remove("modal-open"); };
  }, [onClose]);
  const dragStart = useRef<{ y: number; x: number } | null>(null);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal-panel ${wide ? "modal-panel-wide" : "modal-panel-narrow"}`} role="dialog" aria-modal="true" onTouchStart={(event) => { if (window.innerWidth > 720) return; const target = event.target as HTMLElement; if (target.closest(".modal-drag-handle, .modal-heading-row")) dragStart.current = { y: event.touches[0].clientY, x: event.touches[0].clientX }; else dragStart.current = null; }} onTouchEnd={(event) => { if (!dragStart.current) return; const deltaY = event.changedTouches[0].clientY - dragStart.current.y; const deltaX = event.changedTouches[0].clientX - dragStart.current.x; if (deltaY > 92 && deltaY > Math.abs(deltaX) * 1.3) onClose(); dragStart.current = null; }}><div className="modal-drag-handle" aria-hidden="true"><span/></div>{children}</section></div>;
}

function StandaloneLoading({ label }: { label: string }) {
  return <div className="standalone-state"><span className="modal-brand-icon"><AudioLines size={23}/></span><LoaderCircle size={22} className="spin"/><p>{label}</p></div>;
}

function StandaloneError({ message, action }: { message: string; action?: ReactNode }) {
  return <div className="standalone-state"><span className="modal-brand-icon"><AudioLines size={23}/></span><h1>Let's get you connected.</h1><p>{message}</p>{action || <Link to="/" className="button button-primary"><ArrowLeft size={16}/> Back to MEET ENIHAKOLE</Link>}</div>;
}

function ToastHost() {
  const [toast, setToast] = useState<{ message: string; action?: string; shareUrl?: string } | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; action?: string; shareUrl?: string }>).detail;
      setToast(detail);
      window.setTimeout(() => setToast((current) => current === detail ? null : current), 4200);
    };
    window.addEventListener("meet-toast", handler);
    return () => window.removeEventListener("meet-toast", handler);
  }, []);
  if (!toast) return null;
  return <div className="toast-message" role="status"><span className="toast-check"><Check size={15}/></span><span>{toast.message}</span>{toast.action && toast.shareUrl && <button onClick={() => void navigator.clipboard.writeText(toast.shareUrl!)}>{toast.action}</button>}<button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14}/></button></div>;
}
