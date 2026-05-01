// Fulcrum rules engine. Pure, deterministic given (seed, action sequence).

import type {
  CaseFile,
  Disposition,
  GameState,
  Patient,
  PendingOrder,
  TierTrajectory,
  Vitals,
} from './types.js';
import { Rng } from './rng.js';

export type EngineEvent =
  | { kind: 'enter_room'; roomId: string; patientId: string }
  | { kind: 'ask_history'; itemId: string }
  | { kind: 'exam_region'; regionId: string }
  | { kind: 'place_order'; orderId: string }
  | { kind: 'give_med'; medId: string }
  | { kind: 'commit_dispo'; dispo: Disposition }
  | { kind: 'exit_room' }
  | { kind: 'end_turn' }
  | { kind: 'toggle_pause' }
  | { kind: 'load_case'; caseFile: CaseFile; seed: number };

export type EngineResult = {
  state: GameState;
  cues: DmCue[]; // things the UI should display / the DM should voice
  outcomes: string[]; // disposition outcome texts to surface
};

export type DmCue =
  | { kind: 'history'; patientId: string; itemId: string }
  | { kind: 'exam'; patientId: string; regionId: string }
  | { kind: 'order_placed'; patientId: string; orderId: string; resolvesTurn: number }
  | { kind: 'order_result'; patientId: string; orderId: string; text: string }
  | { kind: 'tier_change'; patientId: string; from: number; to: number }
  | { kind: 'budget_exhausted'; patientId: string };

const DEFAULTS = {
  turnTickMinutes: 5,
  withinTurnBudgetMax: 10,
  loadFactor: 0.25,
};

export function newGame(caseFile: CaseFile, seed: number): EngineResult {
  const rng = new Rng(seed);

  // Draw hidden dx
  const draw = rng.weightedPick(caseFile.hidden_dx_draw);

  const patient: Patient = {
    id: 'p1',
    caseRef: caseFile.id,
    hiddenDx: draw.dx,
    acuityTier: 0,
    vitalsCurrent: { ...caseFile.vitals_initial },
    room: caseFile.arrival.room,
    arrivedTurn: 0,
    dispoCommitted: null,
    outcomeText: null,
    examsPerformed: [],
    historyAsked: [],
    ordersPlaced: [],
    medsGiven: [],
  };

  const state: GameState = {
    caseId: caseFile.id,
    seed,
    rngCursor: rng.cursor(),
    shiftClockMin: 0,
    paused: false,
    patients: [patient],
    pendingOrders: [],
    resolvedOrders: [],
    facilityLoad: { ct: 0, mri: 0, xray: 0, lab: 0, ivPump: 0 },
    activeRoom: null,
    activePatientId: null,
    withinTurnBudget: DEFAULTS.withinTurnBudgetMax,
    turnIx: 0,
    log: [],
    defaults: { ...DEFAULTS },
  };

  return { state, cues: [], outcomes: [] };
}

export function applyEvent(
  prev: GameState,
  caseFile: CaseFile,
  ev: EngineEvent,
): EngineResult {
  // Always work on a deep clone so callers never mutate prior snapshots.
  const state = clone(prev);
  const rng = new Rng(state.seed);
  rng.setCursor(state.rngCursor);
  const cues: DmCue[] = [];
  const outcomes: string[] = [];

  if (ev.kind === 'load_case') {
    return newGame(ev.caseFile, ev.seed);
  }

  if (ev.kind === 'toggle_pause') {
    state.paused = !state.paused;
    state.rngCursor = rng.cursor();
    return { state, cues, outcomes };
  }

  if (state.paused) {
    return { state, cues, outcomes };
  }

  if (ev.kind === 'end_turn') {
    log(state, state.activePatientId, 'END_TURN');
    advanceTurn(state, caseFile, rng, cues);
    state.rngCursor = rng.cursor();
    return { state, cues, outcomes };
  }

  if (ev.kind === 'enter_room') {
    state.activeRoom = ev.roomId;
    state.activePatientId = ev.patientId;
    state.withinTurnBudget = state.defaults.withinTurnBudgetMax;
    log(state, ev.patientId, 'ENTER_ROOM', ev.roomId);
    state.rngCursor = rng.cursor();
    return { state, cues, outcomes };
  }

  const patient = state.patients.find((p) => p.id === state.activePatientId);
  if (!patient) {
    return { state, cues, outcomes };
  }

  switch (ev.kind) {
    case 'ask_history': {
      const item = caseFile.history_items.find((h) => h.id === ev.itemId);
      const cost = item?.cost ?? 1;
      patient.historyAsked.push(ev.itemId);
      state.withinTurnBudget -= cost;
      log(state, patient.id, 'ASK_HISTORY', ev.itemId);
      cues.push({ kind: 'history', patientId: patient.id, itemId: ev.itemId });
      break;
    }
    case 'exam_region': {
      const region = caseFile.exam_regions.find((r) => r.id === ev.regionId);
      const cost = region?.cost ?? 2;
      patient.examsPerformed.push(ev.regionId);
      state.withinTurnBudget -= cost;
      log(state, patient.id, 'EXAM_REGION', ev.regionId);
      cues.push({ kind: 'exam', patientId: patient.id, regionId: ev.regionId });
      break;
    }
    case 'place_order': {
      const cat = caseFile.orders_available.find((o) => o.order_id === ev.orderId);
      if (!cat) break;
      // Gating: after_order must already exist for this patient if specified
      if (cat.after_order && !patient.ordersPlaced.includes(cat.after_order)) {
        log(state, patient.id, 'PLACE_ORDER_BLOCKED', ev.orderId);
        break;
      }
      const facilityKey = facilityForOrder(ev.orderId);
      const queueDepth = facilityKey ? state.facilityLoad[facilityKey] : 0;
      const effectiveMinutes =
        cat.base_minutes * (1 + queueDepth * state.defaults.loadFactor);
      const turnsToResolve = Math.max(1, Math.round(effectiveMinutes / state.defaults.turnTickMinutes));
      const order: PendingOrder = {
        orderId: ev.orderId,
        patientId: patient.id,
        placedTurn: state.turnIx,
        resolvesTurn: state.turnIx + turnsToResolve,
      };
      state.pendingOrders.push(order);
      patient.ordersPlaced.push(ev.orderId);
      if (facilityKey) state.facilityLoad[facilityKey] += 1;
      state.withinTurnBudget -= 1;
      log(state, patient.id, 'PLACE_ORDER', ev.orderId);
      cues.push({
        kind: 'order_placed',
        patientId: patient.id,
        orderId: ev.orderId,
        resolvesTurn: order.resolvesTurn,
      });
      break;
    }
    case 'give_med': {
      patient.medsGiven.push(ev.medId);
      state.withinTurnBudget -= 1;
      log(state, patient.id, 'GIVE_MED', ev.medId);
      break;
    }
    case 'commit_dispo': {
      patient.dispoCommitted = ev.dispo;
      const outcomeText = pickOutcome(caseFile, patient.hiddenDx, ev.dispo, patient.acuityTier);
      patient.outcomeText = outcomeText;
      outcomes.push(outcomeText);
      log(state, patient.id, 'COMMIT_DISPO', ev.dispo);
      // Dispo: clear focus AND advance time (patient leaves the bay).
      state.activeRoom = null;
      state.activePatientId = null;
      advanceTurn(state, caseFile, rng, cues);
      state.rngCursor = rng.cursor();
      return { state, cues, outcomes };
    }
    case 'exit_room': {
      log(state, patient.id, 'EXIT_ROOM');
      // Just leave the room; do NOT advance time.
      state.activeRoom = null;
      state.activePatientId = null;
      state.rngCursor = rng.cursor();
      return { state, cues, outcomes };
    }
  }

  // Budget exhausted: emit a cue but DO NOT auto-eject. The DM hits End turn explicitly.
  if (state.withinTurnBudget <= 0) {
    cues.push({ kind: 'budget_exhausted', patientId: patient.id });
  }

  state.rngCursor = rng.cursor();
  return { state, cues, outcomes };
}

// advanceTurn advances time, ticks vitals, resolves orders, refreshes budget.
// It does NOT clear activeRoom or activePatientId — caller decides whether to.
function advanceTurn(state: GameState, caseFile: CaseFile, rng: Rng, cues: DmCue[]): void {
  state.shiftClockMin += state.defaults.turnTickMinutes;
  state.turnIx += 1;
  state.withinTurnBudget = state.defaults.withinTurnBudgetMax;

  // Resolve pending orders whose resolvesTurn <= turnIx
  const stillPending: PendingOrder[] = [];
  for (const po of state.pendingOrders) {
    if (po.resolvesTurn <= state.turnIx) {
      const patient = state.patients.find((p) => p.id === po.patientId);
      if (!patient) continue;
      const cat = caseFile.orders_available.find((o) => o.order_id === po.orderId);
      const result = cat?.result_by_dx[patient.hiddenDx];
      if (result) {
        state.resolvedOrders.push({
          orderId: po.orderId,
          patientId: po.patientId,
          resolvedTurn: state.turnIx,
          resultText: result.text,
          resultData: result.data,
        });
        cues.push({
          kind: 'order_result',
          patientId: po.patientId,
          orderId: po.orderId,
          text: result.text,
        });
      }
      // Decrement facility load for this resource
      const fk = facilityForOrder(po.orderId);
      if (fk && state.facilityLoad[fk] > 0) state.facilityLoad[fk] -= 1;
    } else {
      stillPending.push(po);
    }
  }
  state.pendingOrders = stillPending;

  // Tick patients: advance acuity tier per drift probabilities and update vitals
  for (const patient of state.patients) {
    if (patient.dispoCommitted) continue;
    const trajByTier = caseFile.vitals_trajectory[patient.hiddenDx];
    if (!trajByTier) continue;
    const tierKey = `tier_${patient.acuityTier}`;
    const trajectory = trajByTier[tierKey];
    if (!trajectory) continue;

    // Apply vital deltas for this turn
    applyVitalDeltas(patient.vitalsCurrent, trajectory);

    // Probabilistic drift to next tier
    const driftKey = `drift_to_tier_${patient.acuityTier + 1}_per_turn` as const;
    const driftP = (trajectory as Record<string, number | undefined>)[driftKey];
    if (driftP && rng.chance(driftP)) {
      const from = patient.acuityTier;
      patient.acuityTier = Math.min(3, patient.acuityTier + 1);
      cues.push({ kind: 'tier_change', patientId: patient.id, from, to: patient.acuityTier });
    }
  }
}

function applyVitalDeltas(v: Vitals, t: TierTrajectory): void {
  if (t.hr_delta) v.hr = clamp(v.hr + t.hr_delta, 30, 220);
  if (t.sbp_delta) v.sbp = clamp(v.sbp + t.sbp_delta, 50, 240);
  if (t.dbp_delta) v.dbp = clamp(v.dbp + t.dbp_delta, 30, 140);
  if (t.rr_delta) v.rr = clamp(v.rr + t.rr_delta, 6, 60);
  if (t.spo2_delta) v.spo2 = clamp(v.spo2 + t.spo2_delta, 60, 100);
  if (t.temp_delta) v.tempC = clamp(v.tempC + t.temp_delta, 33, 42);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function facilityForOrder(orderId: string): keyof GameState['facilityLoad'] | null {
  if (orderId.startsWith('ct_')) return 'ct';
  if (orderId.startsWith('mri_')) return 'mri';
  if (orderId.startsWith('xray_') || orderId === 'cxr') return 'xray';
  if (orderId.startsWith('iv_') || orderId === 'ivf_ns_bolus') return 'ivPump';
  // Default: lab. Covers cbc, bmp, troponin*, ua, etc.
  return 'lab';
}

function pickOutcome(
  caseFile: CaseFile,
  dx: string,
  dispo: Disposition,
  tier: number,
): string {
  const byDx = caseFile.dispo_outcomes[dx];
  if (!byDx) return 'Outcome not authored.';
  const byDispo = byDx[dispo];
  if (!byDispo) return `Outcome for ${dispo} not authored for ${dx}.`;
  // Walk down from current tier to tier_0 to find the most specific text
  for (let t = tier; t >= 0; t--) {
    const text = byDispo[`tier_${t}`];
    if (text) return text;
  }
  return Object.values(byDispo)[0] ?? 'Outcome not authored.';
}

function log(state: GameState, patientId: string | null, action: string, detail?: string): void {
  const entry: { turn: number; shiftClockMin: number; patientId: string | null; action: string; detail?: string } = {
    turn: state.turnIx,
    shiftClockMin: state.shiftClockMin,
    patientId,
    action,
  };
  if (detail !== undefined) entry.detail = detail;
  state.log.push(entry);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

// Snapshot ring buffer — used by the rewind UI later. For v1 we just expose the API.
export class SnapshotBuffer {
  private buf: GameState[] = [];
  constructor(private depth = 30) {}
  push(s: GameState) {
    this.buf.push(clone(s));
    while (this.buf.length > this.depth) this.buf.shift();
  }
  at(turnIx: number): GameState | null {
    return this.buf.find((s) => s.turnIx === turnIx) ?? null;
  }
  latest(): GameState | null {
    return this.buf[this.buf.length - 1] ?? null;
  }
}
