import type { Metadata } from "next";
import { DiscoveriesView } from "@/components/discoveries/discoveries-view";

export const metadata: Metadata = {
  title: "Discoveries",
  description:
    "Candidate movers and brightness changes from an automatic search of SPHEREx images, each with its images, a calibrated confidence and a q-value.",
};

export default function DiscoveriesPage() {
  return <DiscoveriesView />;
}
