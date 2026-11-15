"use client";
// Slim top navigation. Inline links from md up; a sheet menu on phones. The active link is
// brighter with a thin underline that slides between links (Motion layoutId). In the two app
// modes (/sky and /explore) a compact Sky | Lab switch sits next to the wordmark, on phones too,
// and takes the place of those two links in the inline list.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MenuIcon } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { MODE_LINKS, NAV_LINKS } from "@/lib/site";
import { Button } from "@/components/ui/button";
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

function ModeSwitch({ pathname, reduceMotion }: { pathname: string; reduceMotion: boolean | null }) {
  return (
    <div role="group" aria-label="Mode" className="inline-flex rounded-md border border-hair p-0.5" data-testid="mode-switch">
      {MODE_LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex h-7 items-center rounded-[4px] px-2.5 text-micro font-medium transition-colors duration-200",
              active ? "text-fg" : "text-fg-dim hover:text-fg",
            )}
          >
            {active && (
              <motion.span
                aria-hidden
                layoutId="mode-switch-active"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
                className="absolute inset-0 rounded-[4px] bg-white/[0.08]"
              />
            )}
            <span className="relative">{link.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const reduceMotion = useReducedMotion();
  const inMode = isModeRoute(pathname);
  const inlineLinks = inMode ? NAV_LINKS.filter((l) => !MODE_LINKS.some((m) => m.href === l.href)) : NAV_LINKS;

  return (
    <header className="sticky top-0 z-50 h-(--nav-h) border-b border-hair bg-ink/92">
      <nav
        aria-label="Main"
        className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/"
            className="-mx-1 shrink-0 rounded-sm px-1 text-ui font-medium tracking-[-0.01em] text-fg transition-colors duration-200 hover:text-fg-dim"
          >
            Planet X Hunter
          </Link>
          {inMode && (
            <>
              <span aria-hidden className="hidden h-4 w-px bg-hair-strong sm:block" />
              <ModeSwitch pathname={pathname} reduceMotion={reduceMotion} />
            </>
          )}
        </div>

        <LayoutGroup id="site-nav">
          <ul className="hidden h-full items-stretch gap-6 md:flex">
            {inlineLinks.map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <li key={link.href} className="relative flex items-center">
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-sm text-ui text-fg-dim transition-colors duration-200 hover:text-fg",
                      active && "text-fg",
                    )}
                  >
                    {link.label}
                  </Link>
                  {active && (
                    <motion.span
                      aria-hidden
                      layoutId="nav-underline"
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 520, damping: 42, mass: 0.7 }
                      }
                      className="absolute inset-x-0 -bottom-px h-px bg-fg"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </LayoutGroup>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="-mr-2 md:hidden" aria-label="Open menu">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72 border-hair bg-ink-2">
            <SheetHeader>
              <SheetTitle className="text-ui font-medium text-fg">Planet X Hunter</SheetTitle>
              <SheetDescription className="sr-only">Site navigation</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col px-4">
              {NAV_LINKS.map((link) => {
                const active = isActive(pathname, link.href);
                return (
                  <li key={link.href}>
                    <SheetClose asChild>
                      <Link
                        href={link.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center justify-between border-b border-hair py-3.5 text-body text-fg-dim transition-colors hover:text-fg",
                          active && "text-fg",
                        )}
                      >
                        <span className={cn(active && "underline decoration-1 underline-offset-[6px]")}>
                          {link.label}
                        </span>
                      </Link>
                    </SheetClose>
                  </li>
                );
              })}
            </ul>
          </SheetContent>
        </Sheet>
      </nav>
    </header>
  );
}
