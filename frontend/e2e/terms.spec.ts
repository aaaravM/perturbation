// Explained words (<Term>, components/ui/term.tsx) on every page. Each word takes the pointer
// itself (nothing lies over it); hovering opens its explanation inside the window and above
// everything else; keyboard focus opens it and Escape closes it without closing what is behind it;
// a click never reaches the row or panel the word sits in; on a phone a tap opens it and a second
// tap, or a tap elsewhere, closes it. Each page also keeps to a small budget of explained words
// (the rule is at the top of lib/glossary.ts). Pages without words are skipped.
// Against another server, such as the published site: E2E_BASE_URL=https://... pnpm exec playwright test terms
// Design-review screenshots are opt-in: UI_REVIEW_DIR=/some/dir.
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { hideDevOverlay } from "./helpers";

interface PageCase {
  path: string;
  /** At most this many explained words on the page as it first appears. */
  budget: number;
  ready?: (page: Page) => Promise<void>;
  /** What must still be on screen after Escape and after a click on a word. */
  keep?: (page: Page) => Locator;
}

const starHeading = (page: Page) => page.getByTestId("sky-panel").getByRole("heading", { level: 2 });

async function skyReady(page: Page) {
  await expect(page.getByTestId("sky-globe").locator("canvas")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1500);
}

async function starReady(page: Page) {
  await skyReady(page);
  await expect(starHeading(page)).toHaveText("Sirius", { timeout: 45_000 });
  await page.waitForTimeout(2500); // the panel has slid in and the live sections have arrived
}

async function labReady(page: Page) {
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  // Pause the blink, so the page holds still under the pointer.
  const play = page.getByTestId("blink-play");
  if ((await play.getAttribute("data-playing")) === "true") await play.click();
  await page.waitForTimeout(600);
}

const PAGES: PageCase[] = [
  { path: "/", budget: 4 },
  { path: "/sky", budget: 3, ready: skyReady },
  { path: "/sky?star=32349", budget: 9, ready: starReady, keep: starHeading },
  { path: "/explore?target=barnards-star", budget: 10, ready: labReady, keep: (page) => page.getByTestId("blink-player") },
  { path: "/discoveries", budget: 4 },
  { path: "/help", budget: 4 },
  { path: "/how-it-works", budget: 6 },
  { path: "/about", budget: 6 },
  { path: "/settings", budget: 2 },
];

async function open(page: Page, c: PageCase) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pxh-lab-hint-seen", "1");
    } catch {
      // Storage blocked: the hint may show; it does not cover the words tested here.
    }
  });
  await page.goto(c.path);
  if (c.ready) await c.ready(page);
  else await page.waitForTimeout(1200);
  await hideDevOverlay(page);
}

interface Word {
  id: string;
  k: string;
  text: string;
}

/** The explained words the page renders now, each tagged so it can be found again. */
async function words(page: Page): Promise<Word[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-term]")].flatMap((el, i) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") return [];
      el.dataset.e2eWord = String(i);
      return [{ id: String(i), k: el.dataset.term ?? "", text: (el.textContent ?? "").replace("?", "").trim() }];
    }),
  );
}

const wordAt = (page: Page, w: Word) => page.locator(`[data-e2e-word="${w.id}"]`);
const openTip = (page: Page, k: string) => page.locator(`[data-term-tip="${k}"]:not([data-state=closed])`);
const anyTip = (page: Page) => page.locator("[data-term-tip]");

/** Scrolls the word into view and reports its centre, and whether the word itself is there. */
async function aim(page: Page, term: Locator) {
  await term.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }));
  await page.waitForTimeout(350); // anything revealed by the scroll has settled
  return term.evaluate((el) => {
    const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let seen = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    for (let a = el.parentElement; a && seen; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) seen = false;
    }
    const hit = document.elementFromPoint(x, y);
    const on = hit ? `${hit.tagName.toLowerCase()}.${(hit.getAttribute("class") ?? "").split(" ")[0]}` : "nothing";
    return { x, y, seen, hit: !!hit && el.contains(hit), on };
  });
}

/** A point on plain page, away from every word and explanation. */
async function away(page: Page) {
  return page.evaluate(() => {
    const spots = [
      [innerWidth - 6, innerHeight / 2],
      [innerWidth / 2, innerHeight - 6],
      [6, innerHeight / 2],
      [innerWidth / 2, 80],
    ];
    for (const [x, y] of spots) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest("[data-term],[data-term-tip],button,a,input")) return { x, y };
    }
    return { x: spots[0][0], y: spots[0][1] };
  });
}

/** The explanation is on top where it shows: nothing else covers its middle. */
const onTop = (tip: Locator) =>
  tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });

async function shot(page: Page, name: string) {
  const dir = process.env.UI_REVIEW_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

const slug = (p: string) => p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";

for (const c of PAGES) {
  test(`explained words on ${c.path}`, async ({ page }) => {
    await open(page, c);
    const list = await words(page);
    console.log(`${c.path}: ${list.length} explained words (${list.map((w) => w.k).join(", ")})`);
    expect(list.length, `explained words on ${c.path}`).toBeLessThanOrEqual(c.budget);
    test.skip(list.length === 0, "no explained words on this page");

    const url = page.url();
    for (const [i, w] of list.entries()) {
      const term = wordAt(page, w);
      const p = await aim(page, term);
      expect(p.seen, `"${w.text}" (${w.k}) can be scrolled into view`).toBe(true);
      expect(p.hit, `"${w.text}" (${w.k}) lies under ${p.on}`).toBe(true);
      await page.mouse.move(p.x, p.y);
      const tip = openTip(page, w.k);
      await expect(tip, `hovering "${w.text}" opens its explanation`).toBeVisible();
      await expect(tip, `the explanation of "${w.text}" is inside the window`).toBeInViewport({ ratio: 1 });
      expect(await onTop(tip), `nothing covers the explanation of "${w.text}"`).toBe(true);
      if (i === 0) await shot(page, `terms-${slug(c.path)}-hover`);
      const rest = await away(page);
      await page.mouse.move(rest.x, rest.y);
      await expect(anyTip(page), `the explanation of "${w.text}" closes when the pointer leaves`).toHaveCount(0);
    }

    // Keyboard: focus opens it, Escape closes only the explanation, Enter opens it again.
    const first = wordAt(page, list[0]);
    await first.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await expect(openTip(page, list[0].k), "keyboard focus opens the explanation").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(anyTip(page), "Escape closes the explanation").toHaveCount(0);
    await expect(first).toBeFocused();
    if (c.keep) await expect(c.keep(page), "Escape leaves the panel behind open").toBeVisible();
    await page.keyboard.press("Enter");
    await expect(openTip(page, list[0].k), "Enter opens the explanation").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(anyTip(page)).toHaveCount(0);

    // A click explains the word and goes no further.
    await first.click();
    await expect(openTip(page, list[0].k)).toBeVisible();
    expect(page.url(), "a click on a word changes nothing else").toBe(url);
    if (c.keep) await expect(c.keep(page), "a click on a word leaves the panel open").toBeVisible();
  });
}

test("the Settings switch for marks hides only the question marks", async ({ page }) => {
  await open(page, PAGES[0]);
  const term = page.locator("[data-term]").first();
  test.skip((await term.count()) === 0, "no explained words on the home page");
  await expect(term.locator("[data-term-mark]")).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute("data-term-marks", "false"));
  await expect(term.locator("[data-term-mark]")).toBeHidden();
  await expect(term).toBeVisible();
  await term.hover();
  await expect(anyTip(page), "the word still explains itself without its mark").toHaveCount(1);
});

// Tabbing to a word below the fold scrolls the page to it. The explanation opens and stays open
// while the word has focus (WCAG 1.4.13), rather than closing with that scroll.
test("a word reached with Tab keeps its explanation open while the page scrolls to it", async ({ page }) => {
  await open(page, { path: "/how-it-works", budget: 6 });
  await page.waitForTimeout(1500); // smooth scrolling has started and left the page at the top
  const term = page.locator("[data-term]").first();
  test.skip((await term.count()) === 0, "no explained words on How it works");
  const below = await term.evaluate((el) => el.getBoundingClientRect().top > window.innerHeight);
  test.skip(!below, "the first word is already on screen");
  // Focus what comes just before the word, without scrolling; Tab then moves focus to the word.
  await term.evaluate((el) => {
    const focusable = [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex='-1'])",
      ),
    ];
    focusable[focusable.indexOf(el as HTMLElement) - 1]?.focus({ preventScroll: true });
  });
  await page.keyboard.press("Tab");
  await expect(term).toBeFocused();
  const tip = openTip(page, (await term.getAttribute("data-term")) ?? "");
  await page.waitForTimeout(800);
  await expect(tip, "the explanation is still open after the page scrolled").toBeVisible();
  await expect(tip, "and inside the window").toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Tab");
  await expect(anyTip(page), "moving focus on closes it").toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const c of PAGES) {
    test(`a tap explains a word on ${c.path}`, async ({ page }) => {
      await open(page, c);
      const list = await words(page);
      test.skip(list.length === 0, "no explained words on this page");
      // The first word that can be reached on this screen.
      let found: { w: Word; term: Locator } | null = null;
      for (const w of list) {
        const term = wordAt(page, w);
        const p = await aim(page, term);
        if (p.seen && p.hit) {
          found = { w, term };
          break;
        }
      }
      expect(found, "a word that can be tapped").not.toBeNull();
      const { w, term } = found!;
      const tip = openTip(page, w.k);
      await term.tap();
      await expect(tip, `a tap on "${w.text}" opens its explanation`).toBeVisible();
      await expect(tip, `the explanation of "${w.text}" is inside the screen`).toBeInViewport({ ratio: 1 });
      expect(await onTop(tip), `nothing covers the explanation of "${w.text}"`).toBe(true);
      await shot(page, `terms-${slug(c.path)}-tap-390`);
      await page.waitForTimeout(350);
      await term.tap();
      await expect(anyTip(page), "a second tap closes it").toHaveCount(0);
      await page.waitForTimeout(350);
      await term.tap();
      await expect(tip).toBeVisible();
      const rest = await away(page);
      await page.touchscreen.tap(rest.x, rest.y);
      await expect(anyTip(page), "a tap elsewhere closes it").toHaveCount(0);
      if (c.keep) await expect(c.keep(page)).toBeVisible();
    });
  }
});
