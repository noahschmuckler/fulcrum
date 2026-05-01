# Fulcrum

A tabletop urgent-care guideline-development simulator. Composite-protagonist OSCE panel sim — small group of providers play one shared UC clinician through a panel of patients while the DM voices each patient. The deliverable is the discussion transcript (recorded by Teams), from which guideline language is extracted with M365 Copilot.

Forked conceptually from [threshold](https://github.com/noahschmuckler/threshold) — same clinical-decision-mining goal, different game.

## What this is

Three-to-five providers around a Microsoft Teams call. The DM screenshares this app. The app simulates an urgent-care floor (waiting room, rooms, radiology, lab) with patients arriving on a cadence; the DM voices each patient and supplies exam findings live. Players take turns inside the composite UC clinician's head — examine, ask history, place orders, dispo. The interesting clinical talk happens around the moment of disposition; Teams records the audio; Copilot harvests "why" statements for guideline drafting.

## Status

v1 demo, hosted on Cloudflare Pages. Single-patient interaction loop first; multi-patient panel + arrival cadence in the next iteration.

## Stack

- Pure-static SPA: HTML / CSS / TypeScript bundled with esbuild
- Hosted on Cloudflare Pages
- Cases authored as YAML in `/cases/`, bundled into a static JSON at build time
- DM case packets as Markdown in `/cases/dm-packets/`
- No backend, no DB, no LLM in v1 (engine is pure tables + deterministic RNG)

## Specs

- [`spec/rules-engine.md`](spec/rules-engine.md) — game state, turn loop, action vocabulary, time scales, deterioration model, snapshots
- [`spec/case-file-schema.md`](spec/case-file-schema.md) — YAML shape with worked example

## Local dev

```bash
npm install
npm run build       # one-shot build
npm run dev         # watch + local preview
npm run deploy      # build + deploy to Cloudflare Pages
```
