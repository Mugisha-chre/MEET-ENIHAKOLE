import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
});
