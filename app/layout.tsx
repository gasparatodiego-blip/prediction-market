import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Bricolage_Grotesque } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import ScrollToTop from "@/components/ScrollToTop";

// ── Legacy terminal fonts (kept until pages are rebuilt) ──────────────────────
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

// ── Edgeradar design system fonts ─────────────────────────────────────────────
const bricolageDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-display",
});
// --font-body is aliased to --font-sans in globals.css :root

export const metadata: Metadata = {
  title: { default: "Edgeradar", template: "%s | Edgeradar" },
  description: "AI-powered arbitrage scanner across 12+ prediction market platforms",
  metadataBase: new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F5F8F6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Theme comes from a cookie so the server can stamp data-theme during SSR —
  // the CSS-var surfaces resolve their palette on the first paint, no flash of
  // the wrong theme. Default day when the cookie is absent.
  const theme = cookies().get("theme")?.value === "night" ? "night" : "day";
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${inter.variable} ${jetbrainsMono.variable} ${bricolageDisplay.variable}`}
    >
      <body className="antialiased">
        {/* Single global scroll-to-top on route change — covers every tab and
            every detail page. Window-scroll reset (matches the real setup: the
            document scrolls, not an inner container). */}
        <ScrollToTop />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
