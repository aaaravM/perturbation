// Lab mode: the research tool. /explore?ra=&dec=&fov=&target=&mode=&det=&frame=&layers=
import type { Metadata } from "next";
import { Suspense } from "react";
import { LabWorkspace } from "@/components/lab/lab-workspace";
import { Skeleton } from "@/components/ui/skeleton";

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
      {/* nuqs reads search params on the client, which needs a Suspense boundary. */}
      <Suspense fallback={<LabFallback />}>
        <LabWorkspace />
      </Suspense>
    </section>
  );
}

function LabFallback() {
  return (
    <div className="absolute inset-0 flex flex-col justify-between p-4">
      <Skeleton className="h-32 w-full max-w-[400px] bg-ink-3" />
      <Skeleton className="mx-auto h-36 w-full max-w-[820px] bg-ink-3" />
    </div>
  );
}
