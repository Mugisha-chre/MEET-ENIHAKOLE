import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getAuthToken } from "./api";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GoogleId {
  initialize: (config: Record<string, unknown>) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
  prompt: () => void;
  cancel: () => void;
  disableAutoSelect?: () => void;
}
declare global {
  interface Window { google?: { accounts: { id: GoogleId } } }
}

let scriptPromise: Promise<void> | null = null;
let initialized = false;
let handler: ((credential: string) => void) | null = null;

export const googleConfigured = Boolean(CLIENT_ID);

/** Tells Google to stop silently re-selecting this account, so signing out really signs the person out of MEET ENIHAKOLE. */
export function googleSignOut() {
  try { window.google?.accounts.id.disableAutoSelect?.(); window.google?.accounts.id.cancel(); } catch { /* Google script not loaded. */ }
}

/** Google serves profile photos at a requested size (…=s96-c). Ask for a large, sharp copy so avatars stay crisp on big and high-DPI screens. */
export function hiResPhoto(src: string | undefined, size = 400): string {
  if (!src) return "";
  try {
    const url = new URL(src);
    if (!/^lh\d*\.googleusercontent\.com$/i.test(url.hostname)) return src;
    const sized = `s${size}-c`;
    if (/=[sw]\d+(-[a-z0-9-]+)?$/i.test(url.pathname + url.search)) return src.replace(/=[sw]\d+(-[a-z0-9-]+)?$/i, `=${sized}`);
    if (/\/s\d+(-c)?\//.test(url.pathname)) { url.pathname = url.pathname.replace(/\/s\d+(-c)?\//, `/${sized}/`); return url.toString(); }
    return url.search ? src : `${src}=${sized}`;
  } catch { return src; }
}

function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    // index.html already starts downloading the script before the app code runs; reuse that tag instead of fetching twice.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const fail = () => { scriptPromise = null; existing?.remove(); reject(new Error("Google sign-in could not be loaded. Check your connection.")); };
    if (existing) {
      if (window.google?.accounts?.id) { resolve(); return; }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => { fail(); }, { once: true });
      // Safety net: the tag may have finished loading before we attached listeners.
      const poll = window.setInterval(() => { if (window.google?.accounts?.id) { window.clearInterval(poll); resolve(); } }, 50);
      window.setTimeout(() => window.clearInterval(poll), 15000);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC; script.async = true; script.defer = true;
    script.onload = () => resolve();
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Synchronous: returns Google's API the moment the script is loaded (initialising it once), otherwise null. */
function initializeNow(): GoogleId | null {
  const id = window.google?.accounts?.id;
  if (!id) return null;
  if (!initialized) {
    id.initialize({
      client_id: CLIENT_ID,
      callback: (response: { credential?: string }) => { if (response.credential) handler?.(response.credential); },
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
      itp_support: true,
    });
    initialized = true;
  }
  return id;
}

async function ensureInitialized(): Promise<GoogleId> {
  await loadGoogle();
  return initializeNow()!;
}

const BUTTON_OPTIONS = { type: "standard", size: "large", text: "continue_with", shape: "pill", logo_alignment: "left" } as const;
const buttonTheme = () => (document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline");

/** Shows the official "Continue with Google" button; optionally also Google One Tap (automatic account chooser). */
export function GoogleContinueButton({ onCredential, oneTap = false, onError }: { onCredential: (credential: string) => void; oneTap?: boolean; onError?: (message: string) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;
  const [failed, setFailed] = useState("");

  // Layout effect + synchronous path: when Google is already preloaded the real button is drawn before the first paint.
  useLayoutEffect(() => {
    if (!googleConfigured) return;
    let cancelled = false;
    handler = (credential) => callbackRef.current(credential);
    const paint = (id: GoogleId) => {
      if (cancelled || !holder.current) return;
      const width = Math.max(200, Math.min(360, holder.current.offsetWidth || 320));
      holder.current.innerHTML = "";
      id.renderButton(holder.current, { ...BUTTON_OPTIONS, theme: buttonTheme(), width });
      if (oneTap) id.prompt();
    };
    const ready = initializeNow();
    (ready ? Promise.resolve(ready) : ensureInitialized()).then(paint).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "Google sign-in is unavailable.";
      if (!cancelled) { setFailed(message); onError?.(message); }
    });
    return () => {
      cancelled = true;
      if (handler) handler = null;
      if (oneTap) { try { window.google?.accounts.id.cancel(); } catch { /* One Tap already closed. */ } }
    };
  }, [oneTap, onError]);

  if (!googleConfigured) return <div className="inline-error" role="alert">Google sign-in is not configured yet. Add VITE_GOOGLE_CLIENT_ID to the frontend environment.</div>;
  // The look-alike button under the real one is visible instantly (logo and label included) while Google's own button finishes drawing on top of it.
  return <div className="google-continue"><div className="google-slot">{!failed && <div className="google-fallback" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg><span>Continue with Google</span></div>}<div ref={holder} className="google-continue-button" /></div>{failed && <div className="inline-error" role="alert">{failed}</div>}</div>;
}

const loadedPhotos = new Set<string>();
const pendingPhotos = new Map<string, Promise<void>>();

/** Downloads and decodes a profile photo ahead of time so it appears instantly (and without a spinner) when shown. */
export function preloadPhoto(src: string | undefined, size = 512): Promise<void> {
  const url = hiResPhoto(src, size);
  if (!url || loadedPhotos.has(url)) return Promise.resolve();
  let task = pendingPhotos.get(url);
  if (!task) {
    task = new Promise<void>((resolve) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onload = () => { loadedPhotos.add(url); resolve(); };
      img.onerror = () => resolve();
      img.src = url;
    });
    pendingPhotos.set(url, task);
  }
  return task;
}

/** Waits (briefly) for a person's photo to be ready, so the interface shows it the moment they appear. Never blocks for long. */
export function preloadPhotoBriefly(src: string | undefined, size = 512, maxMs = 1500): Promise<void> {
  return Promise.race([preloadPhoto(src, size), new Promise<void>((resolve) => setTimeout(resolve, maxMs))]);
}

/** Profile photo in a circle. While it downloads a small spinner shows (never a "?"); initials appear only if there is no photo or it fails. */
export function ProfilePhoto({ src, name, className = "", size = 256 }: { src?: string; name: string; className?: string; size?: number }) {
  const url = src ? hiResPhoto(src, size) : "";
  const [state, setState] = useState<"loading" | "ready" | "error">(() => !url ? "error" : loadedPhotos.has(url) ? "ready" : "loading");
  useEffect(() => { setState(!url ? "error" : loadedPhotos.has(url) ? "ready" : "loading"); }, [url]);
  const words = name.replace(/[<>]/g, "").trim().split(/\s+/).filter(Boolean);
  const initials = (words.length === 1 ? Array.from(words[0]).slice(0, 2) : words.length ? [Array.from(words[0])[0], Array.from(words[1])[0]] : []).join("").toUpperCase();
  const markReady = () => { loadedPhotos.add(url); setState("ready"); };
  const spinner = <span className="profile-photo-spinner" aria-hidden="true"><LoaderCircle className="spin"/></span>;
  return <span className={`profile-photo ${state === "loading" ? "profile-photo-loading" : ""} ${className}`}>
    {url && state !== "error" && <img ref={(el) => { if (el?.complete && el.naturalWidth > 0 && state === "loading") markReady(); }} src={url} alt="" loading="eager" decoding="async" referrerPolicy="no-referrer" draggable={false} onLoad={markReady} onError={() => setState("error")} />}
    {state === "loading" ? spinner : state === "error" ? (initials ? <b>{initials}</b> : spinner) : null}
  </span>;
}

// Preload at app start: script, initialisation and a hidden warm-up render, so the sign-in modal never waits on Google.
if (googleConfigured && typeof window !== "undefined") {
  void ensureInitialized().then((id) => {
    if (getAuthToken() || !document.body) return;
    const warm = document.createElement("div");
    warm.setAttribute("aria-hidden", "true");
    warm.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;height:44px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(warm);
    try { id.renderButton(warm, { ...BUTTON_OPTIONS, theme: buttonTheme(), width: 320 }); } catch { /* Warm-up is optional. */ }
    window.setTimeout(() => warm.remove(), 8000);
  }).catch(() => { /* The button reports the error itself when it is shown. */ });
}
