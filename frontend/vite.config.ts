import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8101",
      "/media": "http://127.0.0.1:8101",
      "/ws": {
        target: "ws://127.0.0.1:8101",
        ws: true,
      },
    },
  },
});
