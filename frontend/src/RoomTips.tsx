import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lightbulb, X } from "lucide-react";

/**
 * Gentle, rotating "did you know" tips for the call room. One tip at a time, never while the person is busy
 * (a panel is open, someone just messaged, a request is waiting), spaced out, each shown only a few times in total,
 * and any tip can be dismissed for good.
 */
export type RoomTip = { id: string; text: ReactNode; icon?: ReactNode; actionLabel?: string; onAction?: () => void };

const STORAGE_KEY = "meet-enihakole-room-tips";
const FIRST_DELAY_MS = 28_000;
const GAP_MS = 55_000;
const VISIBLE_MS = 10_000;
const MAX_SHOWS = 3;
type TipMemory = { shown: Record<string, number>; dismissed: string[] };

function readMemory(): TipMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<TipMemory> | null;
    return { shown: parsed?.shown && typeof parsed.shown === "object" ? parsed.shown : {}, dismissed: Array.isArray(parsed?.dismissed) ? parsed.dismissed : [] };
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
      const eligible = getTipsRef.current().filter((item) => !memory.current.dismissed.includes(item.id) && (memory.current.shown[item.id] ?? 0) < MAX_SHOWS);
      if (eligible.length === 0) { nextAt.current = now + GAP_MS * 2; return; }
      // Least-shown first, so every tip gets its turn before any repeats; never the same one twice in a row.
      const ordered = [...eligible].sort((a, b) => (memory.current.shown[a.id] ?? 0) - (memory.current.shown[b.id] ?? 0));
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
    if (current) { memory.current = { ...memory.current, dismissed: [...memory.current.dismissed, current.id] }; saveMemory(memory.current); }
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
