import { LabSkeleton } from "@/components/lab/lab-skeleton";

// The Lab's panes as blocks while the page itself loads, in the page's own frame.
export default function Loading() {
  return (
    <section aria-label="Lab" className="relative h-[calc(100dvh-var(--nav-h))] min-h-[560px] w-full overflow-hidden bg-ink">
      <LabSkeleton detect />
    </section>
  );
}
