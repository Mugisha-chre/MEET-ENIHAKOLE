import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Absolute public origin for the default link-preview image (relative og:image URLs are ignored by WhatsApp, Telegram, etc.).
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  const candidates = [env.FRONTEND_APP_URL, env.VITE_APP_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL];
  const publicOrigin = candidates
    .map((value) => (value || "").trim())
    .map((value) => (value && !/^https?:\/\//i.test(value) ? `https://${value}` : value))
    .find((value) => /^https?:\/\//i.test(value) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(value)) || "https://meet-enihakole.vercel.app";
  // One id per build. The app compares it with /version.json to notice a new deployment, and the service worker uses it as its cache name.
  const buildId = `${(env.VERCEL_GIT_COMMIT_SHA || env.RENDER_GIT_COMMIT || "").slice(0, 8) || "b"}-${Date.now().toString(36)}`;
  const versionPlugin = {
    name: "app-build-version",
    apply: "build" as const,
    closeBundle() {
      const dist = resolve(process.cwd(), "dist");
      if (!existsSync(dist)) return;
      mkdirSync(dist, { recursive: true });
      writeFileSync(resolve(dist, "version.json"), JSON.stringify({ version: buildId }));
      const sw = resolve(dist, "sw.js");
      if (existsSync(sw)) writeFileSync(sw, readFileSync(sw, "utf8").replaceAll("__BUILD_ID__", buildId));
    },
  };
  return {
  define: { __APP_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), versionPlugin, { name: "absolute-og-urls", transformIndexHtml: (html: string) => html.replaceAll("%APP_URL%", publicOrigin.replace(/\/+$/, "")) }],
  server: { port: 5173 },
  build: {
    target: "es2022",
    sourcemap: false,
    // Split heavy vendor code into separately cached chunks so app updates do not re-download React or LiveKit.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("livekit")) return "vendor-livekit";
          if (id.includes("react-router") || id.includes("react-dom") || /node_modules\/react\//.test(id)) return "vendor-react";
          return undefined;
        },
      },
    },
  },
};
});
