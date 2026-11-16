"use client";
// Top navigation: a Liquid Glass bar (components/ui/liquid-glass.tsx).
// - Content pages (home, Planet X, AI, How it works, About, Settings): the bar
//   floats over the page, inset from the edges, and condenses a little once the page scrolls.
// - Sky and Lab (/sky, /explore): it docks to the top edge at exactly --nav-h, as before, so the
//   tools' layouts do not move.
// Geometry and transitions live in globals.css ("Top navigation"). The Sky | Lab switch comes
// first on every page: a glass segmented control whose lens slides on a spring and slightly
// magnifies the label under it. Page links from md up, a sheet menu on phones, a gear for Settings.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MenuIcon, SettingsIcon } from "lucide-react";
import { LayoutGroup, motion, useSpring, useTransform, useVelocity, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";
import { MODE_LINKS, NAV_LINKS, PAGE_LINKS, SETTINGS_LINK } from "@/lib/site";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/site/logo-mark";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

const isModeRoute = (pathname: string) => MODE_LINKS.some((m) => isActive(pathname, m.href));

// ------------------------------------------------------------------------------ scroll state

const SCROLL_THRESHOLD = 12;

function subscribeScroll(cb: () => void) {
  window.addEventListener("scroll", cb, { passive: true });
  return () => window.removeEventListener("scroll", cb);
}

/** True once the page has scrolled a little. Re-renders only when that flips. */
function useScrolled() {
  return useSyncExternalStore(
    subscribeScroll,
    () => window.scrollY > SCROLL_THRESHOLD,
    () => false,
  );
}

// ---------------------------------------------------------------------------- Sky | Lab switch

const LENS_SPRING = { stiffness: 460, damping: 36, mass: 0.75 };
const PRESENCE_SPRING = { stiffness: 380, damping: 34 };
/** How much the lens magnifies the label right under it. */
const LENS_MAGNIFY = 0.08;

function ModeSwitch({ pathname, reduce }: { pathname: string; reduce: boolean }) {
  const active = MODE_LINKS.findIndex((m) => isActive(pathname, m.href));
  // On the other pages no mode is current: the lens shows under the hovered or focused mode only.
  const [pointed, setPointed] = useState<number | null>(null);
  const target = active >= 0 ? active : (pointed ?? 0);
  const shown = active >= 0 || pointed !== null;

  const pos = useSpring(target, LENS_SPRING);
  const presence = useSpring(shown ? 1 : 0, PRESENCE_SPRING);
  useEffect(() => {
    // Appearing lenses start where they are needed; moving ones slide.
    if (reduce || presence.get() < 0.05) pos.jump(target);
    else pos.set(target);
  }, [pos, presence, target, reduce]);
  useEffect(() => {
    if (reduce) presence.jump(shown ? 1 : 0);
    else presence.set(shown ? 1 : 0);
  }, [presence, shown, reduce]);

  // The lens stretches a little along its path while it moves, like a drop of liquid.
  const velocity = useVelocity(pos);
  const stretch = useTransform(velocity, (v) => 1 + Math.min(Math.abs(v) * 0.05, 0.24));
  const x = useTransform(pos, (p) => `${p * 100}%`);

  return (
    <div
      role="group"
      aria-label="Mode"
      data-testid="mode-switch"
      className="glass-segmented relative grid shrink-0 grid-cols-2 p-[3px]"
      onPointerLeave={() => setPointed(null)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPointed(null);
      }}
    >
      <motion.span
        aria-hidden
        className="glass-lens pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] w-[calc(50%-3px)]"
        style={{ x, scaleX: stretch, opacity: presence }}
      />
      {MODE_LINKS.map((link, i) => (
        <ModeLink
          key={link.href}
          href={link.href}
          label={link.label}
          index={i}
          active={i === active}
          pos={pos}
          presence={presence}
          onPoint={() => setPointed(i)}
        />
      ))}
    </div>
  );
}

function ModeLink({
  href,
  label,
  index,
  active,
  pos,
  presence,
  onPoint,
}: {
  href: string;
  label: string;
  index: number;
  active: boolean;
  pos: MotionValue<number>;
  presence: MotionValue<number>;
  onPoint: () => void;
}) {
  // Magnified by how much of the lens sits over this label right now.
  const scale = useTransform([pos, presence], ([p, o]: number[]) => 1 + LENS_MAGNIFY * o * Math.max(0, 1 - Math.abs(p - index)));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      onPointerEnter={onPoint}
      onFocus={onPoint}
      className={cn(
        // 32px to the eye; on touch screens the hit area reaches 44px above and below.
        "relative inline-flex h-8 min-w-12 items-center justify-center rounded-[8px] px-3 text-meta font-medium transition-colors duration-200 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5",
        active ? "text-fg" : "text-(--fg-glass-dim) hover:text-fg",
      )}
    >
      <motion.span className="block will-change-transform" style={{ scale }}>
        {label}
      </motion.span>
    </Link>
  );
}

// ------------------------------------------------------------------------------------ the bar

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const reduce = useEffectiveReducedMotion();
  const scrolled = useScrolled();
  const docked = isModeRoute(pathname);
  const settingsActive = isActive(pathname, SETTINGS_LINK.href);

  return (
    <header
      data-layout={docked ? "docked" : "floating"}
      data-scrolled={!docked && scrolled ? "" : undefined}
      className="site-nav sticky top-0 z-50 h-(--nav-h)"
    >
      <LiquidGlass as="nav" aria-label="Main" variant="regular" interactive refraction={!docked} className="site-nav__bar">
        <div
          className={cn(
            "mx-auto flex h-full max-w-7xl items-center justify-between gap-3",
            docked ? "px-4 sm:px-6" : "px-3 sm:px-5",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-4">
            <Link
              href="/"
              className="-mx-1 inline-flex h-11 min-w-0 shrink items-center gap-2 truncate rounded-sm px-1 text-ui font-medium tracking-[-0.01em] text-fg transition-colors duration-200 hover:text-fg-dim md:pointer-fine:h-8"
            >
              <LogoMark />
              Perturbation
            </Link>
            <span aria-hidden className="hidden h-4 w-px bg-hair-strong sm:block" />
            <ModeSwitch pathname={pathname} reduce={reduce} />
          </div>

          <div className="flex h-full items-center gap-0.5 md:gap-1">
            <LayoutGroup id="site-nav">
              <ul className="hidden items-center gap-5 md:flex lg:gap-6">
                {PAGE_LINKS.map((link) => {
                  const active = isActive(pathname, link.href);
                  return (
                    <li key={link.href} className="flex items-center">
                      <Link
                        href={link.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative inline-flex h-8 items-center rounded-sm text-ui transition-colors duration-200 hover:text-fg",
                          active ? "text-fg" : "text-(--fg-glass-dim)",
                        )}
                      >
                        {link.label}
                        {active && (
                          <motion.span
                            aria-hidden
                            layoutId="nav-underline"
                            transition={
                              reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42, mass: 0.7 }
                            }
                            className="absolute inset-x-0 bottom-0.5 h-px bg-fg"
                          />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </LayoutGroup>
            <span aria-hidden className="mx-3 hidden h-4 w-px bg-hair-strong md:block lg:mx-4" />
            <Link
              href={SETTINGS_LINK.href}
              aria-label="Settings"
              title="Settings"
              aria-current={settingsActive ? "page" : undefined}
              className={cn(
                "group/gear inline-flex size-11 items-center justify-center rounded-[10px] transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg max-[359px]:hidden md:pointer-fine:size-8",
                settingsActive ? "bg-white/[0.08] text-fg" : "text-(--fg-glass-dim)",
              )}
            >
              <SettingsIcon
                aria-hidden
                className="size-[18px] transition-transform duration-500 ease-out-expo group-hover/gear:rotate-45 reduced:transition-none"
              />
            </Link>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="-mr-1.5 size-11 rounded-[10px] md:hidden" aria-label="Open menu">
                  <MenuIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 border-hair bg-ink-2">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2 text-ui font-medium text-fg">
                    <LogoMark />
                    Perturbation
                  </SheetTitle>
                  <SheetDescription className="sr-only">Site navigation</SheetDescription>
                </SheetHeader>
                <ul className="flex flex-col px-4">
                  {[...NAV_LINKS, SETTINGS_LINK].map((link) => {
                    const active = isActive(pathname, link.href);
                    return (
                      <li key={link.href}>
                        <SheetClose asChild>
                          <Link
                            href={link.href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex min-h-11 items-center justify-between border-b border-hair py-3 text-body text-fg-dim transition-colors hover:text-fg",
                              active && "text-fg",
                            )}
                          >
                            <span className={cn(active && "underline decoration-1 underline-offset-[6px]")}>
                              {link.label}
                            </span>
                            {link.href === SETTINGS_LINK.href && <SettingsIcon aria-hidden className="size-4 text-fg-faint" />}
                          </Link>
                        </SheetClose>
                      </li>
                    );
                  })}
                </ul>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </LiquidGlass>
    </header>
  );
}
