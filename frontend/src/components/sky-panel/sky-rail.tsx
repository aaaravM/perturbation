"use client";
// The Sky side rail: search any star (name, Bayer or Flamsteed designation, HIP number or
// coordinates) and the five challenge targets, then browse lists of stars as tabs: the challenge
// targets, the nearest, the brightest and the fastest-moving, each with a small figure that says
// why it is on the list. A line at the end says how many stars are loaded and from where.

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Term } from "@/components/ui/term";
import { FEATURED_TARGETS, type FeaturedTarget } from "@/lib/targets";
import {
  LY_PER_PC,
  TARGET_ALIASES,
  constellationName,
  distancePc,
  getStar,
  normaliseName,
  properMotion,
  searchStars,
  starTitle,
  type Catalogue,
  type SearchHit,
  type Star,
} from "@/lib/stars";
import type { GlobeSelection } from "@/components/globe/sky-globe";

type Tab = "targets" | "nearest" | "brightest" | "fastest";
const TABS: { id: Tab; label: string }[] = [
  { id: "targets", label: "Challenge" },
  { id: "nearest", label: "Nearest" },
  { id: "brightest", label: "Brightest" },
  { id: "fastest", label: "Fastest" },
];

type Hit = SearchHit | { kind: "target"; slug: string; label: string; detail: string };

function targetHits(q: string): Hit[] {
  const n = normaliseName(q);
  if (!n) return [];
  return FEATURED_TARGETS.filter((t) => {
    const keys = [t.name, t.slug.replace(/-/g, " "), ...(TARGET_ALIASES[t.slug] ?? [])].map(normaliseName);
    return keys.some((k) => k.startsWith(n) || k.includes(n));
  }).map((t) => ({ kind: "target" as const, slug: t.slug, label: t.name, detail: "Challenge target · SPHEREx data bundle" }));
}

const fmtLy = (ly: number) => (ly < 100 ? ly.toFixed(2) : Math.round(ly).toLocaleString("en-US"));

export function SkyRail({
  catalogue,
  selection,
  hoveredTarget,
  onSelectStar,
  onSelectTarget,
  onSelectCoords,
  onHoverStar,
  onHoverTarget,
  compact,
}: {
  catalogue: Catalogue | null;
  selection: GlobeSelection;
  hoveredTarget: string | null;
  onSelectStar: (id: number, from: HTMLElement | null) => void;
  onSelectTarget: (slug: string, from: HTMLElement | null) => void;
  onSelectCoords: (ra: number, dec: number) => void;
  onHoverStar: (id: number | null) => void;
  onHoverTarget: (slug: string | null) => void;
  compact: boolean;
}) {
  const [tab, setTab] = useState<Tab>("targets");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(!compact);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const hits: Hit[] = useMemo(() => {
    if (!query.trim()) return [];
    // A HIP number or coordinates asks for a catalogue entry first; a name, for the targets first.
    const stars = searchStars(catalogue, query, 8);
    const targets = targetHits(query);
    const exact = /^\s*(hip\s*)?\d+\s*$/i.test(query) || stars[0]?.kind === "coords";
    return (exact ? [...stars, ...targets] : [...targets, ...stars]).slice(0, 8);
  }, [query, catalogue]);

  const choose = (h: Hit, el: HTMLElement | null) => {
    if (h.kind === "star") onSelectStar(h.id, el);
    else if (h.kind === "target") onSelectTarget(h.slug, el);
    else onSelectCoords(h.ra, h.dec);
    setQuery("");
    onHoverStar(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(hits[Math.min(active, hits.length - 1)], inputRef.current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  const lists = useMemo(() => {
    const ids = (arr: number[] | undefined) =>
      (arr ?? []).map((id) => getStar(catalogue, id)).filter((s): s is Star => s !== null);
    return {
      nearest: ids(catalogue?.collections?.nearest),
      brightest: ids(catalogue?.collections?.brightest),
      fastest: ids(catalogue?.collections?.fastest),
    };
  }, [catalogue]);

  const selectedStar = selection?.kind === "star" ? selection.id : null;
  const selectedTarget = selection?.kind === "target" ? selection.slug : null;
  const showList = !compact || open;

  return (
    <nav aria-label="Find stars" className="flex min-h-0 flex-col gap-3" data-testid="sky-rail">
      {/* Search */}
      <div className="relative">
        <label htmlFor={`${listId}-q`} className="sr-only">
          Search stars by name, HIP number or coordinates
        </label>
        <div className="flex h-10 items-center gap-2 rounded-md border border-hair bg-ink/80 px-3 transition-colors focus-within:border-hair-strong">
          <SearchIcon aria-hidden className="size-4 shrink-0 text-fg-faint" />
          <input
            ref={inputRef}
            id={`${listId}-q`}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={`${listId}-results`}
            aria-activedescendant={hits.length ? `${listId}-hit-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Sirius, α Cen, HIP 87937, 101.3 −16.7"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            className="h-full min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
            data-testid="star-search"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="grid size-6 place-items-center rounded text-fg-faint hover:text-fg"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
        <AnimatePresence>
          {query.trim() ? (
            <motion.ul
              id={`${listId}-results`}
              role="listbox"
              aria-label="Search results"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-x-0 top-11 z-30 flex max-h-[min(22rem,60vh)] flex-col overflow-y-auto rounded-md border border-hair bg-[#0c0c0b] py-1 shadow-[0_18px_44px_-16px_rgb(0_0_0/0.9)]"
              data-testid="search-results"
            >
              {hits.length ? (
                hits.map((h, i) => (
                  <li
                    key={`${h.kind}:${h.kind === "star" ? h.id : h.kind === "target" ? h.slug : `${h.ra},${h.dec}`}`}
                    id={`${listId}-hit-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onPointerEnter={() => {
                      setActive(i);
                      onHoverStar(h.kind === "star" ? h.id : null);
                    }}
                    onPointerLeave={() => onHoverStar(null)}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={(e) => choose(h, e.currentTarget)}
                    className={cn(
                      "flex cursor-pointer flex-col px-3 py-2 transition-colors",
                      i === active ? "bg-white/[0.06]" : "",
                    )}
                  >
                    <span className="flex items-center gap-2 text-ui text-fg">
                      {h.kind === "target" ? <span aria-hidden className="size-[7px] rotate-45 border border-accent" /> : null}
                      {h.label}
                    </span>
                    <span className="readout text-micro text-fg-faint">{h.detail}</span>
                  </li>
                ))
              ) : (
                <li className="px-3 py-2.5 text-meta text-fg-faint">
                  {catalogue ? "No star by that name in the catalogue." : "The catalogue is still loading."}
                </li>
              )}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>

      {compact ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 items-center justify-between rounded-md px-1 text-meta text-fg-dim hover:text-fg"
        >
          Browse stars
          <ChevronDownIcon aria-hidden className={cn("size-4 transition-transform duration-300", open && "rotate-180")} />
        </button>
      ) : null}

      <AnimatePresence initial={false}>
        {showList ? (
          <motion.div
            key="lists"
            initial={compact ? { height: 0, opacity: 0 } : false}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="flex min-h-0 flex-col overflow-hidden"
          >
            <LayoutGroup id="rail-tabs">
              <div role="tablist" aria-label="Star lists" className="flex shrink-0 gap-0.5 border-b border-hair">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`${listId}-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls={`${listId}-panel`}
                    tabIndex={tab === t.id ? 0 : -1}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => {
                      // Arrow keys move between tabs (one tab stop for the whole row).
                      const i = TABS.findIndex((x) => x.id === tab);
                      const next =
                        e.key === "ArrowRight" ? (i + 1) % TABS.length
                          : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
                            : e.key === "Home" ? 0
                              : e.key === "End" ? TABS.length - 1
                                : -1;
                      if (next < 0) return;
                      e.preventDefault();
                      setTab(TABS[next].id);
                      document.getElementById(`${listId}-tab-${TABS[next].id}`)?.focus();
                    }}
                    className={cn(
                      "relative h-9 px-2.5 text-meta transition-colors",
                      tab === t.id ? "text-fg" : "text-fg-faint hover:text-fg-dim",
                    )}
                    data-testid={`rail-tab-${t.id}`}
                  >
                    {t.label}
                    {tab === t.id ? (
                      <motion.span
                        layoutId="rail-tab-line"
                        className="absolute inset-x-2 -bottom-px h-px bg-accent"
                        transition={{ type: "spring", stiffness: 520, damping: 40 }}
                      />
                    ) : null}
                  </button>
                ))}
              </div>
            </LayoutGroup>
            <div
              role="tabpanel"
              id={`${listId}-panel`}
              aria-labelledby={`${listId}-tab-${tab}`}
              className={cn(
                "min-h-0 overflow-y-auto overscroll-contain pt-1",
                compact ? "max-h-[38vh]" : "flex-1",
                "[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]",
              )}
              data-lenis-prevent
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.ul
                  key={tab}
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                  transition={{ duration: 0.18 }}
                  className="flex flex-col pb-6"
                  data-testid={tab === "targets" ? "target-list" : `rail-list-${tab}`}
                >
                  {tab === "targets"
                    ? FEATURED_TARGETS.map((t) => (
                        <TargetRow
                          key={t.slug}
                          target={t}
                          selected={selectedTarget === t.slug}
                          hovered={hoveredTarget === t.slug}
                          onSelect={(el) => onSelectTarget(t.slug, el)}
                          onHover={onHoverTarget}
                        />
                      ))
                    : (tab === "nearest" ? lists.nearest : tab === "brightest" ? lists.brightest : lists.fastest).map(
                        (s, i) => (
                          <StarRow
                            key={s.id}
                            star={s}
                            rank={i + 1}
                            kind={tab}
                            selected={selectedStar === s.id}
                            onSelect={(el) => onSelectStar(s.id, el)}
                            onHover={onHoverStar}
                          />
                        ),
                      )}
                  {tab !== "targets" && !(tab === "nearest" ? lists.nearest : tab === "brightest" ? lists.brightest : lists.fastest).length ? (
                    <li className="px-2 py-3 text-meta text-pretty text-fg-faint">
                      {catalogue?.source === "basic"
                        ? "This list needs distances and motions, which arrive with the full Hipparcos catalogue."
                        : "Loading the catalogue…"}
                    </li>
                  ) : null}
                </motion.ul>
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <p className="shrink-0 text-micro text-fg-faint" data-testid="stars-loaded">
        {catalogue ? (
          <>
            <span className="readout text-fg-dim">{catalogue.loadedCount.toLocaleString("en-US")}</span>
            {catalogue.complete ? "" : ` of ${catalogue.totalCount.toLocaleString("en-US")}`} stars from{" "}
            <Term k="hipparcos" />
            {catalogue.complete ? "" : ", loading"}
          </>
        ) : (
          "Loading the star catalogue…"
        )}
      </p>
    </nav>
  );
}

function TargetRow({
  target,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  target: FeaturedTarget;
  selected: boolean;
  hovered: boolean;
  onSelect: (el: HTMLElement) => void;
  onHover: (slug: string | null) => void;
}) {
  const stat = target.facts[0];
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={(e) => onSelect(e.currentTarget)}
        onPointerEnter={() => onHover(target.slug)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(target.slug)}
        onBlur={() => onHover(null)}
        className={cn(
          "group relative flex w-full items-start gap-3 rounded-md py-2.5 pr-2 pl-3 text-left transition-colors",
          selected || hovered ? "bg-white/[0.04]" : "hover:bg-white/[0.03]",
        )}
        data-testid={`rail-target-${target.slug}`}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-accent transition-[opacity,transform] duration-300 ease-out-expo",
            selected ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
        <span aria-hidden className="mt-[7px] size-[7px] shrink-0 rotate-45 border border-accent/80" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-ui font-medium text-fg">{target.name}</span>
            {stat ? <span className="shrink-0 text-micro text-fg-faint">{stat.value}</span> : null}
          </span>
          <span className="text-meta text-pretty text-fg-dim">{target.tagline}</span>
        </span>
      </button>
    </li>
  );
}

function StarRow({
  star,
  rank,
  kind,
  selected,
  onSelect,
  onHover,
}: {
  star: Star;
  rank: number;
  kind: Exclude<Tab, "targets">;
  selected: boolean;
  onSelect: (el: HTMLElement) => void;
  onHover: (id: number | null) => void;
}) {
  const pc = distancePc(star.plx);
  const pm = properMotion(star.pmra, star.pmdec);
  const stat =
    kind === "nearest"
      ? pc
        ? `${fmtLy(pc * LY_PER_PC)} ly`
        : ""
      : kind === "fastest"
        ? pm
          ? `${pm.total.toFixed(2)}″/yr`
          : ""
        : `V ${star.vmag.toFixed(2).replace("-", "−")}`;
  const sub =
    kind === "brightest"
      ? constellationName(star.con) ?? ""
      : [constellationName(star.con), `V ${star.vmag.toFixed(1).replace("-", "−")}`].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={(e) => onSelect(e.currentTarget)}
        onPointerEnter={() => onHover(star.id)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(star.id)}
        onBlur={() => onHover(null)}
        className={cn(
          "group relative flex w-full items-center gap-3 rounded-md py-1.5 pr-2 pl-3 text-left transition-colors",
          selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
        )}
        data-testid="rail-star"
        data-hip={star.hip ?? ""}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent transition-[opacity,transform] duration-300 ease-out-expo",
            selected ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
        <span className="readout w-5 shrink-0 text-right text-micro text-fg-faint">{rank}</span>
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full transition-transform duration-200 group-hover:scale-125"
          style={{ background: `rgb(${star.rgb.join(" ")})` }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-fg">{starTitle(star)}</span>
          {sub ? <span className="truncate text-micro text-fg-faint">{sub}</span> : null}
        </span>
        <span className="readout shrink-0 text-micro text-fg-dim">{stat}</span>
      </button>
    </li>
  );
}
