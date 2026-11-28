import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@livekit/components-styles";
import "./styles.css";
import App from "./App";
import { warmServer } from "./api";

// Prefer CSS dynamic viewport units on current browsers. Updating the app shell
// from visualViewport.height while a user pinches or pans changes that height in
// CSS pixels and can make the header/nav jump or leave a gap after history restore.
// The fallback is only for older browsers without dvh; multiplying by scale
// converts the visible viewport back to layout CSS pixels before sizing the shell.
function syncAppViewportHeight() {
  if (typeof CSS !== "undefined" && CSS.supports("height: 100dvh")) return;

  const root = document.documentElement;
  let frame = 0;
  let settleTimer = 0;
  const update = () => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const scale = viewport && Number.isFinite(viewport.scale) && viewport.scale > 0 ? viewport.scale : 1;
      const height = viewport ? viewport.height * scale : window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        root.style.setProperty("--app-viewport-height", `${Math.round(height * 100) / 100}px`);
      }
    });
  };
  const settle = () => {
    update();
    window.requestAnimationFrame(update);
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(update, 180);
  };
  const onVisibility = () => { if (document.visibilityState === "visible") settle(); };

  window.addEventListener("resize", update, { passive: true });
  window.addEventListener("orientationchange", settle, { passive: true });
  window.addEventListener("pageshow", settle);
  document.addEventListener("visibilitychange", onVisibility);
  // Only viewport size changes affect the shell; visualViewport scroll events
  // are commonly emitted during pinch-zoom and must not resize the app.
  window.visualViewport?.addEventListener("resize", update, { passive: true });
  settle();
}

syncAppViewportHeight();

// Capture the install prompt early so the install button can use it even if it fires before React mounts.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = event;
  window.dispatchEvent(new Event("pwa-prompt-ready"));
});

warmServer();

/**
 * Automatic updates. Whenever a new version is deployed, anyone who opens (or returns to) the app gets it without
 * refreshing by hand: the new service worker takes over at once, old caches are deleted and the page reloads one time.
 * A reload is never forced in the middle of a live meeting; it is applied as soon as the person leaves the room.
 */
const RELOAD_MARK = "meet-enihakole-reloaded-for";
const inLiveRoom = () => Boolean(document.querySelector(".conference-fullscreen-target"));
async function purgeCaches() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    await Promise.all((regs || []).map((reg) => reg.update().catch(() => undefined)));
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("meet-enihakole-")).map((key) => caches.delete(key)));
  } catch { /* Best effort. */ }
}
async function reloadForUpdate(remote: string) {
  try {
    if (sessionStorage.getItem(RELOAD_MARK) === remote) return; // already tried once for this version: never loop
    sessionStorage.setItem(RELOAD_MARK, remote);
  } catch { /* storage unavailable: still reload once below */ }
  await purgeCaches();
  window.location.reload();
}
let checking = false;
async function checkForNewVersion() {
  if (checking || typeof __APP_BUILD_ID__ === "undefined") return;
  checking = true;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (data.version && data.version !== __APP_BUILD_ID__ && !inLiveRoom()) await reloadForUpdate(data.version);
  } catch { /* Offline or version file missing: keep running the current version. */ }
  finally { checking = false; }
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let swReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // A new service worker took control of a page that was already open: load the new version.
    if (!hadController || swReloaded) return;
    swReloaded = true;
    if (inLiveRoom()) return; // the version check below reloads once the person has left the room
    window.location.reload();
  });
  const register = () => navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
    .then((reg) => {
      void reg.update().catch(() => undefined);
      window.setInterval(() => void reg.update().catch(() => undefined), 5 * 60 * 1000);
    })
    .catch(() => { /* App works normally without offline support. */ });
  if (document.readyState === "complete") void register(); else window.addEventListener("load", () => void register());
}

if (import.meta.env.PROD) {
  void checkForNewVersion();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkForNewVersion(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) void checkForNewVersion(); });
  window.addEventListener("focus", () => void checkForNewVersion());
  window.setInterval(() => void checkForNewVersion(), 2 * 60 * 1000);
}

// The animated splash (index.html) plays first on a free main thread; the app mounts right after it, then the splash
// stays for a moment and fades out once the app has painted. With no splash (already shown this session) it mounts at once.
function mountApp() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => (window as unknown as { __hideSplash?: () => void }).__hideSplash?.()));
}
const afterSplash = (window as unknown as { __splashAfterAnimation?: (callback: () => void) => void }).__splashAfterAnimation;
if (afterSplash) afterSplash(mountApp); else mountApp();
