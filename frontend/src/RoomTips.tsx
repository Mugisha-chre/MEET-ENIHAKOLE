import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lightbulb, WifiOff, X } from "lucide-react";
import { ConnectionQuality, ConnectionState, type Room } from "livekit-client";

/**
 * Gentle, rotating "did you know" tips for the call room. One tip at a time, never while the person is busy
 * (a panel is open, someone just messaged, a request is waiting), spaced out, each shown only a few times in total,
 * and any tip can be dismissed for good.
 */
export type RoomTip = { id: string; text: ReactNode; icon?: ReactNode; actionLabel?: string; onAction?: () => void };

const STORAGE_KEY = "meet-enihakole-room-tips";
const FIRST_DELAY_MS = 150_000; // first tip after two and a half minutes
const GAP_MS = 150_000; // then one more every two and a half minutes (never while busy)
const VISIBLE_MS = 10_000;
const MAX_SHOWS = 3;
// The install tip is the one that matters most for people who have not installed the app yet, so it keeps coming back more often
// (and "Don't show again" only rests it for a few days instead of removing it for good).
const INSTALL_TIP_ID = "install";
const INSTALL_MAX_SHOWS = 12;
const INSTALL_REST_MS = 3 * 24 * 60 * 60 * 1000;
const maxShowsFor = (id: string) => (id === INSTALL_TIP_ID ? INSTALL_MAX_SHOWS : MAX_SHOWS);
type TipMemory = { shown: Record<string, number>; dismissed: string[]; restUntil?: Record<string, number> };

function readMemory(): TipMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<TipMemory> | null;
    return { shown: parsed?.shown && typeof parsed.shown === "object" ? parsed.shown : {}, dismissed: Array.isArray(parsed?.dismissed) ? parsed.dismissed : [], restUntil: parsed?.restUntil && typeof parsed.restUntil === "object" ? parsed.restUntil : {} };
  } catch { return { shown: {}, dismissed: [] }; }
}
function saveMemory(memory: TipMemory) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch { /* Tips still rotate this session. */ } }

/** `getTips` returns the tips that make sense right now, in priority order; `busy` pauses the rotation. */
export function useRoomTips(getTips: () => RoomTip[], busy: boolean) {
  const [tip, setTip] = useState<RoomTip | null>(null);
  const getTipsRef = useRef(getTips);
  getTipsRef.current = getTips;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const memory = useRef<TipMemory>(readMemory());
  const nextAt = useRef(Date.now() + FIRST_DELAY_MS);
  const hideAt = useRef(0);
  const lastShown = useRef("");
  const tipRef = useRef<RoomTip | null>(null);
  tipRef.current = tip;

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now();
      if (tipRef.current) {
        if (busyRef.current || now >= hideAt.current) { setTip(null); nextAt.current = now + GAP_MS; }
        return;
      }
      if (busyRef.current || now < nextAt.current || document.visibilityState !== "visible") return;
      const eligible = getTipsRef.current().filter((item) => !memory.current.dismissed.includes(item.id) && (memory.current.shown[item.id] ?? 0) < maxShowsFor(item.id) && now >= (memory.current.restUntil?.[item.id] ?? 0));
      if (eligible.length === 0) { nextAt.current = now + GAP_MS * 2; return; }
      // Least-shown first, so every tip gets its turn before any repeats; never the same one twice in a row.
      // The install tip goes first whenever it is eligible (people who have not installed the app yet see it more often).
      const ordered = [...eligible].sort((a, b) => (a.id === INSTALL_TIP_ID ? 0 : 1) - (b.id === INSTALL_TIP_ID ? 0 : 1) || (memory.current.shown[a.id] ?? 0) - (memory.current.shown[b.id] ?? 0));
      const chosen = ordered.find((item) => item.id !== lastShown.current) ?? ordered[0];
      lastShown.current = chosen.id;
      memory.current = { ...memory.current, shown: { ...memory.current.shown, [chosen.id]: (memory.current.shown[chosen.id] ?? 0) + 1 } };
      saveMemory(memory.current);
      hideAt.current = now + VISIBLE_MS;
      setTip(chosen);
    }, 2000);
    return () => window.clearInterval(tick);
  }, []);

  const hide = useCallback(() => { setTip(null); nextAt.current = Date.now() + GAP_MS; }, []);
  const dismissForever = useCallback(() => {
    const current = tipRef.current;
    if (current && current.id === INSTALL_TIP_ID) { memory.current = { ...memory.current, restUntil: { ...memory.current.restUntil, [current.id]: Date.now() + INSTALL_REST_MS } }; saveMemory(memory.current); }
    else if (current) { memory.current = { ...memory.current, dismissed: [...memory.current.dismissed, current.id] }; saveMemory(memory.current); }
    hide();
  }, [hide]);
  return { tip, hide, dismissForever };
}

export function RoomTipCard({ tip, onHide, onDismissForever }: { tip: RoomTip; onHide: () => void; onDismissForever: () => void }) {
  return <div className="room-tip" role="status" key={tip.id}>
    <span className="room-tip-icon">{tip.icon ?? <Lightbulb size={16}/>}</span>
    <span className="room-tip-body"><span className="room-tip-text">{tip.text}</span>
      <span className="room-tip-actions">
        {tip.actionLabel && tip.onAction && <button type="button" className="room-tip-action" onClick={() => { tip.onAction?.(); onHide(); }}>{tip.actionLabel}</button>}
        <button type="button" className="room-tip-never" onClick={onDismissForever}>Don't show again</button>
      </span>
    </span>
    <button type="button" className="room-tip-close" onClick={onHide} aria-label="Dismiss tip"><X size={14}/></button>
  </div>;
}

/**
 * Weak-connection tip. It appears only when the connection is really weak (LiveKit rates it "poor" or "lost", or the browser reports a
 * 2G-class link) for several checks in a row, so a medium connection or a brief wobble never triggers it. It stays on screen until the
 * connection recovers or the person closes it ("Got it" snoozes it for a few minutes, "Don't show again" turns it off for good).
 */
const WEAK_KEY = "meet-enihakole-weak-network-tip-off";
const WEAK_SAMPLE_MS = 2000;
const WEAK_SAMPLES_TO_SHOW = 3; // about 6 seconds of weak connection in a row
const GOOD_SAMPLES_TO_HIDE = 3; // about 6 seconds of recovery before it goes away by itself
const WEAK_SNOOZE_MS = 3 * 60_000;

export function useWeakNetworkTip(room: Room | null | undefined) {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const snoozedUntil = useRef(0);
  const disabled = useRef((() => { try { return localStorage.getItem(WEAK_KEY) === "1"; } catch { return false; } })());
  const set = useCallback((value: boolean) => { visibleRef.current = value; setVisible(value); }, []);

  useEffect(() => {
    if (!room) return;
    let weak = 0;
    let good = 0;
    const timer = window.setInterval(() => {
      if (disabled.current || room.state !== ConnectionState.Connected) { weak = 0; if (visibleRef.current) set(false); return; }
      const quality = room.localParticipant?.connectionQuality;
      const link = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType || "";
      const isWeak = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost || link === "slow-2g" || link === "2g";
      const isGood = quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good;
      if (isWeak) { weak += 1; good = 0; } else if (isGood) { good += 1; weak = 0; } else { weak = 0; } // unknown/medium readings reset the weak streak
      if (!visibleRef.current && weak >= WEAK_SAMPLES_TO_SHOW && Date.now() >= snoozedUntil.current && document.visibilityState === "visible") set(true);
      else if (visibleRef.current && good >= GOOD_SAMPLES_TO_HIDE) set(false);
    }, WEAK_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [room, set]);

  const hide = useCallback(() => { snoozedUntil.current = Date.now() + WEAK_SNOOZE_MS; set(false); }, [set]);
  const dismissForever = useCallback(() => {
    disabled.current = true;
    try { localStorage.setItem(WEAK_KEY, "1"); } catch { /* Off for this session at least. */ }
    set(false);
  }, [set]);
  const tip: RoomTip = {
    id: "weak-network",
    icon: <WifiOff size={16}/>,
    text: "Your connection is weak, so you may miss parts of what others say. Try moving to a new location with a stronger signal.",
    actionLabel: "Got it",
    onAction: () => undefined,
  };
  return { visible, tip, hide, dismissForever };
}
