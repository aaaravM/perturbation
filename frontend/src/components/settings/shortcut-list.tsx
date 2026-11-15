"use client";
// Keyboard shortcuts: the Lab's own list (components/lab/command-palette.tsx), shown here too.

import { SHORTCUTS } from "@/components/lab/command-palette";
import { Kbd } from "@/components/ui/kbd";
import { SettingsSection } from "@/components/settings/controls";

export function ShortcutsSection() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <SettingsSection
      id="shortcuts"
      title="Keyboard shortcuts"
      description="In the Lab, when no text field has focus. Press ? there to see them over the sky."
    >
      <div className="grid gap-x-12 gap-y-7 py-5 sm:grid-cols-2" data-testid="shortcut-list">
        {groups.map((g) => (
          <section key={g} aria-label={g} className="flex flex-col gap-2">
            <h3 className="text-meta text-fg-faint">{g}</h3>
            <ul className="flex flex-col gap-1.5">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-4 text-meta text-fg-dim">
                  {s.label}
                  <span className="flex shrink-0 gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </SettingsSection>
  );
}
