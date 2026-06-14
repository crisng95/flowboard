/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest config lives alongside the Vite build config. We only test pure
// store/logic helpers (no DOM), so the `node` environment is sufficient and
// avoids pulling in jsdom. `globals: true` lets specs use describe/it/expect
// without importing them explicitly.
export default defineConfig(({ mode }) => {
  // Load .env.local so we can read VITE_CONTROL_PLANE_URL for the proxy
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiTarget = env.VITE_CONTROL_PLANE_URL || "https://api.flowboard.bond";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    test: {
      environment: "node",
      globals: true,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
    server: {
      port: 5173,
      proxy: {
        // Forward /api/* to the production control plane so localhost doesn't
        // get blocked by CORS (the browser sees the request coming from the
        // Vite origin, the proxy rewrites the host header).
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
