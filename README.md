# Useful Words

A bilingual EN/ZH reference for nouns, verbs, adjectives, and transitions — built for students.

Live at <https://usefulwords.forhuman.ca/>.

## Deploy

Static files in `./public/` are served by Cloudflare Workers via the `[assets]` directive. No build step.

```bash
npx wrangler deploy
```

In production, Cloudflare auto-deploys on push to `main` (configured in the dashboard).

## Project of

[Human, an Education Collective](https://forhuman.ca) — by Nico Jan.
