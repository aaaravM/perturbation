"use client";
// Fallback for browsers without WebGL: the same SPHEREx map, flat (plate carree, RA increasing
// to the right as on the globe), with the five markers and click-to-inspect. If the map image is
// not available either, a plain graticule stands in, and says so.

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { GlobeMarker, GlobeSelection } from "@/components/globe/sky-globe";
import { SKY_TEXTURE_2K } from "@/components/globe/sky-assets";

interface FlatSkyMapProps {
  markers: GlobeMarker[];
  selection: GlobeSelection;
  hovered: string | null;
  onHoverChange: (slug: string | null) => void;
  onSelectTarget: (slug: string) => void;
  onSelectPatch: (ra: number, dec: number) => void;
  className?: string;
}

const pos = (ra: number, dec: number) => ({
  left: `${(((ra % 360) + 360) % 360) / 3.6}%`,
  top: `${((90 - dec) / 180) * 100}%`,
});

export function FlatSkyMap({
  markers,
  selection,
  hovered,
  onHoverChange,
  onSelectTarget,
  onSelectPatch,
  className,
}: FlatSkyMapProps) {
  const [imageOk, setImageOk] = useState(true);
  const selectedSlug = selection?.kind === "target" ? selection.slug : null;

  return (
    <figure className={cn("flex w-full flex-col gap-2", className)} data-testid="sky-flat-map">
      <div
        className="relative aspect-[2/1] w-full cursor-crosshair overflow-hidden rounded-md border border-hair bg-[#0a0a0a]"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-marker]")) return;
          const r = e.currentTarget.getBoundingClientRect();
          const ra = ((e.clientX - r.left) / r.width) * 360;
          const dec = 90 - ((e.clientY - r.top) / r.height) * 180;
          onSelectPatch(ra, dec);
        }}
      >
        {imageOk ? (
          // A plain image on purpose: this path exists for browsers that cannot run the globe.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={SKY_TEXTURE_2K}
            alt=""
            className="absolute inset-0 size-full object-cover"
            onError={() => setImageOk(false)}
          />
        ) : null}
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          viewBox="0 0 360 180"
          preserveAspectRatio="none"
        >
          {[30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((x) => (
            <line
              key={`m${x}`}
              x1={x}
              x2={x}
              y1={0}
              y2={180}
              stroke="white"
              strokeOpacity={0.08}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {[30, 60, 90, 120, 150].map((y) => (
            <line
              key={`p${y}`}
              x1={0}
              x2={360}
              y1={y}
              y2={y}
              stroke="white"
              strokeOpacity={y === 90 ? 0.18 : 0.08}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {markers.map((m) => {
          const active = selectedSlug === m.slug || hovered === m.slug;
          return (
            <button
              key={m.slug}
              type="button"
              data-marker={m.slug}
              tabIndex={-1}
              aria-hidden
              onClick={() => onSelectTarget(m.slug)}
              onPointerEnter={() => onHoverChange(m.slug)}
              onPointerLeave={() => onHoverChange(null)}
              className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center"
              style={pos(m.ra, m.dec)}
            >
              <span
                className={cn(
                  "block size-[9px] rounded-full border shadow-[0_0_0_1px_rgb(0_0_0/0.6)]",
                  active ? "border-accent" : "border-fg/80",
                )}
              />
              <span
                className={cn(
                  "pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 rounded-[3px] bg-[#030303]/82 px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-fg transition-opacity",
                  active ? "opacity-100" : "opacity-0",
                )}
              >
                {m.name}
              </span>
            </button>
          );
        })}
        {selection?.kind === "spot" && (
          <span
            aria-hidden
            className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent"
            style={pos(selection.ra, selection.dec)}
          />
        )}
      </div>
      <figcaption className="text-meta text-pretty text-fg-dim">
        {imageOk
          ? "Your browser cannot show the 3D globe, so here is the same SPHEREx map laid flat. Right ascension runs left to right, north is up."
          : "Your browser cannot show the 3D globe, and the flat SPHEREx map is not available yet. The grid shows right ascension and declination every 30°."}
      </figcaption>
    </figure>
  );
}
