// Lab mode: the research tool. /explore?ra=&dec=&fov=&target=&mode=&det=&frame=&layers=
import type { Metadata } from "next";
import { Suspense } from "react";
import { LabSkeleton } from "@/components/lab/lab-skeleton";
import { LabWorkspace } from "@/components/lab/lab-workspace";

export const metadata: Metadata = {
  title: "Lab",
  description:
    "Blink SPHEREx infrared images of any patch of sky to spot moving and variable objects, with spectra, light curves and measured motion.",
};

export default function ExplorePage() {
  return (
    <section
      aria-label="Lab"
      className="relative h-[calc(100dvh-var(--nav-h))] min-h-[560px] w-full overflow-hidden bg-ink"
    >
      {/* nuqs reads search params on the client, which needs a Suspense boundary. Until the
          workbench's scripts arrive, its panes stand as blocks. */}
      <Suspense fallback={<LabSkeleton detect />}>
        <LabWorkspace />
      </Suspense>
    </section>
  );
}

