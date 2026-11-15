"use client";
// Connection: asks the Perturbation API for GET /api/health and shows whether it answered, how
// long the round trip took (measured here, in this browser), its version and the SPHEREx releases
// it can read. Checked once on load and again on request.

import * as React from "react";
import { RefreshCwIcon } from "lucide-react";
import { apiBase } from "@/lib/sky-live";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/settings/controls";

type Health =
  | { state: "checking" }
  | { state: "none" }
  | { state: "ok"; ms: number; version: string | null; releases: string[]; at: Date }
  | { state: "error"; message: string; at: Date };

/** "spherex_dr1", "spherex_qr3_deep" and so on, as release labels: DR1, QR3. */
function releasesFrom(collections: unknown): string[] {
  if (!Array.isArray(collections)) return [];
  const out = new Set<string>();
  for (const c of collections) {
    const m = typeof c === "string" ? /^spherex_([a-z]+\d+)/i.exec(c) : null;
    if (m) out.add(m[1].toUpperCase());
  }
  return [...out];
}

const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ConnectionSection() {
  const [base, setBase] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<Health>({ state: "checking" });
  const run = React.useRef(0);

  const check = React.useCallback(async (url: string) => {
    const n = ++run.current;
    if (!url) {
      setHealth({ state: "none" });
      return;
    }
    setHealth({ state: "checking" });
    const t0 = performance.now();
    try {
      const res = await fetch(`${url}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`It answered with HTTP ${res.status}.`);
      const j = (await res.json()) as { status?: string; version?: string; collections?: unknown };
      if (n !== run.current) return;
      setHealth({ state: "ok", ms, version: j.version ?? null, releases: releasesFrom(j.collections), at: new Date() });
    } catch (err) {
      if (n !== run.current) return;
      const message =
        err instanceof DOMException && err.name === "TimeoutError"
          ? "No answer within 12 seconds."
          : err instanceof Error && err.message.startsWith("It answered")
            ? err.message
            : "The request did not get through (offline, or blocked).";
      setHealth({ state: "error", message, at: new Date() });
    }
  }, []);

  React.useEffect(() => {
    const url = apiBase();
    const id = requestAnimationFrame(() => {
      setBase(url);
      void check(url);
    });
    return () => cancelAnimationFrame(id);
  }, [check]);

  const host = base ? base.replace(/^https?:\/\//, "") : null;
  return (
    <SettingsSection
      id="connection"
      title="Connection"
      description="The Perturbation API looks up stars, builds new Lab fields and reads SPHEREx spectra. The five prepared fields work without it."
    >
      <div className="flex flex-col gap-5 py-5" data-testid="connection">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <p aria-live="polite" className="text-body text-fg" data-testid="connection-status" data-state={health.state}>
            {health.state === "checking" && <span className="text-fg-dim">Checking the API&hellip;</span>}
            {health.state === "none" && <span className="text-fg-dim">This copy of the site has no API address set.</span>}
            {health.state === "ok" && (
              <>
                Online. It answered in <span className="readout">{health.ms.toLocaleString("en-US")} ms</span>.
              </>
            )}
            {health.state === "error" && (
              <>
                <span className="text-destructive">Not reachable.</span>{" "}
                <span className="text-fg-dim">{health.message}</span>
              </>
            )}
          </p>
          {base !== null && base !== "" && (
            <button
              type="button"
              onClick={() => void check(base)}
              disabled={health.state === "checking"}
              className="-my-2 inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg disabled:text-fg-faint"
            >
              <RefreshCwIcon
                aria-hidden
                className={cn("size-3.5", health.state === "checking" && "animate-spin reduced:animate-none")}
              />
              Check again
            </button>
          )}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-2.5 text-meta">
          <dt className="text-fg-dim">Address</dt>
          <dd className="readout truncate text-fg">{host ?? "None"}</dd>
          {health.state === "ok" && (
            <>
              <dt className="text-fg-dim">Version</dt>
              <dd className="readout text-fg">{health.version ?? "Not given"}</dd>
              <dt className="text-fg-dim">SPHEREx releases</dt>
              <dd className="text-fg">{health.releases.length ? health.releases.join(", ") : "None listed"}</dd>
            </>
          )}
          {(health.state === "ok" || health.state === "error") && (
            <>
              <dt className="text-fg-dim">Checked</dt>
              <dd className="readout text-fg">{timeOf(health.at)}</dd>
            </>
          )}
        </dl>
        <p className="text-micro text-pretty text-fg-faint">
          The time is the full round trip from this browser. After a quiet spell the first answer can take a few
          seconds while the service starts.
        </p>
      </div>
    </SettingsSection>
  );
}
