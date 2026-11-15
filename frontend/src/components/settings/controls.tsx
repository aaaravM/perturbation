"use client";
// Building blocks of the Settings page: a section (heading, a quiet "Saved" line and its own
// Reset), a row (label and description beside the control, stacked on phones), a choice (a
// segmented radio group whose glass lens slides to the picked option) and a switch.

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------------------- section

const FlashContext = React.createContext<(message?: string) => void>(() => {});

/** Say "Saved" (or another short message) in the current section's status line. */
export function useFlash() {
  return React.useContext(FlashContext);
}

export function SettingsSection({
  id,
  title,
  description,
  canReset,
  onReset,
  resetLabel = "Reset",
  resetMessage = "Back to the defaults",
  resetIcon,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  /** Show a Reset button, enabled when this is true. Leave undefined for no button. */
  canReset?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  /** Said in the status line after the reset. */
  resetMessage?: string;
  /** Icon before the reset label (default: a turn-back arrow). */
  resetIcon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [message, setMessage] = React.useState<{ text: string; n: number } | null>(null);
  const timer = React.useRef(0);
  const flash = React.useCallback((text = "Saved") => {
    setMessage((m) => ({ text, n: (m?.n ?? 0) + 1 }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 2200);
  }, []);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <FlashContext.Provider value={flash}>
      <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-28 border-t border-hair pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 id={`${id}-title`} className="text-heading text-fg">
            {title}
          </h2>
          <div className="flex items-center gap-4">
            <p aria-live="polite" className="min-w-14 text-right text-meta text-fg-dim">
              <AnimatePresence mode="wait" initial={false}>
                {message && (
                  <motion.span
                    key={message.n}
                    className="inline-flex items-center gap-1.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <CheckIcon aria-hidden className="size-3.5 text-accent" />
                    {message.text}
                  </motion.span>
                )}
              </AnimatePresence>
            </p>
            {canReset !== undefined && onReset && (
              <button
                type="button"
                disabled={!canReset}
                onClick={() => {
                  onReset();
                  flash(resetMessage);
                }}
                className="-my-2 inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg disabled:pointer-events-none disabled:text-fg-faint/70"
              >
                {resetIcon ?? <RotateCcwIcon aria-hidden className="size-3.5" />}
                {resetLabel}
              </button>
            )}
          </div>
        </div>
        {description && <p className="mt-2 max-w-[60ch] text-meta text-pretty text-fg-dim">{description}</p>}
        <div className="mt-4 flex flex-col">{children}</div>
      </section>
    </FlashContext.Provider>
  );
}

// ----------------------------------------------------------------------------------- row

export function SettingRow({
  label,
  labelId,
  htmlFor,
  description,
  control,
  children,
  className,
}: {
  label: string;
  /** id for the label text, so a control can point at it with aria-labelledby. */
  labelId?: string;
  /** Use a real <label> for this control id. */
  htmlFor?: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  /** Shown under the label and control, across the full width (a preview). */
  children?: React.ReactNode;
  className?: string;
}) {
  const LabelTag = htmlFor ? "label" : "p";
  return (
    <div className={cn("border-b border-hair py-5 last:border-b-0", className)}>
      <div className="grid gap-x-10 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <LabelTag id={labelId} htmlFor={htmlFor} className="text-ui font-medium text-fg">
            {label}
          </LabelTag>
          {description && <div className="mt-1 max-w-[56ch] text-meta text-pretty text-fg-dim">{description}</div>}
        </div>
        {control && <div className="flex min-w-0 sm:justify-end">{control}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

// -------------------------------------------------------------------------------- choice

/**
 * True from the second frame after mount. Stored settings arrive just after hydration; until then
 * a control jumps to its value instead of sliding there.
 */
function useSettled() {
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    let b = 0;
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, []);
  return settled;
}

const LENS_SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Extra words for screen readers and the tooltip, e.g. "about 8,900 stars". */
  hint?: string;
}

export function Choice<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  className,
  testId,
}: {
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  labelledBy: string;
  className?: string;
  testId?: string;
}) {
  const lensId = React.useId();
  const settled = useSettled();
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onChange(v as T)}
      orientation="horizontal"
      aria-labelledby={labelledBy}
      data-testid={testId}
      className={cn("glass-segmented relative inline-flex max-w-full flex-wrap gap-0.5 p-[3px]", className)}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <RadioGroup.Item
            key={o.value}
            value={o.value}
            title={o.hint}
            className={cn(
              "relative inline-flex h-9 min-w-11 items-center justify-center rounded-[8px] px-3 text-meta font-medium whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/70",
              checked ? "text-fg" : "text-(--fg-glass-dim) hover:text-fg",
            )}
          >
            {checked && (
              <motion.span
                aria-hidden
                layoutId={lensId}
                className="glass-lens absolute inset-0"
                transition={settled ? LENS_SPRING : { duration: 0 }}
              />
            )}
            <span className="relative">{o.label}</span>
            {o.hint && <span className="sr-only">, {o.hint}</span>}
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}

// -------------------------------------------------------------------------------- toggle

export function Toggle({
  id,
  checked,
  onChange,
  testId,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />;
}
