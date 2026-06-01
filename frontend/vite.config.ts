/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest config lives alongside the Vite build config. We only test pure
// store/logic helpers (no DOM), so the `node` environment is sufficient and
// avoids pulling in jsdom. `globals: true` lets specs use describe/it/expect
// without importing them explicitly.
export default defineConfig({
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
  },
});
