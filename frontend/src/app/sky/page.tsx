import type { Metadata } from "next";
import { Suspense } from "react";
import { SkyExperience } from "./sky-experience";

export const metadata: Metadata = {
  title: "Sky",
  description:
    "About 118,000 real stars in their true colours: click any of them for what is known about it and what NASA's SPHEREx has seen there, or fly out into 3D space around the Sun.",
};

export default function SkyPage() {
  return (
    <section
      aria-label="Sky mode"
      data-lenis-prevent
      className="relative h-[calc(100dvh-var(--nav-h))] min-h-[600px] w-full overflow-hidden bg-ink"
    >
      {/* nuqs reads the selection from the URL on the client, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <SkyExperience />
      </Suspense>
    </section>
  );
}
