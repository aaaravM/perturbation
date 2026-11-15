"use client";

// Explains a technical word in plain language: a dotted underline and a small "?" that open a short
// explanation on hover, keyboard focus or tap. Entries live in lib/glossary.ts.
// Usage: <Term k="properMotion" /> or <Term k="parallax">parallaxes</Term>

import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";
import { cn } from "@/lib/utils";

export interface TermProps {
  k: GlossaryKey;
  children?: React.ReactNode;
  className?: string;
  /** Show the small question mark after the word (default true). */
  mark?: boolean;
}

export function Term({ k, children, className, mark = true }: TermProps) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = React.useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-term={k}
          className={cn(
            "inline cursor-help rounded-[2px] border-0 bg-transparent p-0 text-inherit [font:inherit]",
            "underline decoration-dotted decoration-1 underline-offset-[3px] [text-decoration-color:rgb(236_235_231/0.38)]",
            "transition-[text-decoration-color] duration-200 hover:[text-decoration-color:var(--accent,#f0885a)]",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent,#f0885a)]",
            className,
          )}
          onClick={(event) => {
            // Touch screens have no hover: a tap toggles the explanation.
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          {children ?? entry.term}
          {mark ? (
            <sup aria-hidden className="ml-[1px] select-none align-super text-[0.62em] font-medium opacity-55">
              ?
            </sup>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[19rem] px-3 py-2 text-left">
        <span className="block text-[13px] font-medium leading-tight">{entry.term}</span>
        <span className="mt-1 block text-[12.5px] font-normal leading-snug opacity-85">{entry.short}</span>
      </TooltipContent>
    </Tooltip>
  );
}
