import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { BlinkComparator } from "@/components/landing/blink-comparator";
import { Reveal } from "@/components/landing/reveal";
import { Button } from "@/components/ui/button";

/** The Lab opens Barnard's Star's prepared frames and centres the field on where it is now. */
const BARNARD_HREF = "/explore?target=barnards-star";

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-title">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-x-16 gap-y-12 px-4 pt-10 pb-14 sm:px-6 sm:pt-16 sm:pb-20 lg:min-h-[calc(100svh-var(--nav-h))] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:py-12">
          <div className="flex flex-col items-start">
            <Reveal>
              <p className="text-meta text-fg-dim">NASA Space Apps 2026 · Planet X and SPHEREx</p>
            </Reveal>
            <Reveal delay={0.06}>
              <h1 id="hero-title" className="mt-5 text-display text-balance text-fg">
                Watch the sky move.
              </h1>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="measure mt-6 text-lead text-pretty text-fg-dim">
                SPHEREx maps the whole sky every six months in 102 colours of infrared light.
                Planet X Hunter lets anyone flip between those maps to catch stars, brown dwarfs
                and asteroids in motion.
              </p>
            </Reveal>
            <Reveal delay={0.18}>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="h-11 gap-2 rounded-md px-5">
                  <Link href={BARNARD_HREF}>
                    Try Barnard&rsquo;s Star
                    <ArrowRightIcon aria-hidden />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="ghost"
                  className="h-11 rounded-md border-hair-strong px-5 text-fg-dim hover:text-fg"
                >
                  <Link href="/sky">Explore the sky globe</Link>
                </Button>
                <Link
                  href="/how-it-works"
                  className="rounded-sm px-1 text-ui text-fg-dim underline decoration-hair-strong underline-offset-4 transition-colors duration-200 hover:text-fg hover:decoration-fg-dim"
                >
                  How it works
                </Link>
              </div>
            </Reveal>
            <Reveal delay={0.24}>
              <p className="measure mt-8 text-meta text-fg-faint">
                Barnard&rsquo;s Star crosses 10.4 arcseconds of sky a year, faster than any other
                star.
              </p>
            </Reveal>
          </div>

          <Reveal delay={0.1} y={0}>
            <BlinkComparator />
          </Reveal>
        </div>
      </section>

      <section aria-label="More of this page" className="border-t border-hair">
        <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
          <p className="text-meta text-fg-faint">Placeholder. Built in Phase 9.</p>
        </div>
      </section>
    </>
  );
}
