import { useCallback, useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { BookOpen, LoaderCircle, Plus, Send, X } from "lucide-react";
import { api } from "./api";
import type { Meeting } from "./types";

type Verse = { id: string; reference: string; text: string; createdBy?: string; createdByName?: string; createdAt?: string };
type Presenter = { userId: string; email: string; displayName: string };
type BibleState = { verses: Verse[]; presenters: Presenter[]; activeVerse: Verse | null; isHost: boolean; isPresenter: boolean };
const emptyBible: BibleState = { verses: [], presenters: [], activeVerse: null, isHost: false, isPresenter: false };

function broadcastVerse(room: ReturnType<typeof useRoomContext>, verse: Verse | null) {
  try {
    const payload = new TextEncoder().encode(JSON.stringify({ type: "meet:bible-verse", activeVerse: verse }));
    void room.localParticipant.publishData(payload, { reliable: true }).catch(() => undefined);
  } catch { /* The API remains the source of truth; clients refresh on resume. */ }
}

export function BibleVersePreparation({ meeting, canManage }: { meeting: Meeting; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BibleState>(emptyBible);
  const [reference, setReference] = useState("");
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await api.bibleVerses(meeting.slug);
    setState({ ...emptyBible, ...result });
  }, [meeting.slug]);
  useEffect(() => { if (canManage) void load().catch(() => undefined); }, [canManage, load]);

  async function saveVerses(next: Verse[]) {
    setBusy(true); setError("");
    try {
      const result = await api.saveBibleVerses(meeting.slug, next.map(({ reference: ref, text: verseText }) => ({ reference: ref, text: verseText })));
      setState((current) => ({ ...current, verses: result.verses || [], activeVerse: result.activeVerse || null }));
      setReference(""); setText("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the prepared verses."); }
    finally { setBusy(false); }
  }
  async function setPermission(allowed: boolean, targetEmail = email) {
    setBusy(true); setError("");
    try {
      const result = await api.setBiblePresenter(meeting.slug, targetEmail, allowed);
      setState((current) => ({ ...current, presenters: result.presenters || [] }));
      setEmail("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update presenter permission."); }
    finally { setBusy(false); }
  }

  if (!canManage) return null;
  return <section className="bible-preparation-card">
    <div className="bible-preparation-heading"><span className="bible-icon"><BookOpen size={19}/></span><div><b>Prepare Bible verses</b><small>Add scripture before the prayer begins and authorize a preacher to display it.</small></div><button type="button" className="button button-soft button-small" onClick={() => setOpen(true)}>Manage</button></div>
    {state.verses.length > 0 ? <p className="bible-preparation-count">{state.verses.length} prepared verse{state.verses.length === 1 ? "" : "s"} · {state.presenters.length} authorized presenter{state.presenters.length === 1 ? "" : "s"}</p> : <p className="bible-preparation-count">No verses prepared yet.</p>}
    {open && <div className="messages-modal-backdrop bible-tools-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="messages-modal bible-tools-modal" role="dialog" aria-modal="true" aria-label="Prepare Bible verses">
      <header className="messages-modal-header"><div className="meeting-panel-heading"><b>Prepare Bible verses</b><small>{meeting.title}</small></div><button type="button" className="room-icon-button" onClick={() => setOpen(false)} aria-label="Close Bible verse preparation"><X size={18}/></button></header>
      <div className="bible-tools-body">
        <div className="bible-prepared-list">{state.verses.map((verse) => <article className="bible-prepared-item" key={verse.id}><b>{verse.reference}</b><p>{verse.text}</p><button type="button" className="text-action" disabled={busy} onClick={() => void saveVerses(state.verses.filter((item) => item.id !== verse.id))}>Remove</button></article>)}{state.verses.length === 0 && <p className="bible-empty">Prepare scriptures here before the prayer starts.</p>}</div>
        <form className="bible-add-form" onSubmit={(event) => { event.preventDefault(); if (!reference.trim() || !text.trim()) return; void saveVerses([...state.verses, { id: crypto.randomUUID(), reference: reference.trim(), text: text.trim() }]); }}>
          <label>Scripture reference<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="e.g. Psalm 23:1–4" maxLength={120}/></label>
          <label>Verse text<textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Enter the scripture text…" rows={3} maxLength={4000}/></label>
          <button type="submit" className="button button-primary button-full" disabled={busy || !reference.trim() || !text.trim()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>} Add prepared verse</button>
        </form>
        <div className="bible-presenters"><b>Authorize a preacher</b><p>Enter the email address of a registered account. That person can choose when to display a prepared verse during the live prayer.</p><form onSubmit={(event) => { event.preventDefault(); if (email.trim()) void setPermission(true); }}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="preacher@example.com"/><button type="submit" className="button button-soft" disabled={busy || !email.trim()}>Allow</button></form>{state.presenters.map((person) => <div className="bible-presenter-row" key={person.userId}><span><b>{person.displayName}</b><small>{person.email}</small></span><button type="button" className="text-action" disabled={busy} onClick={() => void setPermission(false, person.email)}>Remove</button></div>)}</div>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
    </section></div>}
  </section>;
}

export function BibleVerseLiveTools({ slug, role }: { slug: string; role: "host" | "participant" }) {
  const room = useRoomContext();
  const [state, setState] = useState<BibleState>(emptyBible);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canPresent = role === "host" || state.isPresenter;

  const load = useCallback(async () => {
    const result = await api.bibleVerses(slug);
    setState((current) => ({ ...current, ...result, presenters: result.presenters || current.presenters }));
  }, [slug]);

  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive && document.visibilityState === "visible") void load().catch(() => undefined); };
    void load().catch(() => undefined);
    const onData = (payload: Uint8Array) => {
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; activeVerse?: Verse | null };
        if (message.type === "meet:bible-verse") setState((current) => ({ ...current, activeVerse: message.activeVerse || null }));
      } catch { /* Ignore unrelated LiveKit data packets. */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    document.addEventListener("visibilitychange", refresh);
    const safety = window.setInterval(refresh, 30_000);
    return () => { alive = false; room.off(RoomEvent.DataReceived, onData); document.removeEventListener("visibilitychange", refresh); window.clearInterval(safety); };
  }, [load, room]);

  async function display(verseId: string | null) {
    setBusy(true); setError("");
    try {
      const result = await api.displayBibleVerse(slug, verseId);
      setState((current) => ({ ...current, activeVerse: result.activeVerse || null }));
      broadcastVerse(room, result.activeVerse || null);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not display the Bible verse."); }
    finally { setBusy(false); }
  }

  return <>
    {state.activeVerse && <aside className="bible-live-overlay" role="status" aria-live="polite"><span><BookOpen size={17}/> Scripture for this prayer</span><b>{state.activeVerse.reference}</b><p>{state.activeVerse.text}</p></aside>}
    {canPresent && state.verses.length > 0 && <><button type="button" className="bible-live-trigger" onClick={() => setOpen(true)} aria-label="Open prepared Bible verses"><BookOpen size={18}/><span>Bible</span></button>{open && <div className="messages-modal-backdrop bible-tools-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="messages-modal bible-tools-modal" role="dialog" aria-modal="true" aria-label="Display a Bible verse"><header className="messages-modal-header"><div className="meeting-panel-heading"><b>Prepared Bible verses</b><small>Choose what everyone should see</small></div><button type="button" className="room-icon-button" onClick={() => setOpen(false)} aria-label="Close"><X size={18}/></button></header><div className="bible-tools-body"><div className="bible-prepared-list">{state.verses.map((verse) => <article className="bible-prepared-item" key={verse.id}><b>{verse.reference}</b><p>{verse.text}</p><button type="button" className="button button-soft button-small" disabled={busy} onClick={() => void display(verse.id)}><Send size={14}/> Display to everyone</button></article>)}</div>{state.activeVerse && <button type="button" className="button button-soft button-full" disabled={busy} onClick={() => void display(null)}>Hide displayed verse</button>}{error && <div className="inline-error" role="alert">{error}</div>}</div></section></div>}</>}
  </>;
}
