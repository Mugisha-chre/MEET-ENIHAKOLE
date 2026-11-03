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

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* App works normally without offline support. */ });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
