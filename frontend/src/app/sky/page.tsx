import type { Metadata } from "next";
import { Suspense } from "react";
import { SkyExperience } from "./sky-experience";

export const metadata: Metadata = {
  title: "Sky",
  description:
    "Turn a globe of the whole sky in NASA SPHEREx infrared light and choose an object to watch it move.",
};

export default function SkyPage() {
  return (
    <section
      aria-label="Sky mode"
      data-lenis-prevent
      className="relative h-[calc(100dvh-var(--nav-h))] min-h-[600px] w-full overflow-hidden bg-ink"
    >
      {/* nuqs reads ?target= on the client, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <SkyExperience />
      </Suspense>
    </section>
  );
}
