# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Fulcrum is

A tabletop urgent-care guideline-development simulator. 3–5 providers sit on a Microsoft Teams call, the DM screen-shares this app, and the group plays one shared UC clinician through a panel of patients while the DM voices each patient. The deliverable is the discussion transcript; clinical-reasoning language is later mined from the recording. The app itself is a pure-static SPA — no backend, no DB, no LLM, no transcript capture.

See `README.md` for the pitch and `spec/rules-engine.md` for the authoritative engine contract.

## Commands

```bash
npm run build       # one-shot: bundles cases + esbuilds src/main.ts → public/js/main.js
npm run dev         # esbuild watch + wrangler pages dev on public/ (http://localhost:8788)
npm run deploy      # build + wrangler pages deploy to Cloudflare project "fulcrum"
npm run build:cases # rebuild only public/cases.json + public/library.json from cases/*.yaml
npx tsc --noEmit    # type-check (there is no test suite; tsc is the only static gate)
```

The build pipeline is two stages: `scripts/build-cases.mjs` reads YAML in `cases/` and emits `public/cases.json` and `public/library.json` (manifest of cases, DM packets, specs), then esbuild bundles the TS. Both stages run from `scripts/build.mjs`.

## High-level architecture

### Pure-static SPA, Cloudflare Pages

Everything ships from `public/`. No server code, no API routes, no runtime data fetching beyond `cases.json` and `library.json`. State lives in memory in the DM window for the duration of a session.

### Deterministic, snapshot-able engine

`src/engine.ts` is a pure reducer: `applyEvent(prevState, allCases, event) → { state, cues, outcomes }`. There are **no calls to `Math.random()`** anywhere in the engine — all randomness flows through a mulberry32 PRNG seeded by `state.seed` and advanced by `state.rngCursor`. Given `(seed, action sequence)` the game is fully reproducible. Snapshots are pushed at the end of every turn into `SnapshotBuffer` (default depth 30) for rewind/counterfactual replay. Treat the engine as a hot path: it must remain DOM-free and side-effect-free.

### Two-window DM / Player split

Role is resolved once at startup from `?role=player` (else DM) and stamped onto `<body>` as `role-dm` / `role-player`. Synchronization is one-way over `BroadcastChannel('fulcrum-sync')`:

- DM window owns state; every `dispatch()` rebroadcasts `{state, cues, turnSecondsRemaining}`.
- Player window's `dispatch()` is a no-op — the entire mirror is read-only. CSS lockouts in `body.role-player` hide action buttons, the case-pick controls, the DM brief, and the cues+log panel.
- On open, the player window posts `{kind: 'request-state'}` so the DM rebroadcasts immediately.

If you add interactive features, gate them on `ROLE === 'dm'` AND make sure the resulting state changes flow through `dispatch()` → `broadcastState()`.

### Time model: explicit, not real-time

Three clocks with very different jobs (see `spec/rules-engine.md §1`):

| Clock | Granularity | Advances on | Purpose |
|---|---|---|---|
| Wall-clock turn timer | seconds (90s default) | `setInterval`, runs only while a player is on the floor | Per-voice engagement timer, soft expiry |
| Within-turn budget | abstract units (10 / room visit) | Action costs | Caps over-questioning; resets when avatar enters a room |
| In-game shift clock | minutes (5 / turn-tick) | **Only** `END_TURN` or `COMMIT_DISPO` | Drives deterioration, order resolution, arrivals; 7:30 AM → 7:30 PM = 144 turns |

Critically, history/exam/orders/meds do **not** advance the shift clock. Only the DM-fired `END_TURN` (or a `COMMIT_DISPO`) ticks vitals, resolves orders, drifts acuity tiers, and triggers patient arrivals. New code that needs "time passes" must go through `advanceTurn()`.

### Hidden diagnosis model

Each `Patient` carries a `hiddenDx` drawn (weighted) from the case file's `hidden_dx_draw` at creation time. **It is never displayed in the player UI.** The visible UI shows an `acuityTier` (0=stable → 3=critical), vitals trajectories sampled per-tier from `vitals_trajectory[dx][tier_N]`, and DM-voiced findings. Dispo outcomes are keyed by `(hiddenDx, dispo, tier)` in `dispo_outcomes`. When touching player-side rendering, audit any path that touches a case file to make sure the dx string never leaks (room labels, case-picker titles, etc.).

The DM brief panel (`renderDmBrief` in `src/main.ts`) intentionally reveals everything — hidden truth, tier trajectory deltas, pre-revealed order results for every available order, and dispo outcome previews. It is gated by `role-dm` and a manual open/close.

### Case-authoring contract

Cases are YAML in `cases/` with companion markdown DM packets in `cases/dm-packets/`. The shape is defined in `spec/case-file-schema.md` and mirrored by `CaseFile` and friends in `src/types.ts`. Adding or editing a case is a no-code workflow as long as the schema is respected:

- `hidden_dx_draw` weights → which dx the patient gets at creation
- `vitals_trajectory[dx][tier_N]` → deltas applied each turn and `drift_to_tier_{N+1}_per_turn` probabilities
- `orders_available[*].result_by_dx[dx]` → the text + structured result the order resolves to
- `dispo_outcomes[dx][dispo][tier_N]` → terminal narrative shown on disposition

Run `npm run build:cases` after editing YAML so `cases.json` is regenerated; `npm run dev` does this automatically on each rebuild.

### Layout / resize gutters

The DM window uses flex-row at the top level (`.layout`) with three draggable gutters. The player window overrides `.layout` to CSS grid (2 columns, 2 rows) so the floor plan can dominate the screenshare and results+pending stack under the room view. The drag handler in `src/main.ts` writes unitless numbers (pixel widths) to CSS variables like `--flex-floor` / `--flex-room` on `document.documentElement`. The grid layout consumes those via `calc(var(--flex-foo) * 1fr)`, so a single drag mechanic drives both layouts without role-specific handler code. Layout state persists to `localStorage` under a role-scoped key (`fulcrum.layout.${ROLE}.v1`) so DM and player windows don't fight each other.

## Things v1 explicitly does not do

From `spec/rules-engine.md §9`: no persistence across refresh, no LLM polish layer, no transcript capture (Teams owns that), no "why" prompts (DM voices those), no rewind UI yet (engine supports it, UI is v1.5). Don't add these without scope discussion — the simulator is meant to feed Copilot, not replicate it.
