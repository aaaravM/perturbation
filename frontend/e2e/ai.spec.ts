// What the AI does (/ai): the page is the home of the AI's finds and shows the two networks from the
// same published files as the rest of the site (the survey candidates and their stamps, the mover
// network's metrics, the spectral classifier's model card). Every find is listed with its stamp, how
// sure the AI is in words and the false-alarm check before any number; the statistics sit in one fold
// that starts closed. It steps through real candidates, asks the live API when a preset is picked and
// shows its answer word for word, says so honestly when a call fails, fits a phone, sits in the top bar
// and the phone menu, and has no serious or critical axe violations.
// The live part skips itself when the API cannot be reached.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_LAYOUT, FIREFOX_DEV_AXE, firefoxOnDevServer, hideDevOverlay, watchPage } from "./helpers";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PHONE = { width: 390, height: 844 };
const VALIDATION_URL = "https://github.com/aaaravM/perturbation/tree/main/docs/validation";

interface Cand {
  id: string;
  field: string;
  kind: "mover" | "variable";
  score: number;
  probs: Record<"mover" | "variable" | "artifact" | "nothing", number>;
  p_value: number | null;
  q_value: number;
  snr: number | null;
  stamp: string | null;
  lab_url: string;
  match: { status: "known" | "unknown"; name: string | null; id: string | null; catalog_pm_arcsec_yr: number | null };
}

// The page's own formatting (lib/discoveries.ts and How it works), so the test reads what a visitor reads.
const probPercent = (p: number) => (p > 0 && p < 0.005 ? "<1%" : p < 1 && p > 0.995 ? ">99%" : `${(p * 100).toFixed(0)}%`);
const formatQ = (q: number) => (q < 0.0001 ? "< 0.0001" : q < 0.01 ? q.toFixed(4) : q.toFixed(3));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const share = (p: number) => (p >= 0.995 ? ">99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
const sure = (s: number) => (s >= 0.9 ? "Very sure" : s >= 0.6 ? "Fairly sure" : s >= 0.4 ? "Unsure" : "Doubtful");
const byConfidence = (a: Cand, b: Cand) => a.q_value - b.q_value || b.score - a.score || a.id.localeCompare(b.id);

async function published(page: Page) {
  const movers = await (await page.request.get("/discoveries/candidates.json")).json();
  const spec = await (await page.request.get("/models/specclass.json")).json();
  return { movers, spec };
}

/** The order the page steps through: the clearest passing mover, then variable, then the list by q. */
function ordered(cands: Cand[], alpha: number): Cand[] {
  const sorted = [...cands].sort(byConfidence);
  const pass = sorted.filter((c) => c.q_value <= alpha);
  const best = (kind: "mover" | "variable") => pass.filter((c) => c.kind === kind).sort((a, b) => b.probs[kind] - a.probs[kind])[0];
  const first = [best("mover"), best("variable")].filter((c): c is Cand => !!c);
  return [...first, ...sorted.filter((c) => !first.includes(c))];
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ rule: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
  expect(blocking, `${label}: serious or critical axe violations`).toEqual([]);
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "horizontal page scroll").toBeLessThanOrEqual(0);
}

/** Every entrance has run: scroll through the page once it has hydrated. */
async function revealAll(page: Page) {
  await expect(page.locator('[data-reveal="idle"]')).toHaveCount(0);
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.6)) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    // On a busy machine a quick pass can outrun the observers: bring anything still hidden into view, as a reader would.
    for (const el of Array.from(document.querySelectorAll('[data-reveal="hidden"]'))) {
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
}

async function loaded(page: Page) {
  await expect(page.getByTestId("ai-example")).toBeVisible();
  await expect(page.getByTestId("ai-spec-card")).toBeVisible();
  await expect(page.getByTestId("ai-limits")).toContainText("pass the false-alarm check");
}

test.describe("What the AI does", () => {
  test("its sections, read from the published files", async ({ page }) => {
    const log = watchPage(page);
    const { movers, spec } = await published(page);
    expect((await page.goto("/ai"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("What the AI does");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2 })).toHaveText([
      "What it found",
      "What the network sees",
      "How it decides",
      "Try the spectral classifier",
      "What it cannot do",
    ]);
    await expect(main.locator("header")).toContainText("no chatbot or language model");
    await loaded(page);

    const m = movers.model.metrics;
    const facts = page.getByTestId("ai-mover-facts");
    await expect(page.getByTestId("ai-trained-on")).toHaveText(movers.model.trained_on);
    for (const v of [m.test_accuracy, m.mover_completeness_shift_ge_1px_snr10, m.mover_completeness_snr10, m.variable_completeness_snr10]) {
      await expect(facts).toContainText(pct(v));
    }
    await expect(facts).not.toContainText("false alarms");

    // The statistics: one fold, closed until asked for.
    const stats = page.getByTestId("ai-statistics");
    await expect(page.locator("main details[open]")).toHaveCount(0);
    await expect(stats.locator("summary")).toHaveText("The statistics behind the false-alarm check");
    await stats.locator("summary").click();
    await expect(stats).toHaveAttribute("open", "");
    await expect(page.getByTestId("ai-false-alarms")).toContainText(
      `the 95% upper limit is ${m.false_alarms_per_deg2_q05_upper95.toFixed(1)} per square degree`,
    );
    await expect(page.getByTestId("ai-false-alarms")).toContainText(`(${m.false_alarms_area_deg2.toFixed(3)} square degrees`);
    await expect(stats).toContainText("Benjamini–Hochberg q-value");

    const card = page.getByTestId("ai-spec-card");
    await expect(card).toContainText(`${(spec.test_accuracy * 100).toFixed(1)}%`);
    await expect(card).toContainText(`${(spec.test_accuracy_ci90[0] * 100).toFixed(1)}% to ${(spec.test_accuracy_ci90[1] * 100).toFixed(1)}%`);
    await expect(card).toContainText(spec.test_macro_f1.toFixed(3));
    await expect(card).toContainText(spec.n_train.toLocaleString("en-GB"));
    await expect(card).toContainText(spec.n_test.toLocaleString("en-GB"));
    const rows = page.getByTestId("ai-spec-classes").locator("tbody tr");
    await expect(rows).toHaveCount(spec.classes.length);
    for (const c of spec.classes) {
      const row = rows.and(page.locator(`[data-class="${c.key}"]`));
      await expect(row).toContainText(c.long);
      await expect(row).toContainText(pct(spec.test_recall_by_class[c.key]));
    }

    const limits = page.getByTestId("ai-limits");
    await expect(limits).toContainText(pct(m.mover_completeness_snr10));
    await expect(limits.getByRole("link", { name: "validation reports on GitHub" })).toHaveAttribute("href", VALIDATION_URL);
    await expect(limits.getByRole("link", { name: "how the search works" })).toHaveAttribute("href", "/how-it-works#search");
    await expect(limits.getByRole("link", { name: "finds above" })).toHaveAttribute("href", "#finds");

    await page.waitForTimeout(600);
    expect(log.badResponses, "HTTP errors").toEqual([]);
    expect(log.consoleErrors, "console errors").toEqual([]);
  });

  test("every find: its stamp, the kind of change, how sure the AI is, the check, the catalogue and the Lab", async ({ page }) => {
    const { movers } = await published(page);
    const alpha: number = movers.fdr.alpha;
    const all = [...(movers.candidates as Cand[])].sort(byConfidence);
    const passed = all.filter((c) => c.q_value <= alpha);
    const weaker = all.filter((c) => c.q_value > alpha);
    await page.goto("/ai");
    const scope = page.getByTestId("ai-scope");
    await expect(scope).toContainText(`${movers.survey.n_fields} patches of sky, ${movers.survey.area_deg2.toFixed(2)} square degrees`);
    await expect(scope).toContainText(`the AI kept the ${all.length} below`);
    // What the patches are centred on, counted from the list's fields, and where and how often it looked.
    const kinds = new Map<string, number>();
    for (const f of movers.fields as { kind: string }[]) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    const fields = page.getByTestId("ai-scope-fields");
    if (kinds.get("target")) await expect(fields).toContainText(`${kinds.get("target")} challenge target`);
    if (kinds.get("control")) await expect(fields).toContainText(`${kinds.get("control")} control patch`);
    const dets: string[] = movers.survey.detectors;
    const detWords = dets.length > 1 ? `${dets.slice(0, -1).join(", ")} and ${dets[dets.length - 1]}` : dets.join("");
    await expect(fields).toContainText(`detectors ${detWords}`);
    await expect(fields).toContainText(`a typical patch was visited ${movers.survey.epochs_median} times`);

    const finds = page.getByTestId("ai-find");
    await expect(finds).toHaveCount(all.length);
    await expect(page.getByTestId("finds-passed").getByTestId("ai-find")).toHaveCount(passed.length);
    await expect(page.getByTestId("finds-weaker").getByTestId("ai-find")).toHaveCount(weaker.length);
    for (const [i, c] of [...passed, ...weaker].entries()) {
      const card = finds.nth(i);
      await expect(card).toHaveAttribute("data-id", c.id);
      await expect(card.getByRole("heading", { level: 4 })).toContainText(c.kind === "mover" ? "Possible mover" : "Possible brightness change");
      // Plain words first, then the number.
      await expect(card.getByTestId("ai-find-sure")).toHaveText(`${sure(c.score)}, ${(c.score * 100).toFixed(0)}%`);
      await expect(card.getByTestId("ai-find-check")).toHaveText(c.q_value <= alpha ? "Passed" : "Not passed");
      // Catalogue names show without SIMBAD's "V* " prefix.
      const known = `${c.match.name ?? c.match.id}`.replace(/^V?\*\s+/, "").replace(/\s+/g, " ");
      await expect(card).toContainText(c.match.status === "known" ? `Known: ${known}` : "New:");
      await expect(card.getByTestId("ai-find-lab")).toHaveAttribute("href", c.lab_url);
      for (const img of await card.locator("img").all()) {
        await expect(img).toHaveAttribute("src", c.stamp!);
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(192);
      }
      // No q-value or p-value on the cards.
      await expect(card).not.toContainText("q-value");
      await expect(card).not.toContainText("p-value");
    }

    // The known objects found again: the targets and the known fast movers.
    const items = page.getByTestId("found-item");
    const knownMovers = all.filter((c) => c.kind === "mover" && c.match.status === "known" && c.match.catalog_pm_arcsec_yr !== null);
    await expect(items).toHaveCount(movers.targets.length + knownMovers.length);

    // "What the AI saw" opens the same find in the network's view, in sight, with focus on its title.
    const pick = finds.nth(Math.min(5, all.length - 1));
    const id = await pick.getAttribute("data-id");
    await pick.getByTestId("ai-find-show").click();
    const example = page.getByTestId("ai-example");
    await expect(example).toHaveAttribute("data-id", id!);
    await expect(example).toBeInViewport();
    await expect(page.locator("#ai-example-title")).toBeFocused();

    // The link to the statistics opens their fold.
    await page.getByTestId("ai-finds").getByRole("link", { name: "How it decides" }).click();
    await expect(page.getByTestId("ai-statistics")).toHaveAttribute("open", "");
  });

  test("real candidates, their stamps and what the network said, one by one", async ({ page, isMobile }) => {
    const { movers } = await published(page);
    const list = ordered(movers.candidates as Cand[], movers.fdr.alpha);
    await page.goto("/ai");
    const example = page.getByTestId("ai-example");
    await expect(example).toHaveAttribute("data-id", list[0].id);
    await expect(page.getByTestId("ai-example-count")).toHaveText(`Example 1 of ${list.length}`);
    expect(list[0].kind, "a clear mover comes first").toBe("mover");

    // The stamp's three panels and every thumbnail are the published PNGs, loaded.
    const panels = example.locator("img");
    await expect(panels).toHaveCount(3);
    for (const img of await panels.all()) {
      await expect(img).toHaveAttribute("src", list[0].stamp!);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(192);
    }
    const thumbs = page.getByTestId("ai-pick");
    await expect(thumbs).toHaveCount(list.length);
    for (const img of await thumbs.locator("img").all()) {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(192);
    }
    await expect(example.getByText("Earlier co-add")).toBeVisible();
    await expect(example.getByText("S/N difference")).toBeVisible();
    await expect(example.getByTestId("ai-network-window")).toHaveCount(3);

    const check = async (c: Cand) => {
      await expect(example).toHaveAttribute("data-id", c.id);
      for (const [name, p] of Object.entries(c.probs)) {
        await expect(example.locator(`[data-testid="ai-probs"] li[data-class="${name}"]`)).toContainText(probPercent(p));
      }
      const readout = example.getByTestId("ai-readout");
      await expect(readout).toContainText(`${sure(c.score)} it is a real change, ${(c.score * 100).toFixed(0)}%`);
      await expect(readout.getByTestId("ai-check")).toHaveText(c.q_value <= movers.fdr.alpha ? "Passed" : "Not passed");
      await expect(readout).toContainText(formatQ(c.q_value));
      if (c.p_value !== null) await expect(readout).toContainText(formatQ(c.p_value));
      if (c.snr !== null) await expect(readout).toContainText(c.snr.toFixed(1));
      await expect(example.getByTestId("ai-open-lab")).toHaveAttribute("href", c.lab_url);
    };
    await check(list[0]);

    await page.getByRole("button", { name: "Next example" }).click();
    await expect(page.getByTestId("ai-example-count")).toHaveText(`Example 2 of ${list.length}`);
    await check(list[1]);

    const last = list.at(-1)!;
    await thumbs.last().click();
    await expect(thumbs.last()).toHaveAttribute("aria-current", "true");
    await check(last);
    await page.getByRole("button", { name: "Next example" }).click();
    await check(list[0]);

    if (!isMobile) {
      await example.getByTestId("ai-open-lab").click();
      await expect(page).toHaveURL(/\/explore\?/);
    }
  });

  test("the presets ask the live API and show its answer word for word", async ({ page }) => {
    test.setTimeout(330_000);
    await page.goto("/ai");
    await loaded(page); // hydrated, so the buttons answer
    const box = page.getByTestId("ai-spec-try");
    const status = page.getByTestId("ai-spec-status");
    for (const name of ["3C 273", "Epsilon Indi B", "Barnard's Star"]) {
      const answered = page
        .waitForResponse((r) => r.url().includes("/api/spectrum/quick"), { timeout: 100_000 })
        .catch(() => null);
      await box.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
      await expect(status).toHaveAttribute("data-state", /done|error/, { timeout: 100_000 });
      const res = await answered;
      if ((await status.getAttribute("data-state")) === "error" || !res || !res.ok()) {
        test.skip(true, `the live API could not be reached: ${(await status.textContent()) ?? ""}`);
        return;
      }
      const body = await res.json();
      const c = body.classification;
      const result = page.getByTestId("ai-spec-result");
      await expect(result.getByRole("heading", { level: 3 })).toHaveText(name);
      await expect(result).toHaveAttribute("data-status", c.status);
      if (c.status === "ok") {
        await expect(result.getByTestId("ai-spec-sentence")).toContainText(c.label_text);
        const bars = result.getByTestId("ai-spec-probs").locator("li");
        await expect(bars).toHaveCount(7);
        for (const [key, p] of Object.entries(c.probs as Record<string, number>)) {
          await expect(bars.and(page.locator(`[data-class="${key}"]`))).toContainText(share(p));
        }
        for (const note of c.caveats as string[]) await expect(result).toContainText(note);
      } else {
        await expect(result.getByTestId("ai-spec-reason")).toHaveText(c.reason);
      }
      const drawn = (body.flux_ujy as unknown[]).filter((v) => typeof v === "number").length;
      if (drawn >= 3) await expect(result.getByTestId("quick-spectrum")).toBeVisible();
    }
  });

  test("a failed call says so and offers a retry, with nothing filled in", async ({ page }) => {
    await page.route("**/api/spectrum/quick**", (r) => r.abort());
    await page.goto("/ai");
    await loaded(page);
    await page.getByTestId("ai-spec-try").getByRole("button", { name: /^Barnard/ }).click();
    await expect(page.getByTestId("ai-spec-error")).toHaveText("The spectrum service could not be reached.");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByTestId("ai-spec-result")).toHaveCount(0);

    await page.unroute("**/api/spectrum/quick**");
    await page.route("**/api/spectrum/quick**", (r) => r.fulfill({ status: 503, body: "" }));
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("ai-spec-error")).toHaveText("The spectrum service answered HTTP 503.");
    await expect(page.getByTestId("ai-spec-result")).toHaveCount(0);
  });

  test("missing results say so instead of showing numbers", async ({ page }) => {
    await page.route("**/discoveries/candidates.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.route("**/models/specclass.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto("/ai");
    await expect(page.getByText("The candidate list could not be read on this site just now.")).toHaveCount(2);
    await expect(page.getByTestId("ai-find")).toHaveCount(0);
    await expect(page.getByText("The spectral classifier’s model card could not be read on this site just now.")).toBeVisible();
    await expect(page.getByTestId("ai-example")).toHaveCount(0);
  });

  test("How it works links here from its model results", async ({ page }) => {
    await page.goto("/how-it-works");
    await expect(page.locator("#search").getByRole("link", { name: "what the AI does" })).toHaveAttribute("href", "/ai");
  });

  for (const width of [1280, 1440]) {
    test(`the top bar has an AI link that fits at ${width} px`, async ({ page, isMobile }) => {
      test.skip(isMobile, DESKTOP_LAYOUT);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/ai");
      const bar = page.getByRole("navigation", { name: "Main" });
      const ai = bar.getByRole("link", { name: "AI", exact: true });
      await expect(ai).toBeVisible();
      await expect(ai).toHaveAttribute("aria-current", "page");
      // Every visible link in the bar sits on one row, whatever the bar holds.
      const middle = async (l: typeof ai) => {
        const b = (await l.boundingBox())!;
        return b.y + b.height / 2;
      };
      const row = await middle(ai);
      for (const link of await bar.getByRole("link").all()) {
        if (!(await link.isVisible())) continue;
        expect(Math.abs((await middle(link)) - row), (await link.textContent()) ?? "").toBeLessThan(3);
      }
      await noSideScroll(page);
    });
  }

  test("on a phone: one column, no sideways scroll, and AI in the menu", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto("/ai");
    await hideDevOverlay(page);
    await loaded(page);
    await revealAll(page);
    await noSideScroll(page);
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: "AI", exact: true })).toHaveAttribute("href", "/ai");
    await ctx.close();
  });

  test("reduced motion: everything is in place", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/ai");
    await loaded(page);
    await expect(page.locator("[data-reveal]").first()).toBeAttached();
    await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
    await ctx.close();
  });

  test("explained words stay few, and never on headings, links or buttons", async ({ page }) => {
    await page.goto("/ai");
    await loaded(page);
    const keys = await page.locator("main [data-term]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.term));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(5);
    expect(new Set(keys).size, "each word explained once").toBe(keys.length);
    await expect(page.locator("main :is(h1, h2, h3, h4, a, button, summary) [data-term]")).toHaveCount(0);
  });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", ...PHONE },
  ]) {
    test(`no serious or critical axe violations, folds open (${vp.name})`, async ({ page, isMobile, browserName }) => {
      test.skip(isMobile && vp.name === "desktop", DESKTOP_LAYOUT);
      test.skip(firefoxOnDevServer(browserName), FIREFOX_DEV_AXE);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/ai");
      await hideDevOverlay(page);
      await loaded(page);
      await revealAll(page);
      for (const d of await page.locator("main details").all()) await d.evaluate((el) => el.setAttribute("open", ""));
      await page.waitForTimeout(400);
      await noSideScroll(page);
      await audit(page, `/ai ${vp.name}`);
    });
  }
});
