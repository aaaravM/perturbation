import type { Metadata } from "next";
import { HelpView } from "@/components/help/help-view";

export const metadata: Metadata = {
  title: "Help the search",
  description:
    "Look at blinking SPHEREx images and say what you see: real candidates from the automatic search, with known objects mixed in as checks.",
};

export default function HelpPage() {
  return <HelpView />;
}
