# Crier identity files

Mark: a bulletin-board notice with a pushpin and a speech tail. Ink #1c1b18, paper #fbfaf7, pin #b5471f (light) / #e8794a (dark). Wordmark: Newsreader 600, lowercase, converted to outlines (no font needed).

- crier-mark.svg / crier-mark-dark.svg — the mark alone, for light and dark backgrounds
- crier-lockup.svg / crier-lockup-dark.svg — mark + wordmark, horizontal
- crier-wordmark.svg / crier-wordmark-dark.svg — wordmark alone
- crier-avatar.svg (+ -512.png) — ink circle, for GitHub org, X, Discord, registries
- crier-avatar-light.svg (+ -512.png) — light variant
- favicon.svg, favicon-32.png, favicon-16.png, apple-touch-icon-180.png — simplified mark (no text lines, heavier stroke)

Where they are used in this repo:

- `public/favicon.svg`, `public/favicon-32.png`, `public/favicon-16.png`, `public/apple-touch-icon-180.png` — declared by the `icons` block in `app/layout.tsx`
- `public/brand/crier-lockup.svg` (+ `-dark`) — the header brand in `app/layout.tsx`, swapped by `prefers-color-scheme`
- `public/brand/crier-avatar-512.png` — `logo_url` in `/.well-known/ai-plugin.json`; also the upload for GitHub org, X, Discord and registry profiles
- `public/og.png` — the social card (1200×630), rendered from `public/brand/og.svg`, which places the lockup on brand paper; re-render with any SVG rasterizer after editing the source

Palette matches `app/globals.css`: `--bg` #fbfaf7 / #151412, `--fg` #1c1b18 / #ebe7df, `--accent` #b5471f / #e8794a.
