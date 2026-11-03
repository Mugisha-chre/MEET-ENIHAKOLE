import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { LiveKitRoom, ParticipantTile, RoomAudioRenderer, isTrackReference, useChat, useIsMuted, useLocalParticipant, useParticipants, useRoomContext, useTracks } from "@livekit/components-react";
import { ConnectionState, ParticipantEvent, RoomEvent, Track, VideoPreset, type Participant, type RemoteParticipant } from "livekit-client";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, AudioLines, CalendarClock, CalendarDays, Check,
  CheckCircle2, CircleHelp, Clock3, Copy, DoorOpen, HeartHandshake, Home,
  Link2, LoaderCircle, LogIn, LogOut, Menu, Mic, Plus, Share2, ShieldCheck,
  Sparkles, Users, Video, VideoIcon, VideoOff, X, Sun, Moon, MessageCircle,
  Hand, Send, MonitorUp, MicOff, Maximize2, Minimize2, ChevronLeft, ChevronRight, Smile, ChevronDown, Download,
} from "lucide-react";
import { api, ApiError, clearAuthToken, getAuthToken, saveAuthToken } from "./api";
import { clearCachePrefix, patchCache, readCache, removeCache, writeCache } from "./cache";
import type { JoinSession, Meeting, User } from "./types";
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
  const [user, setUser] = useState<User | null>(() => getAuthToken() ? (readCache<User>("user")?.value ?? null) : null);
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [meetings, setMeetings] = useState<Meeting[]>(() => getAuthToken() ? (readCache<Meeting[]>("mine")?.value ?? []) : []);
  const [publicMeetings, setPublicMeetings] = useState<Meeting[]>(() => readCache<Meeting[]>("public")?.value ?? []);
  const [loadingMeetings, setLoadingMeetings] = useState(() => !readCache("public") && !(getAuthToken() && readCache("mine")));
  const lastMeetingsFetch = useRef(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [instantMode, setInstantMode] = useState(false);
  const [scheduleAfterAuth, setScheduleAfterAuth] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

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
    if (getAuthToken() && !readCache("mine")) setLoadingMeetings(true);
    const [mineResult, publicResult] = await Promise.allSettled([
      getAuthToken() ? api.myMeetings() : Promise.resolve({ meetings: [] as Meeting[] }),
      api.publicMeetings(),
    ]);
    if (mineResult.status === "fulfilled") { setMeetings(mineResult.value.meetings); if (getAuthToken()) writeCache("mine", mineResult.value.meetings); }
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
      if (getAuthToken()) {
        try {
          const result = await api.me();
          if (!cancelled) { setUser(result.user); writeCache("user", result.user); }
        } catch (cause) {
          // Only drop the session when the server says it is invalid, never because the network was slow or unreachable.
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
            clearAuthToken(); removeCache("user"); removeCache("mine");
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
  const openSchedule = useCallback((instant = false) => {
    setInstantMode(instant);
    if (!user) {
      setScheduleAfterAuth(true);
      setAuthOpen(true);
      return;
    }
    setScheduleOpen(true);
  }, [user]);
  const completeAuth = useCallback((nextUser: User, token: string) => {
    saveAuthToken(token);
    setUser(nextUser);
    writeCache("user", nextUser);
    setAuthOpen(false);
    if (scheduleAfterAuth) {
      setScheduleOpen(true);
      setScheduleAfterAuth(false);
    }
    void refreshMeetings(true);
  }, [scheduleAfterAuth, refreshMeetings]);
  const signOut = useCallback(() => {
    googleSignOut();
    clearAuthToken();
    removeCache("user"); removeCache("mine"); clearCachePrefix("meeting:");
    setUser(null);
    setMeetings([]);
    void refreshMeetings(true);
  }, [refreshMeetings]);

  const contextValue = useMemo<AppContextValue>(() => ({
    user, meetings, publicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, theme, toggleTheme,
  }), [user, meetings, publicMeetings, loadingMeetings, refreshMeetings, openAuth, completeAuth, openSchedule, signOut, theme, toggleTheme]);

  return (
    <AppContext.Provider value={contextValue}>
      <Routes>
        <Route path="/" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><Dashboard /></AppShell>} />
        <Route path="/meetings" element={<AppShell mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><MeetingsPage /></AppShell>} />
        <Route path="/share/:slug" element={<ShareRedirect />} />
        <Route path="/meeting/:slug" element={<MeetingPage />} />
        <Route path="/room/:slug" element={<MeetingRoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {authOpen && <AuthModal onClose={() => { setAuthOpen(false); setScheduleAfterAuth(false); }} onAuthenticated={completeAuth} />}
      {scheduleOpen && <ScheduleModal instant={instantMode} onClose={() => setScheduleOpen(false)} onCreated={(meeting) => {
        const merge = (list: Meeting[]) => [meeting, ...list.filter((item) => item.slug !== meeting.slug)];
        setMeetings((current) => { const next = merge(current); writeCache("mine", next); return next; });
        if (meeting.visibility === "public") setPublicMeetings((current) => { const next = merge(current); writeCache("public", next); return next; });
        writeCache(`meeting:${user?.id ?? "guest"}:${meeting.slug}`, meeting);
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
  const hasBottomNav = pathname === "/" || pathname === "/meetings";
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

function AppShell({ children, mobileNavOpen, setMobileNavOpen }: { children: ReactNode; mobileNavOpen: boolean; setMobileNavOpen: (v: boolean) => void }) {
  const { user, openAuth, openSchedule, signOut } = useAppContext();
  const location = useLocation();
  const active = location.pathname === "/meetings" ? "meetings" : "home";
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
          <Link to="/meetings" className={`side-link ${active === "meetings" ? "side-link-active" : ""}`}><CalendarDays size={18} /><span>My meetings</span></Link>
        </nav>
        <div className="sidebar-bottom">
          {user && <div className="sidebar-account"><ProfilePhoto className="sidebar-account-photo" src={user.picture} name={user.displayName} size={160}/><span><b title={user.displayName}>{user.displayName}</b><small title={user.email}>{user.email}</small></span><button type="button" className="sidebar-signout" onClick={() => { setMobileNavOpen(false); signOut(); }} title="Sign out" aria-label="Sign out"><LogOut size={16}/><span>Sign out</span></button></div>}
          <button className="side-link quiet-link" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Help centre will be added in a future release." } }))}><CircleHelp size={18} /><span>Help & support</span></button>
          <div className="sidebar-version">MEET ENIHAKOLE <span>EARLY ACCESS</span></div>
        </div>
      </aside>
      <button type="button" className={`mobile-scrim ${mobileNavOpen ? "mobile-scrim-open" : ""}`} aria-label="Close navigation" aria-hidden={!mobileNavOpen} tabIndex={mobileNavOpen ? 0 : -1} onClick={() => setMobileNavOpen(false)} />
      <div className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>ENIHAKOLE CHOIR</span><span className="breadcrumb-slash">/</span><strong>{active === "meetings" ? "My meetings" : "Workspace"}</strong></div>
          <div className="topbar-actions">
            <button className="topbar-help" onClick={() => window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Use Start instant meeting for an immediate call, or Schedule a meeting to share a future invitation." } }))}><CircleHelp size={16} /><span>Need help?</span></button>
            <ThemeToggle />
            {user ? (
              <div className="profile-menu">
                <ProfilePhoto className="profile-avatar" src={user.picture} name={user.displayName} />
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
        <Link to="/" className={active === "home" ? "mobile-nav-active" : ""} aria-current={active === "home" ? "page" : undefined}><Home size={20}/><span>Home</span></Link>
        <button type="button" className="mbn-fab" aria-label="Create meeting" onClick={() => openSchedule(false)}><Plus size={26} strokeWidth={2.4}/></button>
        <Link to="/meetings" className={active === "meetings" ? "mobile-nav-active" : ""} aria-current={active === "meetings" ? "page" : undefined}><CalendarDays size={20}/><span>My meetings</span></Link>
      </nav>
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
  const [micOn, setMicOn] = useState(true);
  const [loading, setLoading] = useState(() => !readCache(cacheKey) && ![...knownMeetings, ...knownPublic].some((item) => item.slug === slug));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [micPrompt, setMicPrompt] = useState<MicPromptState | null>(null);
  const micRetryRef = useRef(0);
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
      setError("");
      writeCache(cacheKey, result);
    }).catch((cause: unknown) => {
      if (!cancelled && !known) setError(cause instanceof Error ? cause.message : "Could not load this meeting.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, cacheKey]);

  useEffect(() => { if (user?.picture) void preloadPhoto(user.picture, 512); }, [user?.picture]);

  // Asks the browser for the microphone (the real permission prompt) and reports what happened.
  async function askBrowserForMic(): Promise<MicPromptState> {
    const attempt = ++micRetryRef.current;
    setMicPrompt({ phase: "waiting" });
    const result = await requestMicrophoneAccess();
    if (attempt !== micRetryRef.current) return { phase: "waiting" };
    setMicPrompt(result);
    return result;
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!meeting) return;
    if (!user) { setError("Sign in with Google to join this meeting."); return; }
    if (micOn) {
      // Called straight from the tap so every browser (Chrome, Firefox, Safari, Opera, Edge...) treats it as a user gesture and shows its own prompt.
      const result = await askBrowserForMic();
      if (result.phase !== "granted") return;
      setMicPrompt(null);
    }
    await enterRoom(micOn);
  }

  async function enterRoom(audio: boolean) {
    if (!meeting || !user) return;
    setJoining(true); setError("");
    try {
      const result = await api.join(slug);
      const session: JoinSession = { ...result, audio, video: cameraOn };
      sessionStorage.setItem(`meet-session:${slug}`, JSON.stringify(session));
      registerSession(session);
      // Fetch our own photo and everyone already in the room before entering, so the room opens fully drawn (capped so a slow image never blocks joining).
      await Promise.race([
        Promise.all([preloadPhoto(user.picture, 512), ...(result.participants ?? []).map((person) => preloadPhoto(person.picture, 512))]),
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
      navigate(`/room/${encodeURIComponent(slug)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join this meeting.");
    } finally { setJoining(false); }
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

  return (
    <div className="meeting-landing">
      <header className="landing-topbar"><Link className="brand-lockup" to="/"><span className="brand-mark"><AudioLines size={22}/></span><span className="brand-words"><strong>MEET</strong><b>ENIHAKOLE</b><small>GATHER IN FAITH</small></span></Link><div className="landing-topbar-actions"><ThemeToggle/><InstallPwaButton inline/></div></header>
      <main className="landing-layout">
        <section className="join-panel">
          <div className="join-cover join-cover-thumb"><img className="join-cover-img" src={meetingImage(meeting)} alt={meeting.title} decoding="async" fetchPriority="high" draggable={false}/><button type="button" className="thumb-share-button" onClick={share} aria-label="Share invitation"><Share2 size={15}/><span>Share invitation</span></button></div>
          <form className="join-form" onSubmit={join}>
            <div className="join-form-heading"><h2>{ended ? "This meeting has ended" : meeting.isOwner ? "Your meeting is ready" : meeting.status === "live" ? "Join the gathering" : "You're in the right place"}</h2><p>{ended ? "This invitation is no longer active." : meeting.isOwner ? "Start the room when you're ready. Your guests can join using the same link." : meeting.status === "live" ? "Enter your details and come on in." : "You can join as a guest when the host opens the room."}</p></div>
            {user && !ended && <div className="join-identity"><ProfilePhoto src={user.picture} name={user.displayName} className="join-identity-photo"/><span><b>{user.displayName}</b><small>{user.email}</small></span><button type="button" className="error-link" onClick={signOut}><LogOut size={12}/> Sign out</button></div>}
            {!user && !ended && <div className="join-google"><p>Continue with Google to join. We use your Google name and profile photo so everyone knows who you are.</p><GoogleContinueButton oneTap onCredential={(credential) => void googleCredential(credential)}/></div>}
            {!ended && <div className="join-preferences"><MediaToggle on={cameraOn} onChange={setCameraOn} onIcon={<Video size={16}/>} offIcon={<VideoOff size={16}/>} onLabel="Camera is on" offLabel="Camera is off" onHint="Join with video" offHint="Join without video"/><MediaToggle on={micOn} onChange={setMicOn} onIcon={<Mic size={16}/>} offIcon={<MicOff size={16}/>} onLabel="Microphone is on" offLabel="Microphone is off" onHint="Join with audio" offHint="Join muted"/></div>}
            {error && <div className="inline-error" role="alert">{error}{error.includes("Sign in") && <button type="button" className="error-link" onClick={openAuth}>Sign in</button>}</div>}
            {ended ? <Link to="/" className="button button-soft button-full"><ArrowLeft size={16}/> Back to home</Link> : user && <button className="button button-primary button-full join-submit" type="submit" disabled={joining}>{joining ? <LoaderCircle size={17} className="spin"/> : meeting.isOwner ? <Video size={17}/> : <DoorOpen size={17}/>} {joining ? "Preparing your room…" : meeting.isOwner ? "Start meeting" : meeting.status === "live" ? "Join meeting" : "Check room availability"}<ArrowRight size={16}/></button>}
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
      {micPrompt && <MicPermissionModal
        state={micPrompt}
        onRetry={() => { void askBrowserForMic().then((result) => { if (result.phase === "granted") { setMicPrompt(null); void enterRoom(true); } }); }}
        onGranted={() => { setMicPrompt(null); void enterRoom(true); }}
        onSkip={() => { micRetryRef.current++; setMicPrompt(null); setMicOn(false); void enterRoom(false); }}
        onClose={() => { micRetryRef.current++; setMicPrompt(null); }}
      />}
    </div>
  );
}

type MicPromptState = { phase: "waiting" } | { phase: "granted" } | { phase: "blocked" | "unavailable" | "busy" | "unsupported"; message: string };

// Opens the microphone once so the browser shows its permission prompt, then releases it immediately (LiveKit opens it again inside the room).
async function requestMicrophoneAccess(): Promise<MicPromptState> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    return { phase: "unsupported", message: window.isSecureContext ? "This browser cannot use a microphone here. Try Chrome, Edge, Firefox or Safari." : "The microphone needs a secure (https) connection. Open the link with https." };
  }
  try {
    const stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    stream.getTracks().forEach((track) => track.stop());
    return { phase: "granted" };
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : "";
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return { phase: "unavailable", message: "No microphone was found. Plug one in or check your device, then try again." };
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return { phase: "busy", message: "Your microphone is being used by another app. Close it and try again." };
    return { phase: "blocked", message: "Microphone access is blocked for this site. Tap the lock or settings icon next to the address bar, set Microphone to Allow, then press Try again." };
  }
}

function MicPermissionModal({ state, onRetry, onGranted, onSkip, onClose }: { state: MicPromptState; onRetry: () => void; onGranted: () => void; onSkip: () => void; onClose: () => void }) {
  const waiting = state.phase === "waiting";
  const failed = state.phase !== "waiting" && state.phase !== "granted";
  const retryRef = useRef(onRetry);
  const grantedRef = useRef(onGranted);
  retryRef.current = onRetry;
  grantedRef.current = onGranted;

  // While access is blocked, keep watching: the moment the person allows it (in the address bar or settings) we continue on our own, and we keep asking the browser again in the background.
  useEffect(() => {
    if (!failed) return;
    let stopped = false;
    let status: PermissionStatus | null = null;
    const onChange = () => { if (!stopped && status?.state === "granted") grantedRef.current(); };
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then((result) => { if (stopped) { return; } status = result; if (result.state === "granted") grantedRef.current(); else result.addEventListener("change", onChange); }).catch(() => { /* Permissions API is not available in every browser. */ });
    const timer = window.setInterval(() => {
      if (stopped || document.hidden) return;
      void requestMicrophoneAccess().then((result) => { if (!stopped && result.phase === "granted") grantedRef.current(); });
    }, 3500);
    return () => { stopped = true; window.clearInterval(timer); status?.removeEventListener("change", onChange); };
  }, [failed]);

  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.classList.remove("modal-open"); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div className="modal-backdrop mic-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-panel modal-panel-narrow mic-modal" role="dialog" aria-modal="true" aria-labelledby="mic-modal-title">
        <button type="button" className="icon-button modal-close mic-modal-close" onClick={onClose} aria-label="Close"><X size={17}/></button>
        <div className="mic-modal-body">
          <div className={`mic-orb ${failed ? "mic-orb-off" : ""}`} aria-hidden="true">
            <span className="mic-orb-glow"/><span className="mic-orb-ring"/><span className="mic-orb-core">{failed ? <MicOff size={34} strokeWidth={1.9}/> : <Mic size={34} strokeWidth={1.9}/>}</span>
          </div>
          <p className="section-overline">ONE QUICK STEP</p>
          <h2 id="mic-modal-title">{failed ? "We can't hear you yet" : "Allow your microphone"}</h2>
          <p className="mic-modal-text">{failed ? (state as { message: string }).message : "When your browser asks, choose Allow so your choir can hear you. We only use it while you are in the room."}</p>
          {waiting && <p className="mic-modal-status" role="status"><LoaderCircle size={14} className="spin"/> Waiting for your browser…</p>}
          {failed && <p className="mic-modal-status mic-modal-status-soft" role="status"><LoaderCircle size={14} className="spin"/> We'll keep checking and continue as soon as it's allowed.</p>}
        </div>
        <div className="mic-modal-actions modal-footer-fixed">
          <button type="button" className="button button-primary button-full" onClick={onRetry} disabled={waiting}>{waiting ? <LoaderCircle size={16} className="spin"/> : <Mic size={16}/>} {failed ? "Try again" : "Allow microphone"}</button>
          <button type="button" className="button button-soft button-full" onClick={onSkip}>Join without microphone</button>
        </div>
      </section>
    </div>
  );
}

function MeetingRoomPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<JoinSession | null>(() => readStoredSession(slug));
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    try {
      const stored = readStoredSession(slug);
      if (stored) setSession(stored);
    } catch { setSession(null); }
  }, [slug]);

  async function endForEveryone() {
    if (!session || session.role !== "host") return;
    const confirmed = window.confirm("End this meeting for everyone in the room?");
    if (!confirmed) return;
    setEnding(true); setEndError("");
    try {
      await api.endMeeting(slug);
      window.dispatchEvent(new CustomEvent("meet-meeting-changed", { detail: { slug, patch: { status: "ended", endedAt: new Date().toISOString() } } }));
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
            <RoomReadyOverlay expected={(session.participants ?? []).map((person) => person.identity)} title={session.meeting.title}/>
          </LiveKitRoom>
        </div>
        <div className="conference-bottom-note"><span><ShieldCheck size={15}/> {session.meeting.visibility === "public" ? "This gathering is publicly listed." : "This meeting uses an unlisted invitation link."}</span><span>For the clearest call, use headphones and a stable connection.</span></div>
      </main>
    </div>
  );
}

/** Covers the room until everyone who was already here is shown with their photo and voice, so you arrive in a fully drawn room. */
function RoomReadyOverlay({ expected, title }: { expected: string[]; title: string }) {
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
    <div className="room-ready-card">
      <span className="room-ready-mark"><AudioLines size={26}/></span>
      <b>Getting your room ready…</b>
      <small>{title}</small>
      <LoaderCircle size={20} className="spin"/>
    </div>
  </div>;
}

type RoomSignal = { kind: "hand"; raised: boolean } | { kind: "reaction"; emoji: string; id: string };
type FloatingReaction = { id: string; emoji: string; name: string };
// Anything a person can press: a tap on these must keep doing its own job and never toggle fullscreen.
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, label, summary, [role='button'], [role='dialog'], [data-popover], .room-device-menu, .reaction-picker, .messages-modal-backdrop, .room-alert, .room-message-toast, .room-presence-stack";
const PARTICIPANTS_PER_SCREEN = 8;
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
  const videoOn = isTrackReference(trackRef) && Boolean(trackRef.publication?.track) && !muted;
  // Camera on: the video is the picture, so the waveform runs around the card edges instead of a profile circle.
  if (videoOn) return participant.isSpeaking ? <SpeakingWave participant={participant}/> : null;
  return <div className="participant-avatar" aria-hidden="true"><div className="participant-avatar-stack"><VoiceRing participant={participant} speaking={participant.isSpeaking}/><ProfilePhoto src={participantPicture(participant.metadata, participant.identity)} name={participantName(participant)} className="participant-avatar-photo" size={512}/></div></div>;
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
      presence += ((isSpeaking ? 1 : 0) - presence) * (isSpeaking ? 0.22 : 0.12);
      // (Re)connect to the live microphone track when it appears or changes.
      const currentTrack = participant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (isSpeaking && now - lastMicCheck > 400) {
        lastMicCheck = now;
        if (mic && (!currentTrack || mic.trackId !== currentTrack.id)) releaseMic();
        if (!mic) { mic = createMicAnalyser(participant); if (mic) data = new Uint8Array(mic.analyser.frequencyBinCount); }
      }
      const level = isSpeaking ? Math.min(1, participant.audioLevel * 2.2) : 0;
      let spectrumEnergy = 0;
      if (mic && isSpeaking) { mic.analyser.getByteFrequencyData(data); for (let i = 2; i < 30; i++) spectrumEnergy += data[i]; spectrumEnergy /= 28 * 255; }
      const half = RING_BARS / 2;
      for (let i = 0; i < RING_BARS; i++) {
        const k = i <= half ? i : RING_BARS - i; // mirrored: lows at the top, highs at the bottom
        const position = k / half;
        let target = 0;
        if (isSpeaking) {
          if (mic && spectrumEnergy > 0.004) {
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
        const rate = reduceMotion ? 1 : smooth > bars[i] ? 0.55 : 0.14;
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

/** Animated voice waveform around the sides and corners of a speaking participant's card; follows the real audio level. */
function SpeakingWave({ participant }: { participant: Participant }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0; let level = 0.4;
    const tick = () => {
      const target = Math.min(1, 0.35 + participant.audioLevel * 1.8);
      level += (target - level) * 0.16;
      ref.current?.style.setProperty("--lvl", level.toFixed(3));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [participant]);
  const bars = (count: number) => Array.from({ length: count }, (_, index) => <i key={index} style={{ "--i": index } as CSSProperties}/>);
  return <div className="voice-wave" ref={ref} aria-hidden="true">
    <div className="voice-wave-edge voice-wave-top">{bars(40)}</div>
    <div className="voice-wave-edge voice-wave-bottom">{bars(40)}</div>
    <div className="voice-wave-edge voice-wave-left">{bars(22)}</div>
    <div className="voice-wave-edge voice-wave-right">{bars(22)}</div>
  </div>;
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

// A tiny silent WAV (one second, mono). Looping it keeps the page counted as "playing audio", so the browser keeps the call running while you use other apps.
let silentWavUrl = "";
function getSilentWavUrl(): string {
  if (silentWavUrl) return silentWavUrl;
  const sampleRate = 8000; const samples = sampleRate; const buffer = new ArrayBuffer(44 + samples * 2); const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
  silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  return silentWavUrl;
}

/** Keeps a call alive like a normal phone call: you can switch to other apps or tabs and still hear (and be heard by) everyone. */
function useBackgroundCall(room: ReturnType<typeof useRoomContext>, title: string, onLeave: () => void) {
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const nav = navigator as Navigator & { audioSession?: { type: string }; wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void>; addEventListener: (name: string, cb: () => void) => void }> }; locks?: { request: (name: string, cb: () => Promise<void>) => Promise<unknown> } };

    // 1) Tell iOS/Safari this is a two-way call so audio is not ducked or stopped when the screen locks or another app opens.
    try { if (nav.audioSession) nav.audioSession.type = "play-and-record"; } catch { /* Not supported here. */ }

    // 2) Silent audio loop: keeps the page "audible" so timers and the connection are not throttled or frozen in the background.
    let silent: HTMLAudioElement | null = null;
    try {
      silent = new Audio(getSilentWavUrl());
      silent.loop = true; silent.setAttribute("playsinline", ""); silent.preload = "auto";
      const start = () => { void silent?.play().catch(() => { /* Waits for the next tap. */ }); };
      start();
      const retry = () => { if (silent?.paused) start(); };
      document.addEventListener("pointerdown", retry, true);
      document.addEventListener("keydown", retry, true);
      cleanups.push(() => { document.removeEventListener("pointerdown", retry, true); document.removeEventListener("keydown", retry, true); silent?.pause(); silent = null; });
    } catch { /* Background audio helper is optional. */ }

    // 3) Media session: the phone shows MEET ENIHAKOLE as an ongoing call (lock screen / notification) with hang-up and mute controls.
    const session = navigator.mediaSession;
    if (session) {
      const setHandler = (action: string, handler: (() => void) | null) => { try { (session.setActionHandler as (name: string, cb: (() => void) | null) => void).call(session, action, handler); } catch { /* Action not supported in this browser. */ } };
      try {
        session.metadata = new MediaMetadata({ title, artist: "MEET ENIHAKOLE", album: "Live gathering", artwork: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }, { src: "/icon-192.png", sizes: "192x192", type: "image/png" }] });
        session.playbackState = "playing";
      } catch { /* Metadata is cosmetic. */ }
      setHandler("play", () => { void silent?.play().catch(() => undefined); });
      setHandler("pause", () => { void silent?.play().catch(() => undefined); });
      setHandler("hangup", () => leaveRef.current());
      setHandler("togglemicrophone", () => { void room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled); });
      cleanups.push(() => { ["play", "pause", "hangup", "togglemicrophone"].forEach((action) => setHandler(action, null)); try { session.metadata = null; session.playbackState = "none"; } catch { /* Ignore. */ } });
    }

    // 4) A held Web Lock stops Chromium from freezing the page while it is in the background.
    let releaseLock: (() => void) | null = null;
    try { void nav.locks?.request("meet-enihakole-live-call", () => new Promise<void>((resolve) => { releaseLock = resolve; })).catch(() => undefined); } catch { /* Not supported. */ }
    cleanups.push(() => { releaseLock?.(); });

    // 5) Keep the screen awake while the call is on screen, and re-acquire it when you come back.
    let sentinel: { release: () => Promise<void> } | null = null;
    const takeWakeLock = async () => {
      if (document.visibilityState !== "visible" || sentinel || !nav.wakeLock) return;
      try { const lock = await nav.wakeLock.request("screen"); sentinel = lock; lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; }); } catch { /* Battery saver or unsupported. */ }
    };
    void takeWakeLock();
    cleanups.push(() => { void sentinel?.release().catch(() => undefined); sentinel = null; });

    // 6) Coming back from another app: make sure the sound and the connection are running again straight away.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void takeWakeLock();
      void room.startAudio().catch(() => undefined);
      if (silent?.paused) void silent.play().catch(() => undefined);
      try { if (session) session.playbackState = "playing"; } catch { /* Ignore. */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("focus", onVisible);
    cleanups.push(() => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("pageshow", onVisible); window.removeEventListener("focus", onVisible); });

    return () => { cleanups.forEach((cleanup) => cleanup()); };
  }, [room, title]);
}

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
  const [pseudoFull, setPseudoFull] = useState(false);
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
  const localIdentity = localParticipant.identity;
  useBackgroundCall(room, meeting.title, onLeave);
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
    const onFullscreen = () => { if (document.fullscreenElement || !pseudoFullRef.current) setFullScreen(document.fullscreenElement === fullScreenRef.current); };
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

  // New message from someone else: play a tone and show a 4 second pop-up with the message at the bottom of the call.
  useEffect(() => {
    messagesOpenRef.current = messagesOpen;
    overlayOpenRef.current = messagesOpen || reactionsOpen || deviceMenu !== null;
  }, [messagesOpen, reactionsOpen, deviceMenu]);
  useEffect(() => { pseudoFullRef.current = pseudoFull; }, [pseudoFull]);
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
    messageToastTimer.current = window.setTimeout(() => setMessageToast(null), 4000);
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
    const unlock = () => { try { const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!Ctx) return; toneContext ??= new Ctx(); if (toneContext.state === "suspended") void toneContext.resume(); } catch { /* ignore */ } };
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    return () => document.removeEventListener("pointerdown", unlock, true);
  }, []);

  // Auto-enter fullscreen 15 seconds after arriving on the live page. Browsers only allow fullscreen from a user gesture,
  // so if the direct attempt is blocked, the very next tap/click/key press enters fullscreen immediately.
  useEffect(() => {
    const target = fullScreenRef.current;
    if (!target || typeof target.requestFullscreen !== "function") return;
    let cleanup = () => {};
    const timer = window.setTimeout(() => {
      if (autoFullscreenDone.current || document.fullscreenElement) return;
      const enter = () => target.requestFullscreen({ navigationUI: "hide" });
      enter().then(() => { autoFullscreenDone.current = true; }).catch(() => {
        const events = ["pointerup", "click", "keydown", "touchend"] as const;
        const retry = (event: Event) => {
          if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
          cleanup();
          if (autoFullscreenDone.current || document.fullscreenElement) return;
          autoFullscreenDone.current = true;
          lastFullscreenAction.current = Date.now();
          enter().catch(() => { /* Fullscreen unavailable; the manual button still works. */ });
        };
        cleanup = () => events.forEach((name) => document.removeEventListener(name, retry, true));
        events.forEach((name) => document.addEventListener(name, retry, true));
      });
    }, 15000);
    return () => { window.clearTimeout(timer); cleanup(); };
  }, []);

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
  async function toggleFullscreen(silent = false, enterOnly = false) {
    // Background taps may only ENTER fullscreen; leaving is reserved for the fullscreen button (or Esc).
    if (enterOnly && (document.fullscreenElement || pseudoFull)) return;
    autoFullscreenDone.current = true;
    lastFullscreenAction.current = Date.now();
    const target = fullScreenRef.current;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (pseudoFull) { setPseudoFull(false); setFullScreen(false); }
      else if (target?.requestFullscreen) await target.requestFullscreen({ navigationUI: "hide" });
      else { setPseudoFull(true); setFullScreen(true); } // iPhone Safari has no element fullscreen: fill the screen with CSS instead.
    } catch {
      if (!silent) window.dispatchEvent(new CustomEvent("meet-toast", { detail: { message: "Fullscreen is not available in this browser." } }));
    }
  }
  // Tapping or clicking anywhere on the room page (outside fullscreen) enters fullscreen; it never exits it. Buttons, links, menus and the chat keep working normally.
  const toggleFullscreenRef = useRef(toggleFullscreen);
  toggleFullscreenRef.current = toggleFullscreen;
  useEffect(() => {
    const onDown = () => { suppressNextClick.current = overlayOpenRef.current; };
    const onClick = (event: MouseEvent) => {
      const wasOverlay = suppressNextClick.current; suppressNextClick.current = false;
      if (wasOverlay || event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.isConnected || target.closest(INTERACTIVE_SELECTOR)) return;
      if (window.getSelection()?.toString()) return;
      if (document.fullscreenElement || pseudoFullRef.current) return; // already fullscreen: clicking the page never exits it
      if (Date.now() - lastFullscreenAction.current < 350) return;
      void toggleFullscreenRef.current(true, true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("click", onClick); };
  }, []);

  const getParticipantRole = (participant: typeof participants[number]) => {
    try { return JSON.parse(participant.metadata || "{}").role === "host" ? "host" : "participant"; } catch { return "participant"; }
  };
  const orderedParticipants = [...participants].sort((a, b) => {
    const aTop = a.identity === topSpeaker; const bTop = b.identity === topSpeaker;
    if (aTop !== bTop) return aTop ? -1 : 1;
    const aHost = getParticipantRole(a) === "host"; const bHost = getParticipantRole(b) === "host";
    if (aHost !== bHost) return aHost ? -1 : 1;
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });
  // Your own card always lives on the first screen (right after the current speaker and the host), so you never have to page to find yourself.
  const localSlot = orderedParticipants.findIndex((participant) => participant.isLocal);
  if (localSlot >= PARTICIPANTS_PER_SCREEN) {
    const [self] = orderedParticipants.splice(localSlot, 1);
    orderedParticipants.splice(PARTICIPANTS_PER_SCREEN - 1, 0, self);
  }
  const tracksByIdentity = new Map(trackRefs.map((trackRef) => [trackRef.participant.identity, trackRef]));
  const visualParticipants = orderedParticipants.map((participant) => ({ participant, trackRef: tracksByIdentity.get(participant.identity) })).filter((item) => item.trackRef);
  const pages = Math.max(1, Math.ceil(visualParticipants.length / PARTICIPANTS_PER_SCREEN));
  const currentPage = Math.min(page, pages - 1);
  const visibleParticipants = visualParticipants.slice(currentPage * PARTICIPANTS_PER_SCREEN, currentPage * PARTICIPANTS_PER_SCREEN + PARTICIPANTS_PER_SCREEN);

  return <div className={`conference-fullscreen-target ${fullScreen ? "is-fullscreen" : ""} ${pseudoFull ? "is-pseudo-fullscreen" : ""}`} ref={fullScreenRef}>
    <div className="conference-media-area">
      <RoomAudioRenderer />
      <div className="room-top-stack">
        <div className="active-count-pill" role="status" aria-live="polite" title="People currently in this meeting"><Users size={14}/><b>{participants.length}</b><span>{participants.length === 1 ? "person" : "people"} in the meeting</span></div>
        {participants.filter((participant) => raisedHands[participant.identity]).map((participant) => <div className="raised-hand-chip" key={participant.identity} title={`${participantName(participant) || "Participant"} raised a hand`}><Hand size={13}/><span>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " (You)" : ""}</span></div>)}
      </div>
      <div className="participant-grid-wrap">
        <div className={`participant-grid participant-grid-count-${visibleParticipants.length || 1}`}>
          {visibleParticipants.map(({ participant, trackRef }) => {
            const isHost = getParticipantRole(participant) === "host";
            const hand = Boolean(raisedHands[participant.identity]);
            return <div className={`participant-card ${participant.isSpeaking ? "participant-speaking" : ""} ${isHost ? "participant-host" : ""} ${participant.identity === localIdentity ? "participant-local" : ""}`} key={participant.identity}>
              <ParticipantTile trackRef={trackRef!} />
              <ParticipantAvatar trackRef={trackRef!} participant={participant} />
              <span className="participant-role-label">{isHost ? "HOST" : "PARTICIPANT"}</span>
              <div className="participant-name-overlay"><span className="participant-name-copy" title={participantName(participant) || "Participant"}><b>{participantName(participant) || "Participant"}{participant.identity === localIdentity ? " · You" : ""}</b></span><span className="participant-badges"><MicOffBadge participant={participant}/>{hand && <span className="raised-hand-badge" title="Raised hand"><Hand size={15}/></span>}{participant.isSpeaking && <span className="speaker-mic" title="Speaking" aria-label="Speaking"><Mic size={14}/></span>}</span></div>
            </div>;
          })}
        </div>
        {reactions.length > 0 && <div className="reaction-float-stack" aria-live="polite">{reactions.map((reaction) => <div className="reaction-float" key={reaction.id}><span>{reaction.emoji}</span><b>{reaction.name}</b></div>)}</div>}
        {presenceToasts.length > 0 && <div className={`room-presence-stack ${messageToast ? "room-presence-stack-raised" : ""}`} aria-live="polite">{presenceToasts.map((toast) => <div className={`room-presence-toast room-presence-${toast.kind}`} key={toast.id} role="status"><span className="room-presence-icon">{toast.kind === "joined" ? <LogIn size={15}/> : <LogOut size={15}/>}</span><span className="room-presence-text"><b>{toast.name}</b> {toast.kind === "joined" ? "joined the meeting" : "left the meeting"}</span></div>)}</div>}
        {messageToast && <div className="room-message-toast" key={messageToast.id} role="status" aria-live="polite"><span className="room-message-toast-icon"><MessageCircle size={16}/></span><span className="room-message-toast-body"><b>{messageToast.name}</b><span>{messageToast.text}</span></span></div>}
        {pages > 1 && <div className="participant-pagination"><span>Screen {currentPage + 1} of {pages} · {visualParticipants.length} participants</span><div><button className="room-icon-button" onClick={() => setPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0} aria-label="Previous participant screen"><ChevronLeft size={18}/></button><button className="room-icon-button" onClick={() => setPage(Math.min(pages - 1, currentPage + 1))} disabled={currentPage >= pages - 1} aria-label="Next participant screen"><ChevronRight size={18}/></button></div></div>}
      </div>
      <div className="room-control-dock">
        <div className="room-control-group room-control-row-a">
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isMicrophoneEnabled ? "control-disabled" : ""}`} onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)} title={isMicrophoneEnabled ? "Turn microphone off" : "Turn microphone on"}><Mic size={18}/><span>{isMicrophoneEnabled ? "Mic" : "Unmute"}</span></button><button data-popover="audioinput" className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "audioinput" ? null : "audioinput")} aria-label="Choose microphone" title="Choose microphone"><ChevronDown size={14}/></button>{deviceMenu === "audioinput" && <div data-popover="audioinput" className="room-device-menu">{inputDevices.filter((device) => device.kind === "audioinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("audioinput", device.deviceId)}>{device.label || `Microphone ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "audioinput").length === 0 && <span>No microphones found</span>}</div>}</div>
          <div className="room-split-control"><button className={`room-control-button room-split-main ${!isCameraEnabled ? "control-disabled" : ""}`} onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled)} title={isCameraEnabled ? "Turn camera off" : "Turn camera on"}><VideoIcon size={18}/><span>{isCameraEnabled ? "Camera" : "Camera off"}</span></button><button data-popover="videoinput" className="room-control-dropdown" onClick={() => setDeviceMenu(deviceMenu === "videoinput" ? null : "videoinput")} aria-label="Choose camera" title="Choose camera"><ChevronDown size={14}/></button>{deviceMenu === "videoinput" && <div data-popover="videoinput" className="room-device-menu">{inputDevices.filter((device) => device.kind === "videoinput").map((device) => <button key={device.deviceId} onClick={() => void chooseDevice("videoinput", device.deviceId)}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</button>)}{inputDevices.filter((device) => device.kind === "videoinput").length === 0 && <span>No cameras found</span>}</div>}</div>
          <button className={`room-control-button ${isScreenShareEnabled ? "control-selected" : ""}`} onClick={() => void localParticipant.setScreenShareEnabled(!isScreenShareEnabled)} title={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}><MonitorUp size={18}/><span>Share</span></button>
          <button className={`room-control-button ${handRaised ? "control-selected" : ""}`} onClick={() => void toggleHand()} title={handRaised ? "Lower your hand" : "Raise your hand"}><Hand size={18}/><span>{handRaised ? "Lower hand" : "Raise hand"}</span></button>
        </div>
        <div className="room-control-group room-control-row-b">
          <button className={`room-control-button message-control ${messagesOpen ? "control-selected" : ""}`} onClick={() => setMessagesOpen(true)} title="Open messages"><MessageCircle size={18}/><span>Messages</span>{chatMessages.length > 0 && <i>{chatMessages.length}</i>}</button>
          <div className="reaction-control-wrap"><button data-popover="reactions" className={`room-control-button ${reactionsOpen ? "control-selected" : ""}`} onClick={() => setReactionsOpen((open) => !open)} title="Send an emoji or sticker reaction"><Smile size={18}/><span>React</span></button>{reactionsOpen && <div data-popover="reactions" className="reaction-picker" role="dialog" aria-label="Choose a reaction">{REACTION_SET.map((emoji) => <button key={emoji} onClick={() => void react(emoji)} aria-label={`Send ${emoji}`}>{emoji}</button>)}</div>}</div>
        <div className="room-control-side"><button className="room-icon-button fullscreen-control" onClick={() => void toggleFullscreen()} aria-label={fullScreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullScreen ? "Exit fullscreen" : "Fullscreen"}>{fullScreen ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>{role === "host" && <button className="room-icon-button room-end-button" onClick={onEndForEveryone} disabled={ending} title="End for everyone" aria-label="End for everyone"><X size={18}/></button>}<button className="room-leave-button" onClick={onLeave}><DoorOpen size={17}/><span>Leave</span></button></div></div>
      </div>
    </div>
    {messagesOpen && <div className="messages-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMessagesOpen(false); }}><section className="messages-modal" role="dialog" aria-modal="true" aria-label="Meeting messages"><header className="messages-modal-header"><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Back to call"><ArrowLeft size={18}/></button><div><b>Meeting messages</b><small>Chat with everyone in this room</small></div><button className="room-icon-button" onClick={() => setMessagesOpen(false)} aria-label="Close messages"><X size={18}/></button></header><div className="messages-modal-body">{chatMessages.length === 0 ? <div className="messages-empty"><MessageCircle size={25}/><b>No messages yet</b><span>Send a note to everyone in this gathering.</span></div> : chatMessages.map((message, index) => <article className={`chat-message ${message.from?.identity === localIdentity ? "chat-message-own" : ""}`} key={`${message.timestamp}-${index}`}><span className="chat-message-author">{message.from?.name || (message.from?.identity === localIdentity ? "You" : "Choir guest")}</span><p>{message.message}</p><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></article>)}<div ref={chatEndRef}/></div><form className="messages-composer" onSubmit={sendMessage}><input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message…" maxLength={2000} aria-label="Message"/><button className="button button-primary" type="submit" disabled={!messageText.trim() || isSending} aria-label="Send message"><Send size={17}/></button></form></section></div>}
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
function DurationPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = DURATION_OPTIONS.find((item) => item.value === value) || DURATION_OPTIONS[3];
  return <div className="custom-picker-wrap"><button type="button" className="custom-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><Clock3 size={16}/><span>{selected.label}</span><ChevronRight size={15} className={open ? "picker-chevron-open" : "picker-chevron"}/></button>{open && <><button className="picker-dismiss" aria-label="Close duration options" onClick={() => setOpen(false)}/><div className="custom-picker-menu duration-picker-menu" role="listbox" aria-label="Meeting duration">{DURATION_OPTIONS.map((option) => <button type="button" key={option.value} role="option" aria-selected={value === option.value} className={value === option.value ? "custom-picker-option picker-option-active" : "custom-picker-option"} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}{value === option.value && <Check size={15}/>}</button>)}</div></>}</div>;
}
function TimePicker({ value, datePart, onChange }: { value: string; datePart: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
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
  return <div className="custom-picker-wrap time-picker-wrap"><button type="button" className="custom-picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label="Meeting time" onClick={() => setOpen((current) => !current)}><Clock3 size={16}/><span>{label}</span><ChevronRight size={15} className={open ? "picker-chevron-open" : "picker-chevron"}/></button>{open && <><button type="button" className="picker-dismiss" aria-label="Close time picker" onClick={() => setOpen(false)}/><div className="custom-calendar-popover time-popover" role="dialog" aria-label="Choose time"><div className="time-columns"><div className="time-column" ref={hourRef} role="listbox" aria-label="Hour">{Array.from({ length: 12 }, (_, index) => index + 1).map((h) => <button type="button" key={h} role="option" aria-selected={h === hour12} disabled={isPast(to24(h, period), 59)} className={h === hour12 ? "time-option time-option-active" : "time-option"} onClick={() => emit(to24(h, period), minute)}>{pad(h)}</button>)}</div><div className="time-column" ref={minuteRef} role="listbox" aria-label="Minute">{Array.from({ length: 60 }, (_, index) => index).map((m) => <button type="button" key={m} role="option" aria-selected={m === minute} disabled={isPast(h24, m)} className={m === minute ? "time-option time-option-active" : "time-option"} onClick={() => emit(h24, m)}>{pad(m)}</button>)}</div><div className="time-column time-column-period" role="listbox" aria-label="AM or PM">{["AM", "PM"].map((p) => <button type="button" key={p} role="option" aria-selected={p === period} disabled={isPast(to24(hour12, p), 59)} className={p === period ? "time-option time-option-active" : "time-option"} onClick={() => emit(to24(hour12, p), minute)}>{p}</button>)}</div></div><button type="button" className="button button-primary time-done" onClick={() => setOpen(false)}>Done</button></div></>}</div>;
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
  const updateDate = (date: string) => onChange(`${date}T${timePart}`);
  return <div className="custom-datetime"><div className="custom-datetime-row"><div className="custom-picker-wrap date-picker-wrap"><button type="button" className="custom-picker-trigger" onClick={() => setCalendarOpen((current) => !current)} aria-expanded={calendarOpen}><CalendarDays size={16}/><span>{selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><ChevronRight size={15} className={calendarOpen ? "picker-chevron-open" : "picker-chevron"}/></button>{calendarOpen && <><button className="picker-dismiss" aria-label="Close calendar" onClick={() => setCalendarOpen(false)}/><div className="custom-calendar-popover"><div className="calendar-month-row"><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={16}/></button><b>{shownMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b><button type="button" className="room-icon-button" onClick={() => setShownMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={16}/></button></div><div className="calendar-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="calendar-days">{Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`}/>)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const date = `${shownMonth.getFullYear()}-${String(shownMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; const isPast = date < today; return <button type="button" key={date} disabled={isPast} className={`${date === datePart ? "calendar-day-active" : ""} ${date === today ? "calendar-day-today" : ""}`} onClick={() => { updateDate(date); setCalendarOpen(false); }}>{day}</button>; })}</div></div></>}</div><TimePicker value={timePart} datePart={datePart} onChange={(time) => onChange(`${datePart}T${time}`)} /></div><input className="visually-hidden-date-value" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} min={localDateTimeValue(new Date(Date.now() - 60_000))} tabIndex={-1} aria-hidden="true"/></div>;
}

function ScheduleModal({ instant, onClose, onCreated }: { instant: boolean; onClose: () => void; onCreated: (meeting: Meeting, shareUrl: string) => void }) {
  const [title, setTitle] = useState(instant ? "Choir prayer gathering" : "ENIHAKOLE choir meeting");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(localDateTimeValue(new Date(Date.now() + (instant ? 0 : 15 * 60_000))));
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [visibility, setVisibility] = useState<"link" | "public">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ meeting: Meeting; shareUrl: string } | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Kigali";

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!startsAt || !Number.isFinite(new Date(startsAt).getTime()) || new Date(startsAt).getTime() < Date.now() - 60_000) {
      setError("Choose a valid date and time that is not in the past.");
      return;
    }
    setBusy(true);
    try {
      const thumbnailUrl = "";
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

  return <Modal onClose={onClose} solidTop>
    {!created ? <div className="schedule-modal-content"><div className="modal-scroll-body"><div className="modal-heading-row"><span className="modal-brand-icon"><CalendarClock size={22}/></span><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19}/></button></div><p className="section-overline">MAKE IT A MOMENT TO REMEMBER</p><h2>{instant ? "Start a gathering now." : "Plan your next gathering."}</h2><p className="modal-subtitle">{instant ? "Create a room, then share the invitation with your choir." : "Set a time and send everyone one simple link to join."}</p>
      <form id="schedule-form" onSubmit={submit} className="form-stack schedule-form">
        <label className="field-label">Meeting title<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder="e.g. Wednesday prayer meeting" required/></label>
        <label className="field-label">Description <span className="optional-label">OPTIONAL</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={1000} placeholder="Add a short note to help people know what this gathering is for."/></label>
        <div className="form-row"><label className="field-label">Date and time<CustomDateTimePicker value={startsAt} onChange={setStartsAt} /></label><label className="field-label">Duration<DurationPicker value={durationMinutes} onChange={setDurationMinutes} /></label></div>
        <div className="field-label">Invitation access<div className="visibility-options"><button type="button" className={`visibility-option ${visibility === "link" ? "visibility-selected" : ""}`} onClick={() => setVisibility("link")}><span className="visibility-option-icon"><Link2 size={17}/></span><span><b>Anyone with the link</b><small>Best for choir WhatsApp groups</small></span>{visibility === "link" && <CheckCircle2 size={17}/>}</button><button type="button" className={`visibility-option ${visibility === "public" ? "visibility-selected" : ""}`} onClick={() => setVisibility("public")}><span className="visibility-option-icon"><Users size={17}/></span><span><b>Public listing</b><small>Show it on the home page</small></span>{visibility === "public" && <CheckCircle2 size={17}/>}</button></div></div>
        {error && <div className="inline-error" role="alert">{error}</div>}

      </form></div>
        <div className="schedule-modal-footer"><span className="modal-timezone"><Clock3 size={14}/>{timezone}</span><button className="button button-primary" type="submit" form="schedule-form" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : instant ? <Video size={16}/> : <CalendarDays size={16}/>} {busy ? "Creating…" : instant ? "Create meeting room" : "Schedule meeting"}<ArrowRight size={15}/></button></div>
    </div> : <div className="schedule-success"><div className="modal-scroll-body"><span className="success-icon"><CheckCircle2 size={27}/></span><p className="section-overline">YOUR INVITATION IS READY</p><h2>It's all set.</h2><p className="modal-subtitle">Share this meeting invitation with your choir. The link opens a page with the meeting thumbnail and details.</p><div className="success-meeting-preview"><img src={meetingImage(created.meeting)} alt="Meeting cover"/><div><b>{created.meeting.title}</b><small>{formatDate(created.meeting.startsAt, {}, created.meeting.timezone)} · {created.meeting.durationMinutes} min</small></div></div><div className="share-url-box"><Link2 size={15}/><span>{created.shareUrl}</span><button className="icon-button" onClick={copyShare} aria-label="Copy link"><Copy size={15}/></button></div></div><div className="success-actions modal-footer-fixed"><button className="button button-primary button-full" onClick={() => void shareMeeting()}><Share2 size={16}/> Share invitation</button><Link className="button button-soft button-full" to={`/meeting/${created.meeting.slug}`} onClick={onClose}>Open meeting page <ArrowRight size={16}/></Link><button className="text-action centered-action" onClick={onClose}>Back to workspace</button></div></div>}
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
