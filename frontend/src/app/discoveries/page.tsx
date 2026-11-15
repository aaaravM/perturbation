import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/site/page-placeholder";

export const metadata: Metadata = { title: "Discoveries" };

export default function DiscoveriesPage() {
  return (
    <PagePlaceholder phase="6" kicker="Discoveries" title="Candidate movers and variables">
      <p>
        Ranked candidates from the mover detector and spectral classifier, each with a calibrated
        confidence, will be listed here.
      </p>
    </PagePlaceholder>
  );
}
