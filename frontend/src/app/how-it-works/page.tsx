import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/site/page-placeholder";

export const metadata: Metadata = { title: "How it works" };

export default function HowItWorksPage() {
  return (
    <PagePlaceholder phase="9" kicker="How it works" title="From SPHEREx exposures to a blink">
      <p>
        The data pipeline, validation results for the five test targets and the AI layer will be
        explained here.
      </p>
    </PagePlaceholder>
  );
}
