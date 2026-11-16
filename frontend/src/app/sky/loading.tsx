import { SkySkeleton } from "@/components/sky-panel/sky-skeleton";

// The Sky globe's layout as blocks while the page itself loads, in the page's own frame.
export default function Loading() {
  return (
    <section aria-label="Sky mode" className="relative h-[calc(100dvh-var(--nav-h))] min-h-[600px] w-full overflow-hidden bg-ink">
      <SkySkeleton />
    </section>
  );
}
