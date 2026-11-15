"use client";
// Loads a target's static bundle for the Sky panel. If the real bundle is not there yet, a
// development build may fall back to the clearly labelled fixture; a production build never
// does, it reports the bundle as missing so the panel can say the images are being prepared.

import { useEffect, useState } from "react";
import { bundleUrl, loadBundle, type FieldManifest } from "@/lib/manifest";

export type BundleState =
  | { status: "loading" }
  | { status: "ready"; manifest: FieldManifest; manifestUrl: string; fixture: boolean }
  | { status: "missing" };

const FIXTURE_SLUG = "_fixture";
const ALLOW_FIXTURE = process.env.NODE_ENV !== "production";

export function useBundle(slug: string): BundleState {
  const [state, setState] = useState<{ slug: string; value: BundleState }>({
    slug,
    value: { status: "loading" },
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const ready = (manifest: FieldManifest, from: string): BundleState => ({
      status: "ready",
      manifest,
      manifestUrl: bundleUrl(from),
      fixture: manifest.source === "fixture" || from === FIXTURE_SLUG,
    });

    (async () => {
      try {
        const manifest = await loadBundle(slug, { signal });
        if (!signal.aborted) setState({ slug, value: ready(manifest, slug) });
        return;
      } catch {
        if (signal.aborted) return;
      }
      if (ALLOW_FIXTURE) {
        try {
          const manifest = await loadBundle(FIXTURE_SLUG, { signal });
          if (!signal.aborted) setState({ slug, value: ready(manifest, FIXTURE_SLUG) });
          return;
        } catch {
          if (signal.aborted) return;
        }
      }
      setState({ slug, value: { status: "missing" } });
    })();

    return () => controller.abort();
  }, [slug]);

  return state.slug === slug ? state.value : { status: "loading" };
}
