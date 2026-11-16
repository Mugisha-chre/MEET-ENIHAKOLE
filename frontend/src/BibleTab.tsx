import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RefreshCw, Send, X } from "lucide-react";
import { readCache, removeCache, writeCache } from "./cache";

/**
 * Bible tab for the call room, in Kinyarwanda.
 * The text is loaded on demand from free Bible APIs (the translation is discovered automatically by language),
 * and every chapter that has been read is kept on the device, so it opens instantly and works offline afterwards.
 * Set VITE_BIBLE_SOURCE ("helloao" or "getbible") and VITE_BIBLE_TRANSLATION to pin a specific source/translation.
 */

type BookInfo = { id: string; nr: number; name: string; chapters: number; ot: boolean };
const RAW: Array<[string, string, number]> = [
  ["GEN", "Itangiriro", 50], ["EXO", "Kuva", 40], ["LEV", "Abalewi", 27], ["NUM", "Kubara", 36], ["DEU", "Gutegeka kwa Kabiri", 34],
  ["JOS", "Yosuwa", 24], ["JDG", "Abacamanza", 21], ["RUT", "Rusi", 4], ["1SA", "1 Samweli", 31], ["2SA", "2 Samweli", 24],
  ["1KI", "1 Abami", 22], ["2KI", "2 Abami", 25], ["1CH", "1 Ibyo ku Ngoma", 29], ["2CH", "2 Ibyo ku Ngoma", 36], ["EZR", "Ezira", 10],
  ["NEH", "Nehemiya", 13], ["EST", "Esiteri", 10], ["JOB", "Yobu", 42], ["PSA", "Zaburi", 150], ["PRO", "Imigani", 31],
  ["ECC", "Umubwiriza", 12], ["SNG", "Indirimbo ya Salomo", 8], ["ISA", "Yesaya", 66], ["JER", "Yeremiya", 52], ["LAM", "Amaganya", 5],
  ["EZK", "Ezekiyeli", 48], ["DAN", "Daniyeli", 12], ["HOS", "Hoseya", 14], ["JOL", "Yoweli", 3], ["AMO", "Amosi", 9],
  ["OBA", "Obadiya", 1], ["JON", "Yona", 4], ["MIC", "Mika", 7], ["NAM", "Nahumu", 3], ["HAB", "Habakuki", 3],
  ["ZEP", "Zefaniya", 3], ["HAG", "Hagayi", 2], ["ZEC", "Zekariya", 14], ["MAL", "Malaki", 4],
  ["MAT", "Matayo", 28], ["MRK", "Mariko", 16], ["LUK", "Luka", 24], ["JHN", "Yohana", 21], ["ACT", "Ibyakozwe n'Intumwa", 28],
  ["ROM", "Abaroma", 16], ["1CO", "1 Abakorinto", 16], ["2CO", "2 Abakorinto", 13], ["GAL", "Abagalatiya", 6], ["EPH", "Abefeso", 6],
  ["PHP", "Abafilipi", 4], ["COL", "Abakolosayi", 4], ["1TH", "1 Abatesalonike", 5], ["2TH", "2 Abatesalonike", 3], ["1TI", "1 Timoteyo", 6],
  ["2TI", "2 Timoteyo", 4], ["TIT", "Tito", 3], ["PHM", "Filemoni", 1], ["HEB", "Abaheburayo", 13], ["JAS", "Yakobo", 5],
  ["1PE", "1 Petero", 5], ["2PE", "2 Petero", 3], ["1JN", "1 Yohana", 5], ["2JN", "2 Yohana", 1], ["3JN", "3 Yohana", 1],
  ["JUD", "Yuda", 1], ["REV", "Ibyahishuwe", 22],
];
export const BIBLE_BOOKS: BookInfo[] = RAW.map(([id, name, chapters], index) => ({ id, nr: index + 1, name, chapters, ot: index < 39 }));

type Source =
  | { kind: "helloao"; translation: string; label: string; books?: string[] }
  | { kind: "getbible"; translation: string; label: string; books?: string[] }
  | { kind: "bolls"; translation: string; label: string; books?: string[] };
type Verse = { n: number; text: string };

const ENV = import.meta.env as Record<string, string | undefined>;
const POSITION_KEY = "meet-enihakole-bible-position";
const FONT_KEY = "meet-enihakole-bible-font";
const SOURCES_KEY = "bible-sources-kin-v3";
const SOURCES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function getJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Bible source answered ${response.status}`);
    return await response.json() as T;
  } finally { window.clearTimeout(timer); }
}

const isKinyarwanda = (value: unknown) => typeof value === "string" && /kinyarwanda|ikinyarwanda|rwanda|^kin$|^rw$|^rwa$|^kin[-_]|^rw[-_]/i.test(value.trim());
const looksKinyarwanda = (item: Record<string, unknown>) =>
  ["language", "languageName", "languageEnglishName", "lang", "languageCode", "iso6393", "id"].some((key) => isKinyarwanda(item[key])) ||
  ["name", "englishName", "translation", "shortName"].some((key) => typeof item[key] === "string" && /kinyarwanda|ikinyarwanda|bibiliya|ibibiliya/i.test(item[key] as string));

/**
 * Finds every Kinyarwanda Bible the free sources offer. A single translation is often incomplete (many are New Testament only),
 * so all of them are kept together with the books each one really has, and each chapter is read from the first one that has it.
 * The list is remembered for a week so the next visit needs no lookup.
 */
async function discoverSources(): Promise<Source[]> {
  const pinned: Source[] = [];
  const pinnedKind = ENV.VITE_BIBLE_SOURCE as Source["kind"] | undefined;
  const pinnedTranslation = ENV.VITE_BIBLE_TRANSLATION;
  if (pinnedKind && pinnedTranslation) pinned.push({ kind: pinnedKind, translation: pinnedTranslation, label: ENV.VITE_BIBLE_LABEL || "Bibiliya" });
  const cached = readCache<Source[]>(SOURCES_KEY);
  if (cached && Array.isArray(cached.value) && cached.value.length > 0 && Date.now() - cached.savedAt < SOURCES_MAX_AGE_MS) return [...pinned, ...cached.value];

  const fromHelloao = async (): Promise<Source[]> => {
    const data = await getJson<{ translations?: Array<Record<string, unknown>> }>("https://bible.helloao.org/api/available_translations.json");
    const hits = (data.translations || []).filter((item) => typeof item.id === "string" && looksKinyarwanda(item)).slice(0, 8);
    const found = await Promise.all(hits.map(async (item): Promise<Source | null> => {
      try {
        const info = await getJson<{ books?: Array<{ id?: string }> }>(`https://bible.helloao.org/api/${encodeURIComponent(item.id as string)}/books.json`, 9000);
        const books = (info.books || []).map((entry) => String(entry.id || "").toUpperCase()).filter(Boolean);
        if (books.length === 0) return null;
        return { kind: "helloao", translation: item.id as string, label: String(item.name || item.englishName || "Bibiliya"), books };
      } catch { return null; }
    }));
    return found.filter((item): item is Source => Boolean(item)).sort((a, b) => (b.books?.length ?? 0) - (a.books?.length ?? 0));
  };
  const fromBolls = async (): Promise<Source[]> => {
    const data = await getJson<Array<{ language?: string; translations?: Array<{ short_name?: string; full_name?: string }> }>>("https://bolls.life/static/bolls/app/views/languages.json");
    const language = (data || []).find((item) => isKinyarwanda(item.language));
    return (language?.translations || []).filter((item) => item.short_name).map((item) => ({ kind: "bolls" as const, translation: item.short_name as string, label: item.full_name || item.short_name || "Bibiliya" }));
  };
  const fromGetbible = async (): Promise<Source[]> => {
    const data = await getJson<Record<string, Record<string, string>>>("https://api.getbible.net/v2/translations.json");
    return Object.entries(data || {}).filter(([, item]) => item && looksKinyarwanda(item)).map(([id, item]) => ({ kind: "getbible" as const, translation: id, label: item.translation || "Bibiliya" }));
  };

  const results = await Promise.allSettled([fromHelloao(), fromBolls(), fromGetbible()]);
  const list = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (list.length === 0 && pinned.length === 0) throw new Error("The Kinyarwanda Bible text could not be reached right now.");
  if (list.length > 0) writeCache(SOURCES_KEY, list);
  return [...pinned, ...list];
}

const cleanText = (value: string) => value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
const stripMarkup = (value: string) => cleanText(value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"));
function flatten(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (node && typeof node === "object") {
    const item = node as Record<string, unknown>;
    if (item.noteId !== undefined || item.type === "footnote") return "";
    if (typeof item.text === "string") return item.text;
    if ("content" in item) return flatten(item.content);
  }
  return "";
}

/** Keeps verses in order, one per number, so every chapter reads cleanly even when a source repeats or mixes up lines. */
function tidyVerses(list: Verse[]): Verse[] {
  const byNumber = new Map<number, string>();
  for (const verse of list) {
    if (!Number.isFinite(verse.n) || verse.n < 1 || !verse.text) continue;
    byNumber.set(verse.n, byNumber.has(verse.n) ? `${byNumber.get(verse.n)} ${verse.text}` : verse.text);
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([n, text]) => ({ n, text }));
}

async function fetchFromSource(source: Source, book: BookInfo, chapter: number): Promise<Verse[]> {
  if (source.kind === "helloao") {
    const data = await getJson<{ chapter?: { content?: Array<{ type?: string; number?: number | string; content?: unknown }> } }>(`https://bible.helloao.org/api/${encodeURIComponent(source.translation)}/${book.id}/${chapter}.json`);
    return tidyVerses((data.chapter?.content || [])
      .filter((item) => item.type === "verse" && Number.isFinite(Number(item.number)))
      .map((item) => ({ n: Number(item.number), text: cleanText(flatten(item.content)) })));
  }
  if (source.kind === "bolls") {
    const data = await getJson<Array<{ verse: number; text: string }>>(`https://bolls.life/get-text/${encodeURIComponent(source.translation)}/${book.nr}/${chapter}/`);
    return tidyVerses((Array.isArray(data) ? data : []).map((item) => ({ n: Number(item.verse), text: stripMarkup(String(item.text || "")) })));
  }
  const data = await getJson<{ verses?: Array<{ verse: number; text: string }> }>(`https://api.getbible.net/v2/${encodeURIComponent(source.translation)}/${book.nr}/${chapter}.json`);
  return tidyVerses((data.verses || []).map((item) => ({ n: Number(item.verse), text: stripMarkup(String(item.text || "")) })));
}

/** Reads a chapter from the first source that really has it; chapters already read are kept on the device. */
async function loadChapter(sources: Source[], book: BookInfo, chapter: number): Promise<{ verses: Verse[]; label: string }> {
  const key = `bible2:${book.id}:${chapter}`;
  const cached = readCache<{ verses: Verse[]; label: string }>(key);
  if (cached && cached.value.verses?.length) return cached.value;
  // A source's book list is only a hint (some list books they cannot serve and some serve books they do not list), so sources that
  // list the book are tried first and the rest still get a turn before giving up.
  const listed = sources.filter((source) => !source.books || source.books.includes(book.id));
  const others = sources.filter((source) => !listed.includes(source));
  const candidates = [...listed, ...others];
  if (candidates.length === 0) throw new Error("This book is not available yet in the online Kinyarwanda Bible sources.");
  let lastError: unknown = null;
  for (const source of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const verses = await fetchFromSource(source, book, chapter);
        if (verses.length > 0) {
          const value = { verses, label: source.label };
          writeCache(key, value);
          return value;
        }
        break; // The source answered but has no text for this chapter: try the next source.
      } catch (cause) {
        lastError = cause;
        if (cause instanceof Error && /answered 404/.test(cause.message)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }
  }
  throw lastError instanceof Error && !/answered 404/.test(lastError.message) ? new Error("The chapter could not be loaded. Check your connection and try again.") : new Error("This chapter is not available in the online Kinyarwanda Bible sources yet.");
}

function readPosition(): { book: number; chapter: number } {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) || "null") as { book?: number; chapter?: number } | null;
    const book = BIBLE_BOOKS.find((item) => item.nr === parsed?.book);
    if (book && parsed?.chapter && parsed.chapter >= 1 && parsed.chapter <= book.chapters) return { book: book.nr, chapter: parsed.chapter };
  } catch { /* first visit */ }
  return { book: 19, chapter: 23 }; // Zaburi 23
}

export function BibleTab({ meetingTitle, nav, onClose, onShareVerse }: { meetingTitle: string; nav: ReactNode; onClose: () => void; onShareVerse?: (text: string) => void }) {
  const [position, setPosition] = useState(readPosition);
  const [picker, setPicker] = useState(false);
  const [pickerBook, setPickerBook] = useState<number | null>(null);
  const [testament, setTestament] = useState<"ot" | "nt">(() => (readPosition().book > 39 ? "nt" : "ot"));
  const [fontStep, setFontStep] = useState(() => { const saved = Number(localStorage.getItem(FONT_KEY)); return Number.isFinite(saved) && saved >= 0 && saved <= 4 ? saved : 1; });
  const sourcesRef = useRef<Source[] | null>(null);
  const [label, setLabel] = useState("");
  const [verses, setVerses] = useState<Verse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const book = useMemo(() => BIBLE_BOOKS.find((item) => item.nr === position.book) ?? BIBLE_BOOKS[0], [position.book]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setSelected([]);
    (async () => {
      try {
        if (!sourcesRef.current) sourcesRef.current = await discoverSources();
        if (cancelled) return;
        let result: { verses: Verse[]; label: string };
        try {
          result = await loadChapter(sourcesRef.current, book, position.chapter);
        } catch (firstFailure) {
          // The remembered source list may be old: look the sources up again once before reporting a problem.
          removeCache(SOURCES_KEY);
          const fresh = await discoverSources().catch(() => null);
          if (cancelled) return;
          if (!fresh) throw firstFailure;
          sourcesRef.current = fresh;
          result = await loadChapter(fresh, book, position.chapter);
        }
        if (cancelled) return;
        setVerses(result.verses);
        setLabel(result.label);
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Position is a convenience only. */ }
        bodyRef.current?.scrollTo({ top: 0 });
        // Quietly warm the next chapter so turning the page is instant (and works if the connection drops).
        const nextChapter = position.chapter < book.chapters ? { b: book, c: position.chapter + 1 } : (BIBLE_BOOKS[book.nr] ? { b: BIBLE_BOOKS[book.nr], c: 1 } : null);
        if (nextChapter && sourcesRef.current) void loadChapter(sourcesRef.current, nextChapter.b, nextChapter.c).catch(() => undefined);
      } catch (cause) {
        if (!cancelled) { setVerses([]); setError(cause instanceof Error ? cause.message : "The chapter could not be loaded."); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [book, position, reload]);

  const go = useCallback((delta: number) => {
    setPosition((current) => {
      const index = BIBLE_BOOKS.findIndex((item) => item.nr === current.book);
      const currentBook = BIBLE_BOOKS[index];
      const next = current.chapter + delta;
      if (next >= 1 && next <= currentBook.chapters) return { book: current.book, chapter: next };
      const target = BIBLE_BOOKS[index + (delta > 0 ? 1 : -1)];
      if (!target) return current;
      return { book: target.nr, chapter: delta > 0 ? 1 : target.chapters };
    });
  }, []);
  const atStart = position.book === 1 && position.chapter === 1;
  const atEnd = position.book === 66 && position.chapter === 22;

  const changeFont = (delta: number) => setFontStep((current) => {
    const next = Math.max(0, Math.min(4, current + delta));
    try { localStorage.setItem(FONT_KEY, String(next)); } catch { /* Not essential. */ }
    return next;
  });

  const toggleVerse = (n: number) => setSelected((current) => (current.includes(n) ? current.filter((item) => item !== n) : [...current, n].sort((a, b) => a - b)));
  const shareSelected = () => {
    if (!onShareVerse || selected.length === 0) return;
    const chosen = verses.filter((verse) => selected.includes(verse.n));
    const label = selected.length === 1 ? `${book.name} ${position.chapter}:${selected[0]}` : `${book.name} ${position.chapter}:${selected[0]}-${selected[selected.length - 1]}`;
    onShareVerse(`📖 ${label}\n${chosen.map((verse) => verse.text).join(" ")}`);
    setSelected([]);
  };

  const pickerBooks = BIBLE_BOOKS.filter((item) => (testament === "ot") === item.ot);
  const chosenBook = pickerBook ? BIBLE_BOOKS.find((item) => item.nr === pickerBook) : null;

  return <div className="messages-modal-backdrop bible-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="messages-modal bible-modal" role="dialog" aria-modal="true" aria-label="Bibiliya">
      <header className="messages-modal-header">
        <button className="room-icon-button" onClick={onClose} aria-label="Back to call"><ArrowLeft size={18}/></button>
        <div className="meeting-panel-heading"><b>Bibiliya</b><small>{label ? `${label} · ` : ""}{meetingTitle}</small></div>
        <button className="room-icon-button" onClick={onClose} aria-label="Close Bible"><X size={18}/></button>
      </header>
      {nav}
      <div className="bible-toolbar">
        <button type="button" className="bible-ref" onClick={() => { setPicker((open) => !open); setPickerBook(null); setTestament(book.ot ? "ot" : "nt"); }} aria-expanded={picker}>
          <BookOpen size={16}/><span>{book.name} {position.chapter}</span><ChevronRight size={14} className={picker ? "bible-ref-open" : ""}/>
        </button>
        <div className="bible-font" role="group" aria-label="Ingano y'inyandiko">
          <button type="button" onClick={() => changeFont(-1)} disabled={fontStep === 0} aria-label="Gabanya inyandiko"><Minus size={15}/></button>
          <button type="button" onClick={() => changeFont(1)} disabled={fontStep === 4} aria-label="Ongera inyandiko"><Plus size={15}/></button>
        </div>
      </div>
      {picker && <div className="bible-picker">
        {!chosenBook ? <>
          <div className="bible-testaments" role="tablist">
            <button type="button" role="tab" aria-selected={testament === "ot"} className={testament === "ot" ? "is-active" : ""} onClick={() => setTestament("ot")}>Isezerano rya Kera</button>
            <button type="button" role="tab" aria-selected={testament === "nt"} className={testament === "nt" ? "is-active" : ""} onClick={() => setTestament("nt")}>Isezerano Rishya</button>
          </div>
          <div className="bible-books">{pickerBooks.map((item) => <button type="button" key={item.id} className={item.nr === book.nr ? "is-active" : ""} onClick={() => setPickerBook(item.nr)}>{item.name}</button>)}</div>
        </> : <>
          <button type="button" className="bible-picker-back" onClick={() => setPickerBook(null)}><ChevronLeft size={15}/> {chosenBook.name}</button>
          <div className="bible-chapters">{Array.from({ length: chosenBook.chapters }, (_, index) => index + 1).map((chapter) => <button type="button" key={chapter} className={chosenBook.nr === book.nr && chapter === position.chapter ? "is-active" : ""} onClick={() => { setPosition({ book: chosenBook.nr, chapter }); setPicker(false); setPickerBook(null); }}>{chapter}</button>)}</div>
        </>}
      </div>}
      <div className="bible-body" ref={bodyRef} style={{ "--bible-size": `${[13, 15, 17, 19, 22][fontStep]}px` } as React.CSSProperties}>
        {loading && <div className="bible-state" role="status"><LoaderCircle size={22} className="spin"/><span>Turimo gufungura Bibiliya…</span></div>}
        {!loading && error && <div className="bible-state bible-state-error" role="alert"><b>Ntibishobotse gufungura Bibiliya</b><span>{error}</span><button type="button" onClick={() => { sourcesRef.current = null; removeCache(SOURCES_KEY); setReload((value) => value + 1); }}><RefreshCw size={14}/> Gerageza ukundi</button></div>}
        {!loading && !error && <article className="bible-text">
          <h3>{book.name} {position.chapter}</h3>
          {verses.map((verse) => <p key={verse.n} className={selected.includes(verse.n) ? "is-selected" : ""} onClick={() => toggleVerse(verse.n)}><sup>{verse.n}</sup>{verse.text}</p>)}
        </article>}
      </div>
      <footer className="bible-footer">
        {selected.length > 0 && onShareVerse
          ? <button type="button" className="bible-share" onClick={shareSelected}><Send size={15}/> Sangiza {selected.length === 1 ? "umurongo" : `imirongo ${selected.length}`} mu kiganiro</button>
          : <>
            <button type="button" onClick={() => go(-1)} disabled={atStart || loading} aria-label="Igice kibanza"><ChevronLeft size={18}/> <span>Ibanza</span></button>
            <small>{book.name} {position.chapter}</small>
            <button type="button" onClick={() => go(1)} disabled={atEnd || loading} aria-label="Igice gikurikira"><span>Ibikurikira</span> <ChevronRight size={18}/></button>
          </>}
      </footer>
    </section>
  </div>;
}
