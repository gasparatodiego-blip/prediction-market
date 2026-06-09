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
        // v2.0 Bloomberg Terminal palette
        bg: {
          base:    "#0A0C10",
          panel:   "#12151C",
          elevated:"#1A1E27",
        },
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
        // legacy aliases kept for backward compat
        void:    "#0A0C10",
        surface: "#12151C",
        elevated:"#1A1E27",
        line:    "#232834",
        ink:     "#E4E7EB",
        muted:   "#8B919E",
        faint:   "#5A6072",
        brand:   "#6366F1",
        profit:  "#22C55E",
        warn:    "#F59E0B",
        loss:    "#EF4444",
      },
      borderRadius: {
        DEFAULT: "3px",
        sm: "2px",
        md: "4px",
        lg: "6px",
        xl: "8px",
        "2xl": "10px",
        full: "9999px",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "IBM Plex Mono", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":  "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "brand-gradient":  "linear-gradient(135deg,#6366F1,#818CF8)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4,0,0.6,1) infinite",
        "float":      "float 4s ease-in-out infinite",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%":     { transform: "translateY(-8px)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
