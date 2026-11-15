"use client";
// The Sky-mode information panel. On tablets and desktops it slides in on the right; on phones
// it rises as a bottom sheet that can be dragged down to close. It is non-modal (the globe stays
// usable beside it), closes on Escape, and reports its size so the globe can centre itself in
// the space that is left. The parent moves focus to the heading on open and back on close.

import { useEffect, useRef, type ReactNode } from "react";
import { motion, useDragControls } from "motion/react";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export function SkyPanel({
  layout,
  labelledBy,
  eyebrow,
  contentKey,
  onClose,
  onSize,
  reducedMotion,
  children,
}: {
  layout: "side" | "sheet";
  labelledBy: string;
  /** Short context line in the panel’s top bar, e.g. "Brown dwarf". */
  eyebrow: string;
  /** Changes when the panel shows something else: scroll resets and the content fades in. */
  contentKey: string;
  onClose: () => void;
  onSize: (size: { width: number; height: number }) => void;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const dragControls = useDragControls();
  const onCloseRef = useRef(onClose);
  const onSizeRef = useRef(onSize);
  useEffect(() => {
    onCloseRef.current = onClose;
    onSizeRef.current = onSize;
  }, [onClose, onSize]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      onSizeRef.current({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onSizeRef.current({ width: 0, height: 0 });
    };
  }, [layout]);

  const side = layout === "side";
  const motionProps = reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.15 },
      }
    : side
      ? {
          initial: { opacity: 0, x: 28 },
          animate: { opacity: 1, x: 0, transition: { duration: 0.55, ease: EASE_OUT_EXPO } },
          exit: { opacity: 0, x: 20, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as const } },
        }
      : {
          initial: { y: "100%" },
          // A deep link opens the panel before the layout is known, with the side panel's start
          // (faded, shifted right); the sheet clears that as well as rising.
          animate: { y: 0, opacity: 1, x: 0, transition: { duration: 0.5, ease: EASE_OUT_EXPO } },
          exit: { y: "100%", transition: { duration: 0.28, ease: [0.4, 0, 1, 1] as const } },
        };

  return (
    <motion.aside
      ref={ref}
      role="dialog"
      aria-modal={false}
      aria-labelledby={labelledBy}
      data-testid="sky-panel"
      data-layout={layout}
      {...motionProps}
      drag={side || reducedMotion ? false : "y"}
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.65 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 110 || info.velocity.y > 520) onClose();
      }}
      className={cn(
        "absolute z-20 flex flex-col text-fg",
        side
          ? "panel top-4 right-4 bottom-4 w-[min(408px,calc(100%-2rem))] shadow-[0_24px_60px_-20px_rgb(0_0_0/0.8)]"
          : "inset-x-0 bottom-0 max-h-[64%] rounded-t-xl border-t border-hair-strong bg-ink-2 shadow-[0_-20px_50px_-20px_rgb(0_0_0/0.9)]",
      )}
    >
      {!side && (
        <div
          aria-hidden
          onPointerDown={(e) => dragControls.start(e)}
          className="flex h-6 shrink-0 cursor-grab touch-none items-end justify-center active:cursor-grabbing"
        >
          <span className="h-1 w-9 rounded-full bg-white/20" />
        </div>
      )}
      <div className={cn("flex shrink-0 items-center justify-between gap-3", side ? "pt-3 pr-3 pl-5" : "pr-2.5 pl-4")}>
        <motion.p
          key={contentKey}
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="truncate text-meta text-fg-dim"
        >
          {eyebrow}
        </motion.p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="grid size-8 shrink-0 place-items-center rounded-md text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      </div>
      <motion.div
        key={contentKey}
        data-lenis-prevent
        initial={reducedMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: EASE_OUT_EXPO }}
        className={cn(
          // Soft edges top and bottom: content that runs on below the fold fades out instead of
          // being cut, which says "scroll for more". The bottom padding clears the fade at the end.
          "min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_14px,black_calc(100%_-_36px),transparent)]",
          side ? "px-5 pt-2 pb-10" : "px-4 pt-1 pb-11",
        )}
      >
        {children}
      </motion.div>
    </motion.aside>
  );
}
