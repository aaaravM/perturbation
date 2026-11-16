"use client";
// The Settings page: appearance, the Sky globe, the Lab, the guided tours, data and privacy, the
// API connection and the Lab's keyboard shortcuts. Every choice goes straight into the preferences store
// (lib/preferences), so it applies at once on every open page; each section says "Saved" quietly
// and has its own Reset.

import * as React from "react";
import Link from "next/link";
import {
  LAB_BLINK_MS_RANGE,
  PREFERENCE_DEFAULTS,
  REDUCED_MOTION_QUERY,
  REDUCED_TRANSPARENCY_QUERY,
  resetPreferences,
  setPreference,
  useMediaQuery,
  usePreferences,
  usePreferencesReady,
  type PreferenceKey,
  type Preferences,
} from "@/lib/preferences";
import { supportsGlassRefraction } from "@/components/ui/liquid-glass";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { TOUR_HREF } from "@/lib/tour";
import { Choice, SettingRow, SettingsSection, Toggle, useFlash, type ChoiceOption } from "@/components/settings/controls";
import { BlinkPreview, GlassPreview } from "@/components/settings/previews";
import { StoredDataSection } from "@/components/settings/stored-data";
import { ConnectionSection } from "@/components/settings/connection-status";
import { ShortcutsSection } from "@/components/settings/shortcut-list";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "sky", label: "Sky globe" },
  { id: "lab", label: "Lab" },
  { id: "tours", label: "Guided tours" },
  { id: "data", label: "Data and privacy" },
  { id: "connection", label: "Connection" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
] as const;

const APPEARANCE_KEYS = ["glass", "motion", "termMarks"] as const satisfies readonly PreferenceKey[];
const SKY_KEYS = ["skyStarDetail", "skyStartIn", "skyConstellations", "skyInfraredMap"] as const satisfies readonly PreferenceKey[];
const LAB_LAYOUT_KEYS = ["labDataPane", "labBlinkPlayer", "labAnalysisPane"] as const satisfies readonly PreferenceKey[];
const LAB_KEYS = ["labDetector", "labBlinkMs", ...LAB_LAYOUT_KEYS] as const satisfies readonly PreferenceKey[];
const TOUR_KEYS = ["tourOffer"] as const satisfies readonly PreferenceKey[];

const changed = (p: Preferences, keys: readonly PreferenceKey[]) => keys.some((k) => p[k] !== PREFERENCE_DEFAULTS[k]);

/** Set a preference and say "Saved" in its section. */
function useSetter() {
  const flash = useFlash();
  return React.useCallback(
    <K extends PreferenceKey>(key: K, value: Preferences[K]) => {
      setPreference(key, value);
      flash();
    },
    [flash],
  );
}

export function SettingsView() {
  const prefs = usePreferences();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-2xl">
        <h1 className="text-title text-fg">Settings</h1>
        <p className="mt-3 text-lead text-pretty text-fg-dim">
          Every choice applies at once and is kept in this browser only.
        </p>
      </header>

      <div className="mt-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-16 xl:gap-24">
        <SectionIndex />
        <div className="flex max-w-3xl min-w-0 flex-col gap-16">
          <SettingsSection
            id="appearance"
            title="Appearance"
            canReset={changed(prefs, APPEARANCE_KEYS)}
            onReset={() => resetPreferences(APPEARANCE_KEYS)}
          >
            <GlassRow value={prefs.glass} />
            <MotionRow value={prefs.motion} />
            <MarksRow value={prefs.termMarks} />
          </SettingsSection>

          <SettingsSection
            id="sky"
            title="Sky globe"
            description={
              <>
                How the <Link href="/sky" className="text-fg underline decoration-hair-strong underline-offset-4 hover:decoration-fg">Sky globe</Link> opens. Links that name a star or a view still open it.
              </>
            }
            canReset={changed(prefs, SKY_KEYS)}
            onReset={() => resetPreferences(SKY_KEYS)}
          >
            <SkyRows prefs={prefs} />
          </SettingsSection>

          <SettingsSection
            id="lab"
            title="Lab"
            description={
              <>
                How the <Link href="/explore" className="text-fg underline decoration-hair-strong underline-offset-4 hover:decoration-fg">Lab</Link> starts. A link that names a detector still opens on it.
              </>
            }
            canReset={changed(prefs, LAB_KEYS)}
            onReset={() => resetPreferences(LAB_KEYS)}
          >
            <LabRows prefs={prefs} />
          </SettingsSection>

          <SettingsSection
            id="tours"
            title="Guided tours"
            description="Step by step through the Sky globe or the Lab: a pointer shows each control and uses it, and each step explains one word."
            canReset={changed(prefs, TOUR_KEYS)}
            onReset={() => resetPreferences(TOUR_KEYS)}
          >
            <TourRows prefs={prefs} />
          </SettingsSection>

          <StoredDataSection />
          <ConnectionSection />
          <ShortcutsSection />
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- section index

function SectionIndex() {
  const [active, setActive] = React.useState<string>(SECTIONS[0].id);
  React.useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
        // The first section whose top is in the upper part of the window, else the last one above it.
        const order = SECTIONS.map((s) => s.id);
        const shown = order.filter((id) => (visible.get(id) ?? Infinity) !== Infinity);
        if (shown.length) setActive(shown[0]);
      },
      { rootMargin: "-96px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <nav aria-label="Settings sections" className="hidden lg:block">
      <ul className="sticky top-28 flex flex-col gap-0.5">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "relative flex h-9 items-center rounded-[8px] pl-3 text-meta transition-colors duration-200",
                active === s.id ? "text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-2 bottom-2 left-0 w-px transition-colors duration-200",
                  active === s.id ? "bg-accent" : "bg-hair-strong",
                )}
              />
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------------- rows

const GLASS_OPTIONS: ChoiceOption<Preferences["glass"]>[] = [
  { value: "full", label: "Full" },
  { value: "subtle", label: "Subtle" },
  { value: "off", label: "Off" },
];

const noopSubscribe = () => () => {};

function GlassRow({ value }: { value: Preferences["glass"] }) {
  const set = useSetter();
  const lessTransparency = useMediaQuery(REDUCED_TRANSPARENCY_QUERY);
  const canBend = React.useSyncExternalStore(noopSubscribe, supportsGlassRefraction, () => true);
  return (
    <SettingRow
      label="Glass effect"
      labelId="pref-glass"
      description={
        <>
          The top bar and other glass surfaces. Full bends the light at the edges like a lens, Subtle is frosted
          only and Off uses solid panels.
          {lessTransparency ? (
            <span className="mt-1 block text-fg">
              Your device asks for less transparency, so glass shows as solid panels whatever you pick.
            </span>
          ) : value === "full" && !canBend ? (
            <span className="mt-1 block">
              This browser shows Full as frosted glass: the bending at the edges needs Chrome, Edge or another
              Chromium browser.
            </span>
          ) : null}
        </>
      }
      control={
        <Choice value={value} options={GLASS_OPTIONS} onChange={(v) => set("glass", v)} labelledBy="pref-glass" testId="pref-glass" />
      }
    >
      <GlassPreview />
    </SettingRow>
  );
}

const MOTION_OPTIONS: ChoiceOption<Preferences["motion"]>[] = [
  { value: "system", label: "Match my device" },
  { value: "reduce", label: "Reduce" },
  { value: "full", label: "Full" },
];

function MotionRow({ value }: { value: Preferences["motion"] }) {
  const set = useSetter();
  const ready = usePreferencesReady();
  const deviceReduces = useMediaQuery(REDUCED_MOTION_QUERY);
  return (
    <SettingRow
      label="Motion"
      labelId="pref-motion"
      description={
        <>
          Page fades, scroll effects, sliding controls, and whether the Lab&rsquo;s blink starts by itself.
          {ready && (
            <span className="mt-1 block">
              {deviceReduces ? "Your device asks for reduced motion." : "Your device does not ask for reduced motion."}
            </span>
          )}
        </>
      }
      control={
        <Choice value={value} options={MOTION_OPTIONS} onChange={(v) => set("motion", v)} labelledBy="pref-motion" testId="pref-motion" />
      }
    />
  );
}

function MarksRow({ value }: { value: boolean }) {
  const set = useSetter();
  return (
    <SettingRow
      label="Explanation marks"
      htmlFor="pref-term-marks"
      description={
        <>
          A small ? after a technical word, as in{" "}
          <span className="text-fg">
            <span className="underline decoration-dotted decoration-[1.5px] underline-offset-[3px] [text-decoration-color:color-mix(in_srgb,currentColor_58%,transparent)]">
              arcseconds
            </span>
            <sup aria-hidden data-term-mark="" className="ml-px align-super text-[0.66em] leading-none font-medium opacity-80">
              ?
            </sup>
          </span>
          , says it has a short explanation. The dotted underline stays either way.
        </>
      }
      control={<Toggle id="pref-term-marks" checked={value} onChange={(v) => set("termMarks", v)} testId="pref-term-marks" />}
    />
  );
}

const STAR_DETAIL_OPTIONS: ChoiceOption<Preferences["skyStarDetail"]>[] = [
  { value: "bright", label: "Bright only", hint: "about 8,900 stars" },
  { value: "more", label: "More", hint: "about 41,000 stars" },
  { value: "all", label: "All", hint: "all 117,955 stars" },
];

const START_OPTIONS: ChoiceOption<Preferences["skyStartIn"]>[] = [
  { value: "sphere", label: "Sphere" },
  { value: "3d", label: "3D space" },
];

function SkyRows({ prefs }: { prefs: Preferences }) {
  const set = useSetter();
  return (
    <>
      <SettingRow
        label="Star detail"
        labelId="pref-star-detail"
        description="Bright only draws about 8,900 stars, More about 41,000 and All every one of the 117,955 Hipparcos stars. Fewer can help an older device; search and the star lists still find every star."
        control={
          <Choice
            value={prefs.skyStarDetail}
            options={STAR_DETAIL_OPTIONS}
            onChange={(v) => set("skyStarDetail", v)}
            labelledBy="pref-star-detail"
            testId="pref-star-detail"
          />
        }
      />
      <SettingRow
        label="Start in"
        labelId="pref-start-in"
        description="The sky as a sphere around you, or out in 3D space with each star at its distance from the Sun."
        control={
          <Choice
            value={prefs.skyStartIn}
            options={START_OPTIONS}
            onChange={(v) => set("skyStartIn", v)}
            labelledBy="pref-start-in"
            testId="pref-start-in"
          />
        }
      />
      <SettingRow
        label="Constellation lines at start"
        htmlFor="pref-constellations"
        description="The stick figures of the constellations. Layers in the Sky turns them on or off there."
        control={
          <Toggle
            id="pref-constellations"
            checked={prefs.skyConstellations}
            onChange={(v) => set("skyConstellations", v)}
            testId="pref-constellations"
          />
        }
      />
      <SettingRow
        label="SPHEREx infrared map at start"
        htmlFor="pref-infrared"
        description="The SPHEREx all-sky map behind the stars, as on the globe’s Layers menu."
        control={
          <Toggle id="pref-infrared" checked={prefs.skyInfraredMap} onChange={(v) => set("skyInfraredMap", v)} testId="pref-infrared" />
        }
      />
    </>
  );
}

const DETECTOR_OPTIONS: ChoiceOption<Preferences["labDetector"]>[] = [
  { value: "D1", label: "D1", hint: "0.75 to 1.09 micrometres" },
  { value: "D2", label: "D2", hint: "1.10 to 1.62 micrometres" },
  { value: "D3", label: "D3", hint: "1.63 to 2.41 micrometres" },
  { value: "D4", label: "D4", hint: "2.42 to 3.82 micrometres" },
  { value: "D5", label: "D5", hint: "3.83 to 4.41 micrometres" },
  { value: "D6", label: "D6", hint: "4.42 to 5.00 micrometres" },
  { value: "rgb", label: "Colour", hint: "D1, D3 and D6 as blue, green and red" },
];

function LabRows({ prefs }: { prefs: Preferences }) {
  const set = useSetter();
  const flash = useFlash();
  return (
    <>
      <SettingRow
        label="First detector"
        labelId="pref-detector"
        description="SPHEREx has six detectors, from D1 (the shortest wavelengths, 0.75 micrometres) to D6 (the longest, 5). Colour shows D1, D3 and D6 together. A field without your choice opens in D6."
        control={
          <Choice
            value={prefs.labDetector}
            options={DETECTOR_OPTIONS}
            onChange={(v) => set("labDetector", v)}
            labelledBy="pref-detector"
            testId="pref-detector"
          />
        }
      />
      <SettingRow
        label="Blink speed"
        labelId="pref-blink"
        description="Time per frame when the Lab blinks between dates. The Lab’s own slider still changes it there."
        control={
          <div className="flex w-full items-center gap-4 sm:w-72">
            <Slider
              min={LAB_BLINK_MS_RANGE.min}
              max={LAB_BLINK_MS_RANGE.max}
              step={50}
              value={[prefs.labBlinkMs]}
              onValueChange={([v]) => setPreference("labBlinkMs", v)}
              onValueCommit={() => flash()}
              aria-label="Blink speed"
              aria-valuetext={`${prefs.labBlinkMs} milliseconds per frame`}
              data-testid="pref-blink"
              className="flex-1"
            />
            <span className="readout w-16 shrink-0 text-right text-meta text-fg">{prefs.labBlinkMs} ms</span>
          </div>
        }
      >
        <BlinkPreview ms={prefs.labBlinkMs} />
      </SettingRow>
      <LabLayoutRow prefs={prefs} />
    </>
  );
}

const LAB_PANE_NAMES: Record<(typeof LAB_LAYOUT_KEYS)[number], string> = {
  labDataPane: "the data pane",
  labBlinkPlayer: "the blink player",
  labAnalysisPane: "the analysis pane",
};

function LabLayoutRow({ prefs }: { prefs: Preferences }) {
  const flash = useFlash();
  const hidden = LAB_LAYOUT_KEYS.filter((k) => !prefs[k]).map((k) => LAB_PANE_NAMES[k]);
  const list = hidden.length > 1 ? `${hidden.slice(0, -1).join(", ")} and ${hidden[hidden.length - 1]}` : hidden[0];
  return (
    <SettingRow
      label="Lab layout"
      description={
        <>
          The data pane, the blink player and the analysis pane. On a wide screen, the buttons at the top right of the
          Lab, or Ctrl B, Ctrl J and Ctrl Alt B, hide them to give the sky more room, and the Lab opens the same way
          next time.
          {hidden.length > 0 && (
            <span className="mt-1 block text-fg" data-testid="lab-layout-hidden">
              Hidden now: {list}.
            </span>
          )}
        </>
      }
      control={
        <button
          type="button"
          disabled={hidden.length === 0}
          onClick={() => {
            resetPreferences(LAB_LAYOUT_KEYS);
            flash();
          }}
          className="inline-flex h-9 items-center rounded-[8px] border border-hair-strong px-3 text-meta text-fg-dim transition-colors hover:border-fg-faint hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          data-testid="reset-lab-layout"
        >
          Reset Lab layout
        </button>
      }
    />
  );
}

function TourRows({ prefs }: { prefs: Preferences }) {
  const set = useSetter();
  const link =
    "inline-flex h-9 items-center rounded-[8px] border border-hair-strong px-3 text-meta text-fg-dim transition-colors hover:border-fg-faint hover:text-fg";
  return (
    <>
      <SettingRow
        label="Offer the guided tour on a first visit"
        htmlFor="pref-tour-offer"
        description="A small note the first time you open the Sky globe or the Lab, offering its tour. Each tool offers it once."
        control={<Toggle id="pref-tour-offer" checked={prefs.tourOffer} onChange={(v) => set("tourOffer", v)} testId="pref-tour-offer" />}
      />
      <SettingRow
        label="Replay a tour"
        description="Start a tour again from its first step. The Lab tour opens on Barnard's Star."
        control={
          <div className="flex flex-wrap gap-2">
            <Link href={TOUR_HREF.sky} className={link} data-testid="replay-sky-tour">
              Replay the Sky tour
            </Link>
            <Link href={TOUR_HREF.lab} className={link} data-testid="replay-lab-tour">
              Replay the Lab tour
            </Link>
          </div>
        }
      />
    </>
  );
}
