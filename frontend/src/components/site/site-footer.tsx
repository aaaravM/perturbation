// Footer: data credits, UI-library credits (Skiper UI free tier requires attribution), team line.

import { DATA_CREDITS, TEAM_LINE } from "@/lib/site";

const UI_CREDITS = [
  { label: "shadcn/ui", href: "https://ui.shadcn.com" },
  { label: "Cult UI", href: "https://www.cult-ui.com" },
  { label: "Watermelon UI", href: "https://ui.watermelon.sh" },
  { label: "Skiper UI", href: "https://skiper-ui.com" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-hair bg-ink">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 text-meta text-fg-faint sm:px-6 md:grid-cols-[1fr_auto] md:items-end">
        <ul className="flex flex-col gap-1">
          {DATA_CREDITS.map((credit) => (
            <li key={credit}>{credit}</li>
          ))}
        </ul>
        <div className="flex flex-col gap-1 md:items-end md:text-right">
          <p>
            Interface components from{" "}
            {UI_CREDITS.map((c, i) => (
              <span key={c.href}>
                <a
                  href={c.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-fg-dim underline decoration-hair-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-dim"
                >
                  {c.label}
                </a>
                {i < UI_CREDITS.length - 2 ? ", " : i === UI_CREDITS.length - 2 ? " and " : ""}
              </span>
            ))}
            .
          </p>
          <p className="text-fg-dim">{TEAM_LINE}</p>
        </div>
      </div>
    </footer>
  );
}
