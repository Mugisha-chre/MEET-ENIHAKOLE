import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@livekit/components-styles";
import "./styles.css";
import App from "./App";

// Capture the install prompt early so the install button can use it even if it fires before React mounts.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = event;
  window.dispatchEvent(new Event("pwa-prompt-ready"));
});

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
