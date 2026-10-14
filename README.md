# Useful Words

A bilingual EN/ZH reference for nouns, verbs, adjectives, and transitions — built for students.

Live at <https://usefulwords.forhuman.ca/>.

## Deploy

Static files in `./public/` are served by Cloudflare Workers via the `[assets]` directive. No build step.

```bash
npx wrangler deploy
```

In production, Cloudflare auto-deploys on push to `main` (configured in the dashboard).

## Checks and capture

No build step and no `package.json`. The scripts need Node, Google Chrome and `playwright-core`, installed locally without a lockfile: `npm install --no-save --no-package-lock --prefix "$PWD" playwright-core@1.49.1`.

```bash
node scripts/serve.mjs                 # serve public/ at http://127.0.0.1:8787
node --test scripts/text.test.mjs      # casing and collocation emphasis, incl. every collocation in data.js
node scripts/verify.mjs                # end-to-end harness: tokens, contrast, jump landings, search, Transitions, console (~5 min)
node scripts/capture.mjs <out-dir>     # portfolio clips and stills at device pixels (needs ffmpeg); see its header
```

Run `verify.mjs` before pushing: a push to `main` deploys to students. The design spec is `_meta/plans/2026-10-13-usefulwords-dictionary-redesign.md`.

## Project of

[Human, an Education Collective](https://forhuman.ca) — by Nico Jan.
