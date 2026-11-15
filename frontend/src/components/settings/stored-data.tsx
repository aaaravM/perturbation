"use client";
// Data and privacy: everything this site keeps in this browser (localStorage keys that start with
// "pxh"), each with a Clear button. Your settings are cleared through the preferences store, so
// every open page follows at once.

import * as React from "react";
import { Trash2Icon } from "lucide-react";
import { PREFS_STORAGE_KEY, resetPreferences, subscribePreferences } from "@/lib/preferences";
import { SettingsSection, useFlash } from "@/components/settings/controls";
import { TOUR_SEEN_KEY } from "@/lib/tour";

const KNOWN: Record<string, { label: string; detail: string }> = {
  [PREFS_STORAGE_KEY]: { label: "Your settings", detail: "The choices on this page." },
  "pxh-lab-left": { label: "Lab, left pane width", detail: "Set by dragging the edge of the Data pane." },
  "pxh-lab-right": { label: "Lab, right pane width", detail: "Set by dragging the edge of the Analysis pane." },
  "pxh-lab-hint-seen": { label: "Lab, first-visit tip", detail: "Remembers that you closed the tip." },
  [TOUR_SEEN_KEY]: { label: "Guided tours, first-visit offers", detail: "Remembers which tools have offered their tour." },
  "pxh:api": { label: "API address", detail: "Points a development copy of the site at an API." },
};

interface StoredItem {
  key: string;
  bytes: number;
}

function readItems(): StoredItem[] {
  try {
    const out: StoredItem[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !/^pxh[:-]/.test(key)) continue;
      out.push({ key, bytes: new Blob([key, window.localStorage.getItem(key) ?? ""]).size });
    }
    return out.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  } catch {
    return [];
  }
}

const KNOWN_ORDER = Object.keys(KNOWN);
const order = (key: string) => {
  const i = KNOWN_ORDER.indexOf(key);
  return i < 0 ? KNOWN_ORDER.length : i;
};

function removeItem(key: string) {
  if (key === PREFS_STORAGE_KEY) {
    resetPreferences();
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Blocked storage: nothing was stored to begin with.
  }
}

/** The stored items, kept current when settings change here or in another tab. */
function useStoredItems(): [StoredItem[] | null, () => void] {
  const [items, setItems] = React.useState<StoredItem[] | null>(null);
  const refresh = React.useCallback(() => setItems(readItems()), []);
  React.useEffect(() => {
    const id = requestAnimationFrame(refresh);
    const off = subscribePreferences(refresh);
    window.addEventListener("storage", refresh);
    return () => {
      cancelAnimationFrame(id);
      off();
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);
  return [items, refresh];
}

export function StoredDataSection() {
  const [items, refresh] = useStoredItems();
  return (
    <SettingsSection
      id="data"
      title="Data and privacy"
      description="This site sets no cookies and runs no analytics. The few things it remembers stay in this browser, listed here."
      canReset={!!items && items.length > 0}
      onReset={() => {
        for (const item of items ?? []) removeItem(item.key);
        refresh();
      }}
      resetLabel="Clear all"
      resetMessage="Cleared"
      resetIcon={<Trash2Icon aria-hidden className="size-3.5" />}
    >
      <StoredList items={items} refresh={refresh} />
    </SettingsSection>
  );
}

function StoredList({ items, refresh }: { items: StoredItem[] | null; refresh: () => void }) {
  const flash = useFlash();
  if (items === null) return <p className="py-5 text-meta text-fg-faint">Reading this browser&rsquo;s storage&hellip;</p>;
  if (items.length === 0)
    return (
      <p className="py-5 text-meta text-fg-dim" data-testid="stored-empty">
        Nothing is stored in this browser.
      </p>
    );
  return (
    <ul className="flex flex-col" data-testid="stored-list">
      {items.map((item) => {
        const known = KNOWN[item.key];
        return (
          <li
            key={item.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 border-b border-hair py-4 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-ui text-fg">{known?.label ?? item.key}</p>
              <p className="mt-0.5 text-meta text-fg-dim">
                {known?.detail ? `${known.detail} ` : ""}
                <span className="readout text-micro text-fg-faint">
                  {item.key}, {item.bytes} bytes
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                removeItem(item.key);
                refresh();
                flash("Cleared");
              }}
              aria-label={`Clear ${known?.label ?? item.key}`}
              className="inline-flex h-9 items-center rounded-[8px] border border-hair-strong px-3 text-meta text-fg-dim transition-colors hover:border-fg-faint hover:text-fg"
            >
              Clear
            </button>
          </li>
        );
      })}
    </ul>
  );
}
