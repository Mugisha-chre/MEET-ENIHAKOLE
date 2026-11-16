import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RefreshCw, Send, X } from "lucide-react";
import { readCache, writeCache } from "./cache";

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
  ["1KI", "1 Abami", 22], ["2KI", "2 Abami", 25], ["1CH", "1 Ibyomburabyo", 29], ["2CH", "2 Ibyomburabyo", 36], ["EZR", "Ezira", 10],
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
  | { kind: "helloao"; translation: string; label: string }
  | { kind: "getbible"; translation: string; label: string };
type Verse = { n: number; text: string };

const ENV = import.meta.env as Record<string, string | undefined>;
const POSITION_KEY = "meet-enihakole-bible-position";
const FONT_KEY = "meet-enihakole-bible-font";
const SOURCE_KEY = "bible-source-kin";

async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Bible source answered ${response.status}`);
    return await response.json() as T;
  } finally { window.clearTimeout(timer); }
}

const isKinyarwanda = (value: unknown) => typeof value === "string" && /kinyarwanda|^kin$|^rw$|^rwa$/i.test(value.trim());

/** Finds a Kinyarwanda translation. The result is remembered so the next visit needs no lookup. */
async function discoverSource(): Promise<Source> {
  const pinnedKind = ENV.VITE_BIBLE_SOURCE as "helloao" | "getbible" | undefined;
  const pinnedTranslation = ENV.VITE_BIBLE_TRANSLATION;
  if (pinnedKind && pinnedTranslation) return { kind: pinnedKind, translation: pinnedTranslation, label: ENV.VITE_BIBLE_LABEL || "Bibiliya" };
  const cached = readCache<Source>(SOURCE_KEY);
  if (cached) return cached.value;
  const attempts: Array<() => Promise<Source | null>> = [
    async () => {
      const data = await getJson<{ translations?: Array<Record<string, string>> }>("https://bible.helloao.org/api/available_translations.json");
      const hit = (data.translations || []).find((item) => isKinyarwanda(item.language) || isKinyarwanda(item.languageEnglishName) || isKinyarwanda(item.languageName));
      return hit ? { kind: "helloao", translation: hit.id, label: hit.name || hit.englishName || "Bibiliya" } : null;
    },
    async () => {
      const data = await getJson<Record<string, Record<string, string>>>("https://api.getbible.net/v2/translations.json");
      const hit = Object.entries(data).find(([, item]) => isKinyarwanda(item.language) || isKinyarwanda(item.lang) || isKinyarwanda(item.translation));
      return hit ? { kind: "getbible", translation: hit[0], label: hit[1].translation || "Bibiliya" } : null;
    },
  ];
  for (const attempt of attempts) {
    try { const found = await attempt(); if (found) { writeCache(SOURCE_KEY, found); return found; } } catch { /* try the next source */ }
  }
  throw new Error("The Kinyarwanda Bible text could not be reached right now.");
}

const cleanText = (value: string) => value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
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

async function loadChapter(source: Source, book: BookInfo, chapter: number): Promise<Verse[]> {
  const key = `bible:${source.kind}:${source.translation}:${book.id}:${chapter}`;
  const cached = readCache<Verse[]>(key);
  if (cached) return cached.value;
  let verses: Verse[] = [];
  if (source.kind === "helloao") {
    const data = await getJson<{ chapter?: { content?: Array<{ type: string; number?: number; content?: unknown }> } }>(`https://bible.helloao.org/api/${encodeURIComponent(source.translation)}/${book.id}/${chapter}.json`);
    verses = (data.chapter?.content || []).filter((item) => item.type === "verse" && typeof item.number === "number").map((item) => ({ n: item.number as number, text: cleanText(flatten(item.content)) })).filter((item) => item.text);
  } else {
    const data = await getJson<{ verses?: Array<{ verse: number; text: string }> }>(`https://api.getbible.net/v2/${encodeURIComponent(source.translation)}/${book.nr}/${chapter}.json`);
    verses = (data.verses || []).map((item) => ({ n: item.verse, text: cleanText(item.text) })).filter((item) => item.text);
  }
  if (verses.length === 0) throw new Error("This chapter is empty in the selected Bible.");
  writeCache(key, verses);
  return verses;
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
  const [source, setSource] = useState<Source | null>(null);
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
        const active = source ?? await discoverSource();
        if (cancelled) return;
        if (!source) setSource(active);
        const list = await loadChapter(active, book, position.chapter);
        if (cancelled) return;
        setVerses(list);
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Position is a convenience only. */ }
        bodyRef.current?.scrollTo({ top: 0 });
      } catch (cause) {
        if (!cancelled) { setVerses([]); setError(cause instanceof Error ? cause.message : "The chapter could not be loaded."); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [book, position, source, reload]);

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
        <div className="meeting-panel-heading"><b>Bibiliya</b><small>{source?.label ? `${source.label} · ` : ""}{meetingTitle}</small></div>
        <button className="room-icon-button" onClick={onClose} aria-label="Close Bible"><X size={18}/></button>
      </header>
      {nav}
      <div className="bible-toolbar">
        <button type="button" className="bible-ref" onClick={() => { setPicker((open) => !open); setPickerBook(null); setTestament(book.ot ? "ot" : "nt"); }} aria-expanded={picker}>
          <BookOpen size={16}/><span>{book.name} {position.chapter}</span><ChevronRight size={14} className={picker ? "bible-ref-open" : ""}/>
        </button>
        <div className="bible-font" role="group" aria-label="Text size">
          <button type="button" onClick={() => changeFont(-1)} disabled={fontStep === 0} aria-label="Smaller text"><Minus size={15}/></button>
          <button type="button" onClick={() => changeFont(1)} disabled={fontStep === 4} aria-label="Larger text"><Plus size={15}/></button>
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
        {!loading && error && <div className="bible-state bible-state-error" role="alert"><b>Ntibishobotse gufungura Bibiliya</b><span>{error}</span><button type="button" onClick={() => { setSource(null); setReload((value) => value + 1); }}><RefreshCw size={14}/> Gerageza ukundi</button></div>}
        {!loading && !error && <article className="bible-text">
          <h3>{book.name} {position.chapter}</h3>
          {verses.map((verse) => <p key={verse.n} className={selected.includes(verse.n) ? "is-selected" : ""} onClick={() => toggleVerse(verse.n)}><sup>{verse.n}</sup>{verse.text}</p>)}
        </article>}
      </div>
      <footer className="bible-footer">
        {selected.length > 0 && onShareVerse
          ? <button type="button" className="bible-share" onClick={shareSelected}><Send size={15}/> Share {selected.length === 1 ? "verse" : `${selected.length} verses`} in chat</button>
          : <>
            <button type="button" onClick={() => go(-1)} disabled={atStart || loading} aria-label="Previous chapter"><ChevronLeft size={18}/> <span>Ibanza</span></button>
            <small>{book.name} {position.chapter}</small>
            <button type="button" onClick={() => go(1)} disabled={atEnd || loading} aria-label="Next chapter"><span>Ibikurikira</span> <ChevronRight size={18}/></button>
          </>}
      </footer>
    </section>
  </div>;
}
