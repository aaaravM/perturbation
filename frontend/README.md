# Planet X Hunter: website

The Next.js site for Planet X Hunter. The project overview, data credits and results are in the
[main README](../README.md).

## Run it

Requires Node.js 20.9 or later and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env.local   # connects the site to the Planet X Hunter API
pnpm dev                     # http://localhost:3000
```

Without `.env.local`, the five challenge targets, the Sky globe and Discoveries still work from the
prepared data in `public/`; live fields, star lookups and quick-look spectra say the backend is not
connected.

## Check it

```bash
pnpm lint
npx tsc --noEmit
pnpm build
pnpm test:e2e                                                # Chrome, against the dev server
E2E_BASE_URL=https://planet-x-hunter.vercel.app pnpm test:e2e  # against the live site
npx playwright test --config playwright.cross.config.ts      # Safari's engine (desktop, iPhone) and Firefox
```

## Layout

| Folder | What lives there |
|---|---|
| `src/app/` | One folder per page: `/`, `/sky`, `/explore` (the Lab), `/discoveries`, `/help`, `/how-it-works`, `/about`, `/settings` |
| `src/components/` | Components by area: `globe/` and `sky/` (the Sky globe), `lab/` (the Lab workbench), `panel/` and `sky-panel/` (object details), `landing/` (home story), `discoveries/`, `help/`, `how-it-works/`, `about/`, `settings/`, `site/` (top bar, footer), `ui/` (shared controls, Liquid Glass, explained words); `cult/`, `skiper/` and `watermelon-ui/` hold adapted third-party components |
| `src/lib/` | Data access, URL state, settings, formatting |
| `public/` | Prepared data: challenge-target bundles, star catalogue tiles, sky textures, the Discoveries list and model summaries |
| `e2e/` | Playwright tests |
