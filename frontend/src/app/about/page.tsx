import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/site/page-placeholder";

export const metadata: Metadata = { title: "About" };

export default function AboutPage() {
  return (
    <PagePlaceholder phase="9" kicker="About" title="Team Ninth Vanguard">
      <p>Team, data credits, licences and the AI-use disclosure will be published here.</p>
    </PagePlaceholder>
  );
}
