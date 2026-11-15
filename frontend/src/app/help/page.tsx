import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/site/page-placeholder";

export const metadata: Metadata = { title: "Help the search" };

export default function HelpPage() {
  return (
    <PagePlaceholder phase="8" kicker="Help the search" title="Review candidates with us">
      <p>
        A citizen-science review loop (vote real, artifact or unsure on candidate blinks) will live
        here.
      </p>
    </PagePlaceholder>
  );
}
