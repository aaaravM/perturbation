"use client";
// Ctrl/Cmd+K command palette (go to a target or coordinates, switch mode or detector, toggle
// layers, tools, panes, exports) and the keyboard-shortcuts sheet ("?").

import { useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { parseCoordinates } from "@/lib/lab-coords";
import { cn } from "@/lib/utils";

export interface PaletteAction {
  id: string;
  group: "Go to" | "Blink" | "Detector" | "Layers" | "Tools" | "View" | "Layout" | "Export";
  label: string;
  hint?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  onCoordinates,
  onSearch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: PaletteAction[];
  onCoordinates: (ra: number, dec: number) => void;
  /** Free text that is not a command: resolved as a name. */
  onSearch: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const coords = parseCoordinates(query);
  const groups = [...new Set(actions.map((a) => a.group))];
  const run = (fn: () => void) => {
    onOpenChange(false);
    setQuery("");
    window.setTimeout(fn, 0);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 overflow-hidden border border-hair-strong bg-popover p-0 sm:max-w-lg" data-testid="command-palette">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Type a command, a target name or coordinates.</DialogDescription>
        <CommandPrimitive label="Commands" className="flex flex-col" loop>
          <div className="flex items-center gap-2 border-b border-hair px-3">
            <SearchIcon className="size-4 shrink-0 text-fg-faint" aria-hidden />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Go to a target or RA Dec, switch mode, toggle layers…"
              className="h-11 w-full bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
              data-testid="command-input"
            />
          </div>
          <CommandPrimitive.List className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
            <CommandPrimitive.Empty className="px-3 py-6 text-center text-meta text-fg-dim">
              {query.trim() ? (
                <button type="button" className="underline decoration-hair-strong underline-offset-4 hover:text-fg" onClick={() => run(() => onSearch(query.trim()))}>
                  Look up “{query.trim()}”
                </button>
              ) : (
                "No commands."
              )}
            </CommandPrimitive.Empty>
            {coords && (
              <CommandPrimitive.Group heading="Coordinates" className={GROUP}>
                <Item value={`coordinates ${query}`} onSelect={() => run(() => onCoordinates(coords.ra, coords.dec))}>
                  Go to <span className="readout">{coords.ra.toFixed(5)} {coords.dec >= 0 ? "+" : ""}{coords.dec.toFixed(5)}</span>
                </Item>
              </CommandPrimitive.Group>
            )}
            {groups.map((g) => (
              <CommandPrimitive.Group key={g} heading={g} className={GROUP}>
                {actions
                  .filter((a) => a.group === g)
                  .map((a) => (
                    <Item key={a.id} value={`${g} ${a.label} ${a.hint ?? ""}`} disabled={a.disabled} onSelect={() => run(a.run)} shortcut={a.shortcut}>
                      {a.label}
                      {a.hint && <span className="ml-2 text-fg-faint">{a.hint}</span>}
                    </Item>
                  ))}
              </CommandPrimitive.Group>
            ))}
            {query.trim() && !coords && (
              <CommandPrimitive.Group heading="Search" className={GROUP}>
                <Item value={`search ${query}`} onSelect={() => run(() => onSearch(query.trim()))}>
                  Look up “{query.trim()}” in SIMBAD
                </Item>
              </CommandPrimitive.Group>
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

const GROUP = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-fg-faint";

function Item({
  children,
  value,
  onSelect,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  value: string;
  onSelect: () => void;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-3 rounded-[5px] px-2 py-1.5 text-meta text-fg-dim",
        "data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-fg data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </CommandPrimitive.Item>
  );
}

export const SHORTCUTS: { keys: string[]; label: string; group: string }[] = [
  { keys: ["Ctrl", "K"], label: "Command palette", group: "General" },
  { keys: ["?"], label: "This list", group: "General" },
  { keys: ["Esc"], label: "Cancel the tool, then clear the selection", group: "General" },
  { keys: ["Space"], label: "Play or pause the blink", group: "Blink" },
  { keys: ["←", "→"], label: "Previous or next frame", group: "Blink" },
  { keys: ["[", "]"], label: "Slower or faster", group: "Blink" },
  { keys: ["C"], label: "Hard blink or crossfade", group: "Blink" },
  { keys: ["W"], label: "Wipe compare on or off", group: "Blink" },
  { keys: ["E"], label: "Epochs", group: "Blink" },
  { keys: ["T"], label: "Then vs Now", group: "Blink" },
  { keys: ["D"], label: "Difference", group: "Blink" },
  { keys: ["1", "6"], label: "Detector D1 to D6", group: "Blink" },
  { keys: ["V"], label: "Inspect tool", group: "Tools" },
  { keys: ["R"], label: "Ruler", group: "Tools" },
  { keys: ["A"], label: "Aperture", group: "Tools" },
  { keys: ["G"], label: "RA/Dec grid", group: "View" },
  { keys: ["X"], label: "Crosshair", group: "View" },
  { keys: ["F"], label: "Zoom to the field", group: "View" },
  { keys: ["+", "−"], label: "Zoom in or out (sky focused)", group: "View" },
  // VS Code's keys; Cmd on a Mac works as Ctrl, as for the palette.
  { keys: ["Ctrl", "B"], label: "Show or hide the data pane", group: "Layout" },
  { keys: ["Ctrl", "J"], label: "Show or hide the blink player", group: "Layout" },
  { keys: ["Ctrl", "Alt", "B"], label: "Show or hide the analysis pane", group: "Layout" },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
  layout = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** List the keys that show and hide the panes, which only the wide layout has. */
  layout?: boolean;
}) {
  const shortcuts = layout ? SHORTCUTS : SHORTCUTS.filter((s) => s.group !== "Layout");
  const groups = [...new Set(shortcuts.map((s) => s.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-hair-strong bg-popover sm:max-w-xl" data-testid="shortcuts-dialog">
        <DialogTitle className="text-ui font-medium text-fg">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="text-micro text-fg-dim">Keys work when no text field has focus.</DialogDescription>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g} className="flex flex-col gap-1.5">
              <h3 className="text-micro text-fg-faint">{g}</h3>
              <ul className="flex flex-col gap-1">
                {shortcuts.filter((s) => s.group === g).map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-3 text-meta text-fg-dim">
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
      </DialogContent>
    </Dialog>
  );
}
