import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { MotionPreference } from "@/components/site/motion-preference";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { SmoothScroll } from "@/components/site/smooth-scroll";
import { GlassFilters } from "@/components/ui/liquid-glass";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PREFERENCES_BOOT_SCRIPT, PREFERENCE_HTML_DEFAULTS } from "@/lib/preferences-schema";
import "./globals.css";

// IBM Plex (SIL Open Font License 1.1), self-hosted by next/font. See CREDITS.md.
const plexSans = IBM_Plex_Sans({
  weight: ["300", "400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: {
    default: "Planet X Hunter",
    template: "%s · Planet X Hunter",
  },
  description:
    "Flip between NASA SPHEREx infrared maps of any patch of sky to spot moving and variable objects. NASA Space Apps 2026, Team Ninth Vanguard.",
};

export const viewport: Viewport = {
  themeColor: "#050505",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The boot script may change the data-* settings on <html> before React hydrates.
    <html
      lang="en"
      className={`dark ${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      style={{ colorScheme: "dark" }}
      {...PREFERENCE_HTML_DEFAULTS}
      suppressHydrationWarning
    >
      <head>
        {/* Settings that change the look (glass, motion, explanation marks), before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_BOOT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-ink text-fg">
        <GlassFilters />
        <NuqsAdapter>
          <MotionPreference>
            <TooltipProvider delayDuration={200}>
              <SmoothScroll />
              <SiteNav />
              <main className="flex flex-1 flex-col">{children}</main>
              <SiteFooter />
              <Toaster />
            </TooltipProvider>
          </MotionPreference>
        </NuqsAdapter>
      </body>
    </html>
  );
}
