# Fulcrum Rules Engine — v1 Spec

This is the contract that case files validate against. The engine is deterministic given a seed, snapshot-able per turn (rewind-ready), and runs entirely client-side with no LLM dependency.

## 1. Time scales

Three independent clocks, each with a distinct job:

| Clock | Granularity | Purpose | Pause behavior |
|---|---|---|---|
| **Wall-clock turn timer** | seconds (default 90s) | Per-voice engagement timer; one player has the floor at a time | DM-controllable pause/play |
| **Within-turn time budget** | abstract units (default 10 / room visit) | Punishes over-questioning + over-examining; teaches focused exam/history | Resets when the avatar leaves the room |
| **In-game shift clock** | minutes (default 5 min per turn-tick) | Drives panel pressure, deterioration, order resolution | Pauses with wall-clock |

The wall-clock and shift-clock pause **together** under a single DM control. The within-turn budget is per-room-visit and resets when the avatar exits.

## 2. Game state shape

```ts
type GameState = {
  caseId: string;
  seed: number;             // PRNG seed for determinism
  rngCursor: number;        // # of draws taken so far
  shiftClockMin: number;    // in-game minutes elapsed
  paused: boolean;
  patients: Patient[];
  pendingOrders: PendingOrder[];
  resolvedOrders: ResolvedOrder[];
  facilityLoad: { ct: number; mri: number; xray: number; lab: number; ivPump: number };  // queue depths
  activeRoom: string | null;     // which room the avatar is in
  withinTurnBudget: number;      // remaining time-units in active room
  turnIx: number;                // monotonic turn counter
  log: ActionLogEntry[];         // for state-log + replay
};

type Patient = {
  id: string;
  caseRef: string;          // points into loaded case files
  hiddenDx: string;          // drawn at creation; never displayed
  acuityTier: number;      // 0 = stable, 1 = drifting, 2 = deteriorating, 3 = critical
  vitalsCurrent: Vitals;     // refreshed on each shift-clock tick from trajectory
  room: string;              // location id (e.g., "bay_3", "waiting_room", "radiology")
  arrivedTurn: number;
  dispoCommitted: Disposition | null;   // null until dispo
  examsPerformed: string[];  // region ids the player has examined this visit + prior
  historyAsked: string[];    // history-item ids asked
  ordersPlaced: string[];    // order ids placed for this patient
  notes: string[];           // free-form DM annotations (rare)
};

type Vitals = { hr: number; sbp: number; dbp: number; rr: number; spo2: number; tempC: number };

type PendingOrder = {
  orderId: string;           // catalog id ("ct_abd_pelv_contrast", "cbc", ...)
  patientId: string;
  placedTurn: number;
  resolvesTurn: number;      // computed from base time + facility load at placement
};

type ResolvedOrder = {
  orderId: string;
  patientId: string;
  resolvedTurn: number;
  resultText: string;        // canned from case file
  resultData: Record<string, unknown>;  // structured (e.g., { hgb: 10.4 })
  triggersDeterioration: boolean;       // case-file decides
};
```

## 3. Action vocabulary

Player actions emitted by the UI, consumed by the engine:

| Action | Cost (within-turn units) | Effect |
|---|---|---|
| `ENTER_ROOM(roomId)` | 0 (one per turn, the explicit move) | Sets `activeRoom`. Resets `withinTurnBudget` to default. |
| `ASK_HISTORY(itemId)` | 1 (default; case-file may override 1–2) | Records on patient. App cues DM to voice the answer. |
| `EXAM_REGION(regionId)` | 2 (default; case-file may override 2–3) | Records on patient. App cues DM to voice the finding. May trigger deterioration tier change if case-file rule says so. |
| `PLACE_ORDER(orderId)` | 1 | Adds to `pendingOrders` with `resolvesTurn` computed from base time + current facility load. Increments facility load for that resource. |
| `GIVE_MED(orderId)` | 1 | Same as order but for treatment (IV fluids, ondansetron, etc.). May immediately affect deterioration tier. |
| `COMMIT_DISPO(dispo)` | 0 (ends the turn) | Records dispo, ends turn, resolves outcome. |
| `EXIT_ROOM` | 0 | Clear active focus. Does NOT advance time. |
| `END_TURN` | n/a | Explicit DM-fired event (topbar button). Advances `shiftClockMin` by one tick, ticks vitals, resolves orders, refreshes within-turn budget, resets wall-clock turn timer. Does NOT change `activeRoom`. |

The avatar may not enter a different room in the same turn it entered one; entering = one turn.

## 4. Turn loop

Time advances on **explicit DM action only** (END_TURN or COMMIT_DISPO). Entering and leaving a room are free actions. Budget exhaustion does NOT auto-end the turn — it just disables further in-room actions until the DM hits End turn.

```
loop:
  receive event
  switch event:
    ENTER_ROOM(roomId, patientId):
      set activeRoom, reset withinTurnBudget
      (no time advance)
    ASK_HISTORY | EXAM_REGION | PLACE_ORDER | GIVE_MED:
      deduct cost from withinTurnBudget (if applicable)
      if budget <= 0: emit budget_exhausted cue (no auto-eject)
    EXIT_ROOM:
      clear activeRoom (no time advance)
    END_TURN:
      advanceTurn():
        shiftClockMin += tickMinutes
        for each patient: tick vitals, advance acuity tier per trajectory
        resolve pendingOrders whose resolvesTurn <= turnIx
        decrement facility load queues
        refresh withinTurnBudget
        snapshot state
        reset wall-clock turn timer
    COMMIT_DISPO(dispo):
      record outcome
      clear activeRoom + activePatientId (patient leaves bay)
      advanceTurn() (same as above)
```

## 5. Deterioration model

Each patient has a **acuity tier** (0–3) tracked by the engine and a hidden true diagnosis drawn at patient creation from the case file's `hidden_dx_draw`. The trajectory advances based on:

- **Time-only triggers** — every N turns, advance tier with probability P (per-dx in case file).
- **Action triggers** — certain actions (or omissions) advance tier or hold it. Examples: not giving fluids to dehydrated patient → advance; placing CT order on the AAA-disguised-as-back-pain → no effect; giving NSAID to GI-bleed-as-dyspepsia → advance.
- **Treatment triggers** — correct meds hold or de-escalate the tier (e.g., IV fluids for the sepsis-disguised-as-UTI patient → hold at tier 1).

Manifest tier drives the visible health bar and the vital trajectory the engine samples from. The hidden dx is never displayed; the bar tracks **acuity** state, which the player sees in vitals + DM-voiced findings.

## 6. RNG and snapshots

The engine never calls `Math.random()`. All randomness flows through a seeded mulberry32 PRNG. Each draw increments `rngCursor`, so the entire game is deterministic given `(seed, rngCursor)`.

A snapshot is the `GameState` object plus the action log. Snapshots are taken at the end of every turn and stored in an in-memory ring buffer (default depth 30 turns).

**Rewind contract (v1 ready, UI in v1.5):** loading snapshot N restores `GameState` to its post-turn-N state. Replaying from there with different player actions produces deterministic counterfactuals.

## 7. Disposition outcomes

`COMMIT_DISPO` accepts one of:

- `DISCHARGE_HOME` — patient leaves the bay; outcome resolved against hidden dx + acuity tier (case-file-defined; e.g., DC of sepsis-as-UTI at tier 0 → "patient returned 24h later in shock" terminal text)
- `TRANSFER_ED` — patient leaves the bay; outcome usually positive when warranted, neutral when not warranted (consumes EMS, no penalty for over-transferring beyond the meta meter)
- `REFER_PCP` — outpatient PCP follow-up; outcome similar to discharge
- `REFER_SPECIALIST` — outpatient specialty follow-up
- `OBSERVE` — patient stays in the bay for another N ticks; not a terminal dispo

Each dispo references a `dispo_outcomes` table in the case file keyed by `(hidden_dx, acuity_tier)`.

## 8. Facility load model

Each facility resource has a queue depth (integer). Placing an order adds 1 to the queue at order time and subtracts 1 when the order resolves. Order base-time-to-result is multiplied by `(1 + queueDepth * loadFactor)` where `loadFactor` defaults to `0.25`. Deeper queue → longer waits. Order resolution times are integer-floored to whole turns.

## 9. What the engine does NOT do (v1)

- No multi-patient panel orchestration (deferred — single patient v1)
- No patient arrival cadence (deferred — patient is pre-placed v1)
- No LLM polish layer (tables-only)
- No persistence (state is in-memory; refresh resets — fine for demo)
- No transcript capture (Teams owns that)
- No "why" prompts (DM owns those)
