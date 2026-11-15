import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/settings-view";

export const metadata: Metadata = {
  title: "Settings",
  description: "Glass, motion and explanation marks; how the Sky globe and the Lab start; what this browser keeps.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
