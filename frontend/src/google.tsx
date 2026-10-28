import { useEffect, useRef, useState } from "react";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GoogleId {
  initialize: (config: Record<string, unknown>) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
  prompt: () => void;
  cancel: () => void;
}
declare global {
  interface Window { google?: { accounts: { id: GoogleId } } }
}

let scriptPromise: Promise<void> | null = null;
let initialized = false;
let handler: ((credential: string) => void) | null = null;

export const googleConfigured = Boolean(CLIENT_ID);

function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC; script.async = true; script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => { scriptPromise = null; reject(new Error("Google sign-in could not be loaded. Check your connection.")); };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

async function ensureInitialized(): Promise<GoogleId> {
  await loadGoogle();
  const id = window.google!.accounts.id;
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

/** Shows the official "Continue with Google" button; optionally also Google One Tap (automatic account chooser). */
export function GoogleContinueButton({ onCredential, oneTap = false, onError }: { onCredential: (credential: string) => void; oneTap?: boolean; onError?: (message: string) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;
  const [failed, setFailed] = useState("");

  useEffect(() => {
    if (!googleConfigured) return;
    let cancelled = false;
    handler = (credential) => callbackRef.current(credential);
    ensureInitialized().then((id) => {
      if (cancelled || !holder.current) return;
      const width = Math.max(200, Math.min(360, Math.floor(holder.current.getBoundingClientRect().width) || 320));
      holder.current.innerHTML = "";
      id.renderButton(holder.current, { type: "standard", theme: document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline", size: "large", text: "continue_with", shape: "pill", logo_alignment: "left", width });
      if (oneTap) id.prompt();
    }).catch((cause: unknown) => {
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
  return <div className="google-continue"><div ref={holder} className="google-continue-button" />{failed && <div className="inline-error" role="alert">{failed}</div>}</div>;
}

/** Profile photo in a circle; falls back to initials when there is no photo or it fails to load. */
export function ProfilePhoto({ src, name, className = "" }: { src?: string; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  const words = name.replace(/[<>]/g, "").trim().split(/\s+/).filter(Boolean);
  const initials = (words.length ? (words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[1])[0]]) : ["?"]).join("").toUpperCase();
  return <span className={`profile-photo ${className}`}>{src && !broken ? <img src={src} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(true)} /> : <b>{initials}</b>}</span>;
}
