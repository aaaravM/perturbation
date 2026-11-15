"use client";
// Liquid glass: a translucent material for chrome (the top bar, a magnifier, small controls),
// after Apple's 2025 material. What it does, from back to front:
//   refraction  near the rim the backdrop is pulled outward, as through a thick rounded lens:
//               strongest at the edge, none in the flat middle. An SVG displacement filter inside
//               backdrop-filter, Chromium only (see supportsGlassRefraction); elsewhere it is left out.
//   frost       blur and saturation of the backdrop, which also picks up its colour;
//   tint        a dark layer plus a brightness cut, so light text keeps WCAG AA contrast even over
//               a pure white backdrop (see the Liquid glass section of globals.css);
//   rim         a 1px specular border, brighter at the top, and a soft inner shadow;
//   highlight   (interactive only) a light that follows the pointer across the surface and rim.
// The Glass setting picks the look: full (all of it), subtle (frost, tint and rim only) or off (a
// solid panel); prefers-reduced-transparency forces off. Styles: globals.css, "Liquid glass".
//
//   <LiquidGlass as="nav" variant="regular" interactive className="h-14 px-4">…</LiquidGlass>
//
// Each refracting surface gets its own displacement map, drawn for its exact size and corner
// radius and redrawn (throttled) when it resizes; <GlassFilters /> in the root layout hosts the
// filters. Keep refracting surfaces few: a bar, a magnifier, a card or two.

import * as React from "react";
import { useEffectiveGlass } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export type GlassVariant = "regular" | "clear" | "thin";

/**
 * Optics per variant. rim: width of the refracting band inside the edge (px). depth: the largest
 * displacement, at the very edge (px). radius: default corner radius (px).
 *   regular  bars and panels that carry text
 *   clear    lenses over imagery (a magnifier): little frost, no darkening, strong refraction
 *   thin     small controls and chips: a narrow rim and light refraction
 */
export const GLASS_OPTICS: Record<GlassVariant, { rim: number; depth: number; radius: number }> = {
  regular: { rim: 18, depth: 12, radius: 18 },
  clear: { rim: 26, depth: 14, radius: 24 },
  thin: { rim: 10, depth: 6, radius: 12 },
};

type GlassTag =
  | "div"
  | "nav"
  | "section"
  | "aside"
  | "header"
  | "footer"
  | "span"
  | "figure"
  | "article"
  | "ul"
  | "li"
  | "form";

export interface LiquidGlassProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render (default div). */
  as?: GlassTag;
  variant?: GlassVariant;
  /** Corner radius: a number is px. Default per variant (18, 24, 12). */
  radius?: number | string;
  /** A highlight follows the pointer (full glass only). */
  interactive?: boolean;
  /** Bend the backdrop at the rim (full glass in Chromium only). Default true. */
  refraction?: boolean;
  ref?: React.Ref<HTMLElement>;
}

export function LiquidGlass({
  as = "div",
  variant = "regular",
  radius,
  interactive = false,
  refraction = true,
  className,
  style,
  children,
  ref,
  ...rest
}: LiquidGlassProps) {
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const glass = useEffectiveGlass();
  const canRefract = useRefractionSupport();

  useGlassRefraction(node, refraction && glass === "full" && canRefract, variant, uid);
  usePointerHighlight(node, interactive && glass === "full");
  React.useImperativeHandle(ref, () => node as HTMLElement, [node]);

  const Tag = as as React.ElementType;
  const r = typeof radius === "number" ? `${radius}px` : radius;
  return (
    <Tag
      ref={setNode}
      data-glass-surface={variant}
      className={cn("lg", `lg-${variant}`, interactive && "lg-interactive", className)}
      style={r ? ({ "--lg-radius": r, ...style } as React.CSSProperties) : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}

// ------------------------------------------------------------------------------- filter host

const FILTER_HOST_ID = "lg-filters";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Hosts the refraction filters. Mount once, in the root layout. */
export function GlassFilters() {
  return (
    <svg
      id={FILTER_HOST_ID}
      aria-hidden
      focusable="false"
      width="0"
      height="0"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <defs />
    </svg>
  );
}

function filterDefs(): SVGDefsElement | null {
  if (typeof document === "undefined") return null;
  let host = document.getElementById(FILTER_HOST_ID) as SVGSVGElement | null;
  if (!host) {
    // Not mounted (a test page, say): make one.
    host = document.createElementNS(SVG_NS, "svg");
    host.id = FILTER_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("width", "0");
    host.setAttribute("height", "0");
    host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    document.body.appendChild(host);
  }
  let defs = host.querySelector("defs");
  if (!defs) defs = host.appendChild(document.createElementNS(SVG_NS, "defs"));
  return defs;
}

function createFilter(id: string, width: number, height: number, href: string, scale: number): SVGFilterElement {
  const f = document.createElementNS(SVG_NS, "filter");
  // Filter region: exactly the element's box. Primitives in CSS px from its top-left corner.
  f.setAttribute("id", id);
  f.setAttribute("x", "0");
  f.setAttribute("y", "0");
  f.setAttribute("width", "1");
  f.setAttribute("height", "1");
  f.setAttribute("primitiveUnits", "userSpaceOnUse");
  f.setAttribute("color-interpolation-filters", "sRGB");
  // A neutral grey under the map, so any area the map does not cover (mid-resize) stays put.
  f.innerHTML =
    `<feFlood flood-color="rgb(128,128,128)" result="neutral"/>` +
    `<feImage href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="img"/>` +
    `<feMerge result="map"><feMergeNode in="neutral"/><feMergeNode in="img"/></feMerge>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`;
  return f;
}

// ------------------------------------------------------------------------- displacement map

const mapCache = new Map<string, string>();

/**
 * Displacement map for a rounded rectangle, as a PNG data URL. Red holds the horizontal and green
 * the vertical displacement (128 = none). Inside the rim band each pixel points inward along the
 * edge normal, by t² where t runs from 0 at the inner edge of the band to 1 at the outer edge, so
 * the bend is strongest right at the rim and fades smoothly to the flat middle. Corners follow the
 * corner radius.
 */
export function displacementMap(width: number, height: number, radius: number, rim: number): string {
  const key = `${width}x${height}r${radius}b${rim}`;
  const hit = mapCache.get(key);
  if (hit) return hit;
  // Large surfaces get a half-resolution map; the gradients are smooth, so the upscale is invisible.
  const s = width * height > 160_000 ? 0.5 : 1;
  const cw = Math.max(2, Math.round(width * s));
  const ch = Math.max(2, Math.round(height * s));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(cw, ch);
  const d = img.data;
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  const band = Math.max(1, Math.min(rim, hw, hh));
  for (let j = 0; j < ch; j++) {
    const y = (j + 0.5) / s - hh;
    const ay = Math.abs(y);
    const sy = y < 0 ? -1 : 1;
    for (let i = 0; i < cw; i++) {
      const x = (i + 0.5) / s - hw;
      const ax = Math.abs(x);
      const sx = x < 0 ? -1 : 1;
      const qx = ax - (hw - r);
      const qy = ay - (hh - r);
      // Distance in from the edge, and the outward normal (in the positive quadrant).
      let dist: number;
      let nx: number;
      let ny: number;
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy) || 1;
        dist = r - l;
        nx = qx / l;
        ny = qy / l;
      } else if (qx > qy) {
        dist = r - qx;
        nx = 1;
        ny = 0;
      } else {
        dist = r - qy;
        nx = 0;
        ny = 1;
      }
      const o = (j * cw + i) * 4;
      let red = 128;
      let green = 128;
      if (dist > 0 && dist < band) {
        const t = 1 - dist / band;
        const m = t * t;
        red = Math.round(128 - 127 * m * nx * sx);
        green = Math.round(128 - 127 * m * ny * sy);
      }
      d[o] = red;
      d[o + 1] = green;
      d[o + 2] = 128;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  if (mapCache.size > 24) mapCache.delete(mapCache.keys().next().value as string);
  mapCache.set(key, url);
  return url;
}

// ------------------------------------------------------------------------- feature detection

let refractionSupport: boolean | null = null;

/**
 * Can this engine paint an SVG filter inside backdrop-filter? Today only Blink does. Gecko and
 * WebKit accept the url() syntax there but paint something else (nothing, or only the rest of the
 * chain), so they are recognised by CSS features only they have. No user-agent string is read.
 * The prefixed backdrop-filter is WebKit's on every platform (Safari, and WebKit on Linux or
 * Windows, where the Apple system fonts are missing); Blink and Gecko do not accept it.
 */
export function supportsGlassRefraction(): boolean {
  if (refractionSupport !== null) return refractionSupport;
  if (typeof window === "undefined" || typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  const gecko = CSS.supports("-moz-appearance", "none");
  const webkit = CSS.supports("font", "-apple-system-body") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
  refractionSupport = CSS.supports("backdrop-filter", "url(#lg) blur(1px)") && !gecko && !webkit;
  return refractionSupport;
}

const noopSubscribe = () => () => {};

function useRefractionSupport(): boolean {
  return React.useSyncExternalStore(noopSubscribe, supportsGlassRefraction, () => false);
}

// ---------------------------------------------------------------------------------- refraction

function useGlassRefraction(node: HTMLElement | null, enabled: boolean, variant: GlassVariant, uid: string) {
  React.useEffect(() => {
    if (!node || !enabled) return;
    const optics = GLASS_OPTICS[variant];
    let version = 0;
    let current: SVGFilterElement | null = null;
    let lastKey = "";
    let lastRun = 0;
    let raf = 0;
    let timer = 0;

    const run = () => {
      raf = 0;
      lastRun = performance.now();
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      if (w < 8 || h < 8) return;
      const r = Math.round(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0);
      const key = `${w}x${h}@${r}`;
      if (key === lastKey) return;
      lastKey = key;
      const href = displacementMap(w, h, r, optics.rim);
      const defs = filterDefs();
      if (!href || !defs) return;
      // A fresh id per map, so the browser re-resolves the reference rather than keep a stale one.
      const id = `lg-${uid}-${++version}`;
      const next = createFilter(id, w, h, href, optics.depth * 2);
      defs.appendChild(next);
      node.style.setProperty("--lg-refract", `url(#${id})`);
      node.setAttribute("data-lg-refract", "");
      const old = current;
      current = next;
      if (old) requestAnimationFrame(() => old.remove());
    };

    // At most one redraw per 120 ms while a surface is resizing, and always one after it settles.
    const schedule = () => {
      if (raf || timer) return;
      const wait = 120 - (performance.now() - lastRun);
      if (wait > 0) {
        timer = window.setTimeout(() => {
          timer = 0;
          raf = requestAnimationFrame(run);
        }, wait);
      } else {
        raf = requestAnimationFrame(run);
      }
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(node);
    node.addEventListener("transitionend", schedule);
    schedule();
    return () => {
      ro.disconnect();
      node.removeEventListener("transitionend", schedule);
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      current?.remove();
      node.style.removeProperty("--lg-refract");
      node.removeAttribute("data-lg-refract");
    };
  }, [node, enabled, variant, uid]);
}

// ------------------------------------------------------------------------- pointer highlight

function usePointerHighlight(node: HTMLElement | null, enabled: boolean) {
  React.useEffect(() => {
    if (!node || !enabled) return;
    let rect: DOMRect | null = null;
    let k = 1;
    let raf = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      raf = 0;
      node.style.setProperty("--lg-x", `${x.toFixed(1)}px`);
      node.style.setProperty("--lg-y", `${y.toFixed(1)}px`);
    };
    const measure = () => {
      rect = node.getBoundingClientRect();
      // A scaled surface (the condensed top bar): pointer offsets back into its own pixels.
      k = rect.width > 0 ? node.offsetWidth / rect.width : 1;
      return rect;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = rect ?? measure();
      x = (e.clientX - r.left) * k;
      y = (e.clientY - r.top) * k;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      measure();
      onMove(e);
      node.setAttribute("data-lg-hover", "");
    };
    const onLeave = () => {
      rect = null;
      node.removeAttribute("data-lg-hover");
    };
    // The surface may move or resize under a resting pointer (the top bar condensing): re-measure.
    const forget = () => {
      rect = null;
    };
    node.addEventListener("pointerenter", onEnter);
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", onLeave);
    node.addEventListener("transitionend", forget);
    window.addEventListener("scroll", forget, { passive: true });
    return () => {
      node.removeEventListener("pointerenter", onEnter);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", onLeave);
      node.removeEventListener("transitionend", forget);
      window.removeEventListener("scroll", forget);
      cancelAnimationFrame(raf);
      node.removeAttribute("data-lg-hover");
    };
  }, [node, enabled]);
}
