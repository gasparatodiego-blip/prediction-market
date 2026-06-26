import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Terminal palette (legacy — kept until pages are rebuilt) ──────────
        "bg-base":    "#0A0C10",
        "bg-panel":   "#12151C",
        "bg-elevated":"#1A1E27",
        border: {
          DEFAULT: "#232834",
        },
        text: {
          primary:   "#E4E7EB",
          secondary: "#8B919E",
          muted:     "#5A6072",
        },
        accent: {
          DEFAULT: "#6366F1",
          bright:  "#818CF8",
        },
        positive: "#22C55E",
        negative: "#EF4444",
        warning:  "#F59E0B",
        // legacy flat aliases
        void:    "#0A0C10",
        elevated:"#1A1E27",
        brand:   "#6366F1",
        profit:  "#22C55E",
        warn:    "#F59E0B",
        loss:    "#EF4444",
        faint:   "#5A6072",

        // ── Edgeradar design tokens ──────────────────────────────────────────
        // Base neutrals
        bg:          "#F5F8F6",
        "bg-soft":   "#EBF1EE",
        surface:     "#FFFFFF",
        ink:         "#0B1A15",
        "ink-2":     "#33433D",
        muted:       "#6C7E78",
        line:        "#E3ECE7",
        // Signal: cashable (green)
        mint:        "#0FBE82",
        "mint-deep": "#0A9D6B",
        "mint-tint": "#E2F7EE",
        // Signal: paper / indicative (warm red)
        coral:       "#FF7A59",
        "coral-tint":"#FFEAE3",
        "coral-ink": "#D5552F",
        // Signal: divergence / low-confidence (indigo)
        violet:      "#5566D6",
        "violet-tint":"#EEF1FF",
        // Signal: speculative / rate-variable (amber)
        gold:        "#C8821C",
        "gold-tint": "#FFF3E2",
        // Trap — stage mismatch, play money, etc.
        trap:        "#E5564E",
      },

      borderRadius: {
        // ── Terminal (legacy) ─────────────────────────────────────────────────
        DEFAULT: "3px",
        sm:  "2px",
        md:  "4px",
        lg:  "6px",
        xl:  "8px",
        "2xl": "10px",
        full: "9999px",
        // ── Edgeradar ─────────────────────────────────────────────────────────
        card:   "16px",
        panel:  "20px",
        pill:   "999px",
        button: "12px",
      },

      boxShadow: {
        card: "0 1px 2px rgba(11,26,21,.04), 0 8px 28px rgba(11,26,21,.06)",
      },

      fontFamily: {
        // ── Terminal (legacy) ─────────────────────────────────────────────────
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "IBM Plex Mono", "monospace"],
        // ── Edgeradar ─────────────────────────────────────────────────────────
        display: ["var(--font-display)", "Bricolage Grotesque", "system-ui", "sans-serif"],
        body:    ["var(--font-body)", "Inter", "system-ui", "sans-serif"],
      },

      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":  "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "brand-gradient":  "linear-gradient(135deg,#6366F1,#818CF8)",
        // Edgeradar
        "mint-gradient":   "linear-gradient(135deg,#0FBE82,#0A9D6B)",
      },

      keyframes: {
        // ── Terminal (legacy) ─────────────────────────────────────────────────
        float: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%":     { transform: "translateY(-8px)" },
        },
        // ── Edgeradar ─────────────────────────────────────────────────────────
        // Radar ping: starts small+visible, expands+fades
        "er-ping": {
          "0%":       { transform: "scale(.4)", opacity: ".7" },
          "80%,100%": { transform: "scale(2.2)", opacity: "0" },
        },
        // Note: er-spin uses the Tailwind built-in `spin` (rotate 360deg).
        // Use animate-spin for that; er-ping is the custom one.
      },

      animation: {
        // ── Terminal (legacy) ─────────────────────────────────────────────────
        "pulse-slow": "pulse 3s cubic-bezier(0.4,0,0.6,1) infinite",
        float:        "float 4s ease-in-out infinite",
        // ── Edgeradar ─────────────────────────────────────────────────────────
        "er-ping": "er-ping 1.4s ease-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
