// Footer: what the project is and who made it, where to go next, whose data it shows, and the
// interface credits (Skiper UI's free tier requires attribution).

import Link from "next/link";
import { DATA_CREDITS, MODE_LINKS, PAGE_LINKS, REPO_URL, SETTINGS_LINK } from "@/lib/site";

const UI_CREDITS = [
  { label: "shadcn/ui", href: "https://ui.shadcn.com" },
  { label: "Cult UI", href: "https://www.cult-ui.com" },
  { label: "Watermelon UI", href: "https://ui.watermelon.sh" },
  { label: "Skiper UI", href: "https://skiper-ui.com" },
] as const;

const COLUMNS = [
  { title: "Explore", links: [...MODE_LINKS, PAGE_LINKS[0]] },
  { title: "Project", links: [...PAGE_LINKS.slice(1), SETTINGS_LINK] },
] as const;

const linkClass =
  "rounded-sm text-fg-dim underline-offset-4 transition-colors duration-200 hover:text-fg hover:underline hover:decoration-hair-strong";

export function SiteFooter() {
  return (
    <footer className="border-t border-hair bg-ink">
      <div className="mx-auto grid max-w-7xl gap-x-10 gap-y-10 px-4 pt-12 pb-10 sm:px-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1.5fr)] lg:pt-14">
        <div className="flex flex-col gap-3">
          <p className="text-ui font-medium tracking-[-0.01em] text-fg">Planet X Hunter</p>
          <p className="max-w-[36ch] text-meta text-pretty text-fg-dim">
            A public tool for exploring NASA SPHEREx infrared images of the sky and seeing what changes
            between visits.
          </p>
          <p className="max-w-[40ch] text-meta text-fg-faint">
            Team Ninth Vanguard. Built for NASA Space Apps 2026, challenge &ldquo;Planet X and SPHEREx&rdquo;.
          </p>
        </div>

        <nav aria-label="Footer" className="grid grid-cols-2 gap-6">
          {COLUMNS.map((col) => (
            <div key={col.title} className="flex flex-col gap-3">
              <p className="text-meta text-fg-faint">{col.title}</p>
              <ul className="flex flex-col gap-2 text-meta">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={linkClass}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-3">
          <p className="text-meta text-fg-faint">Data</p>
          <ul className="flex flex-col gap-1.5 text-meta text-fg-dim">
            {DATA_CREDITS.map((credit) => (
              <li key={credit}>{credit}</li>
            ))}
          </ul>
          <p className="text-meta">
            <Link href="/about" className={linkClass}>
              Full credits and licences
            </Link>
          </p>
        </div>
      </div>

      <div className="border-t border-hair">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-micro text-fg-faint sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
          <p>
            Interface components from{" "}
            {UI_CREDITS.map((c, i) => (
              <span key={c.href}>
                <a href={c.href} target="_blank" rel="noreferrer" className={linkClass}>
                  {c.label}
                </a>
                {i < UI_CREDITS.length - 2 ? ", " : i === UI_CREDITS.length - 2 ? " and " : ""}
              </span>
            ))}
            .
          </p>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={`${linkClass} shrink-0`}>
            Source code on GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
