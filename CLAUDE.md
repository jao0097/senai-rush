# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SENAI Rush: Critter Circuit** — a 3D arcade kart racer set on the SENAI Pompéia campus (UI text is Portuguese). The repository contains **only the compiled production build** in `senai-rush-netlify/`, prepared for static deploy on Netlify. There is no source code, no `package.json`, no build tooling, no tests, and no git history here.

Consequences:
- There are no build/lint/test commands. Changes must be made directly to the minified bundles, or the original Vite source project must be obtained to rebuild.
- Asset filenames carry Vite content hashes (e.g. `game-BVaTPfK4.js`). If you rename a chunk, update every reference to it — in `index.html` and in the `import(...)` / `from"./..."` strings inside other chunks.
- Minified export names (e.g. `import{or as e,sr as t}from"./index-BgxqOEwe.js"`) are mangled cross-chunk bindings; changing an export in one chunk breaks importers.

## Editing workflow

Readable (prettier-formatted) copies of `game`, `index` and `kartModel` live in `.work/`. Edit those, then minify back into the build under the same filename:

```
cd .work && npx -y esbuild@0.24 game-BVaTPfK4.js --minify --format=esm --target=es2022 --outfile=../senai-rush-netlify/assets/game-BVaTPfK4.js
```

`.work/pw/r.mjs` is a headless Playwright smoke test (menu → race, screenshots, console errors) against a local server on port 8765. The untouched original build is in `senai-rush-netlify.backup/`.

## Running locally

Serve the folder over HTTP (ES modules and WASM do not work from `file://`):

```
cd senai-rush-netlify && python3 -m http.server 8000
```

For a version that opens by double-click (`file://`), `python3 tools/build-offline.py` bundles the build into one self-contained `senai-rush-offline/index.html` (esbuild IIFE + inlined CSS/fonts/images). Re-run it after any change to `senai-rush-netlify/`.

Racer face photos: `python3 tools/make-face.py <photo> <character-id> [--box x0,y0,x1,y1]` writes `senai-rush-netlify/assets/<id>-face.webp` (512×660, oval cut-out). `isaac-face.webp` is optional: the kart model falls back to the plain head when it is missing.

Deploy = upload `senai-rush-netlify/` as-is (all paths in `index.html` are relative `./`).

## Bundle architecture

`index.html` provides `<canvas id="game">`, `#split-divider` (split-screen multiplayer), and `#ui` (DOM HUD/menus), then loads `assets/index-*.js`.

- `index-*.js` — entry: UI/menus, input (keyboard, gamepad, touch steering/buttons), shared config objects. Lazy-loads the other chunks via dynamic `import()`.
- `game-*.js` — race logic: laps, items (boxes, cannonball), surfaces (off-road / "fluff" slowdown), split-screen. Imports `physics`, `tuning`, `kartModel`.
- `physics-*.js` (~4 MB) — Rapier physics compiled to WASM via wasm-bindgen (WASM inlined). Do not edit.
- `renderer-*.js` — Three.js renderer.
- `kartModel-*.js` — procedural kart builder (`buildKart`, `Parts`, `TOON` toon-shading palette).
- `tuning-*.js` — registry of live-tunable parameters (race laps, results delay, surface speeds, item respawn, camera FOV/distance/height/follow) with min/max/step validation. `GAMEPLAY` changes mark the run as `unranked`; `COSMETIC` (camera) do not. `applyMode` is `LIVE` or `NEXT_RUN`.
- `adapter-*.js` — bridges `tuning` to an external host via `window.__manusRegisterGameTuning` / `__manusGameTuningReply` (no-op when absent; schema verified by SHA-256 digest of the controls list).
- `*-face.webp|png` — character face textures for the playable racers.
- `fonts/` — subset variable fonts (Sora, Figtree, Noto Sans SC) with OFL licenses; Sora and Figtree are preloaded in `index.html`.
