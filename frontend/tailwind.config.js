/**
 * Tailwind config — design system inspired by Magnific Spaces.
 *
 * Coexists with the legacy `styles.css` during the V2 migration.
 *
 * NOTE on file extension: this is `.js` (not `.ts`). Tailwind v3 with
 * the standard PostCSS pipeline doesn't transpile a `.ts` config out
 * of the box, so the previous `.ts` version was being ignored —
 * Tailwind ran with built-in defaults only, which left every custom
 * utility (`bg-surface-1`, `text-ink-muted`, `rounded-node`, etc.)
 * unstyled. Symptom: font sizes inherit from the page (looking huge
 * inside React-Flow nodes that don't get the rest preset), gaps
 * collapse, the `hidden` utility falls back to nothing.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: "#0f0f0f",
          group: "#111111",
        },
        surface: {
          1: "#141414",
          2: "#1a1a1a",
          3: "#262626",
        },
        line: {
          subtle: "#2a2a2a",
          strong: "#333333",
          accent: "rgba(124,92,255,0.45)",
        },
        accent: {
          DEFAULT: "#7c5cff",
          400: "#9d80ff",
          500: "#7c5cff",
          600: "#5e3ee5",
          700: "#4a2bc7",
        },
        edge: "rgba(124,92,255,0.55)",
        ink: {
          primary: "#f5f5f5",
          muted: "#ababab",
          placeholder: "#666666",
        },
        status: {
          queued: "#f5b301",
          running: "#7c5cff",
          done: "#6ee7b7",
          error: "#ef4444",
        },
      },
      fontFamily: {
        sans: [
          "Geist",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.02em" }],
        xs: ["11px", { lineHeight: "15px" }],
        sm: ["12px", { lineHeight: "16px" }],
        base: ["13px", { lineHeight: "18px" }],
        lg: ["14px", { lineHeight: "20px" }],
      },
      borderRadius: {
        node: "16px",
        group: "20px",
        media: "12px",
        chip: "9999px",
      },
      boxShadow: {
        node: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -8px rgba(0,0,0,0.6)",
        "node-hover":
          "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 12px 32px -8px rgba(0,0,0,0.7)",
        "node-selected":
          "0 0 0 1px rgba(124,92,255,0.5), 0 8px 32px -4px rgba(124,92,255,0.25)",
        glass:
          "0 1px 0 0 rgba(255,255,255,0.05) inset, 0 8px 32px -4px rgba(0,0,0,0.5)",
      },
      backgroundImage: {
        "run-gradient":
          "linear-gradient(135deg, #9d80ff 0%, #7c5cff 50%, #5e3ee5 100%)",
        "run-gradient-hover":
          "linear-gradient(135deg, #b29eff 0%, #9d80ff 50%, #7c5cff 100%)",
        "node-header-tint":
          "linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 100%)",
      },
      animation: {
        "fade-in": "fadeIn 120ms ease-out",
        "scale-in": "scaleIn 140ms cubic-bezier(0.16, 1, 0.3, 1)",
        "pulse-soft": "pulseSoft 2.4s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        scaleIn: {
          from: { opacity: "0", transform: "translateY(-4px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
