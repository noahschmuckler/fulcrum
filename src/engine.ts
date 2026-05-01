// Fulcrum rules engine. Pure, deterministic given (seed, action sequence).
// Multi-patient: engine sees the full case pool; each patient carries a caseRef.

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
  | {
      kind: 'load_case';
      caseFile: CaseFile;
      allCases: Record<string, CaseFile>;
      seed: number;
    };

export type EngineResult = {
  state: GameState;
  cues: DmCue[];
  outcomes: string[];
};

export type DmCue =
  | { kind: 'history'; patientId: string; itemId: string }
  | { kind: 'exam'; patientId: string; regionId: string }
  | { kind: 'order_placed'; patientId: string; orderId: string; resolvesTurn: number }
  | { kind: 'order_result'; patientId: string; orderId: string; text: string }
  | { kind: 'tier_change'; patientId: string; from: number; to: number }
  | { kind: 'budget_exhausted'; patientId: string }
  | { kind: 'arrival'; patientId: string; room: string; caseRef: string }
  | { kind: 'shift_end' };

const DEFAULTS = {
  turnTickMinutes: 5,
  withinTurnBudgetMax: 10,
  loadFactor: 0.25,
  arrivalEveryTurns: 4, // 20 in-game minutes between arrivals = ~3/hr
  maxActivePatients: 3,
  bayPool: ['bay_1', 'bay_2', 'bay_3', 'bay_4', 'bay_5', 'bay_6'],
};

const SHIFT_END_TURN = 144; // 720 in-game min ÷ 5 min/turn = 144 turns (12-hour shift)

export function newGame(
  firstCase: CaseFile,
  allCases: Record<string, CaseFile>,
  seed: number,
): EngineResult {
  const rng = new Rng(seed);

  // Place the lead-in patient.
  const firstRoom = firstCase.arrival.room || DEFAULTS.bayPool[0]!;
  const firstPatient = createPatientFromCase(firstCase, rng, 'p1', firstRoom, 0);

  // Build a shuffled queue of every other authored case so the shift has a
  // reasonable mix. Cap the queue depth so a long shift doesn't run out.
  const otherIds = Object.keys(allCases).filter((id) => id !== firstCase.id);
  const queue = shuffle(otherIds, rng);

  const state: GameState = {
    caseId: firstCase.id,
    seed,
    rngCursor: rng.cursor(),
    shiftClockMin: 0,
    paused: false,
    patients: [firstPatient],
    patientQueue: queue,
    nextArrivalTurn: DEFAULTS.arrivalEveryTurns, // first new arrival at 7:50 AM
    patientCounter: 1,
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

  const cues: DmCue[] = [{ kind: 'arrival', patientId: firstPatient.id, room: firstPatient.room, caseRef: firstCase.id }];
  return { state, cues, outcomes: [] };
}

function createPatientFromCase(
  caseFile: CaseFile,
  rng: Rng,
  id: string,
  room: string,
  arrivedTurn: number,
): Patient {
  const draw = rng.weightedPick(caseFile.hidden_dx_draw);
  return {
    id,
    caseRef: caseFile.id,
    hiddenDx: draw.dx,
    acuityTier: 0,
    vitalsCurrent: { ...caseFile.vitals_initial },
    room,
    arrivedTurn,
    dispoCommitted: null,
    outcomeText: null,
    examsPerformed: [],
    historyAsked: [],
    ordersPlaced: [],
    medsGiven: [],
  };
}

export function applyEvent(
  prev: GameState,
  allCases: Record<string, CaseFile>,
  ev: EngineEvent,
): EngineResult {
  // Always work on a deep clone so callers never mutate prior snapshots.
  const state = clone(prev);
  const rng = new Rng(state.seed);
  rng.setCursor(state.rngCursor);
  const cues: DmCue[] = [];
  const outcomes: string[] = [];

  if (ev.kind === 'load_case') {
    return newGame(ev.caseFile, ev.allCases, ev.seed);
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
    advanceTurn(state, allCases, rng, cues);
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
  const caseFile = allCases[patient.caseRef];
  if (!caseFile) {
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
      if (cat.after_order && !patient.ordersPlaced.includes(cat.after_order)) {
        log(state, patient.id, 'PLACE_ORDER_BLOCKED', ev.orderId);
        break;
      }
      const facilityKey = facilityForOrder(ev.orderId);
      const queueDepth = facilityKey ? state.facilityLoad[facilityKey] : 0;
      const effectiveMinutes = cat.base_minutes * (1 + queueDepth * state.defaults.loadFactor);
      const turnsToResolve = Math.max(
        1,
        Math.round(effectiveMinutes / state.defaults.turnTickMinutes),
      );
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
      state.activeRoom = null;
      state.activePatientId = null;
      advanceTurn(state, allCases, rng, cues);
      state.rngCursor = rng.cursor();
      return { state, cues, outcomes };
    }
    case 'exit_room': {
      log(state, patient.id, 'EXIT_ROOM');
      state.activeRoom = null;
      state.activePatientId = null;
      state.rngCursor = rng.cursor();
      return { state, cues, outcomes };
    }
  }

  if (state.withinTurnBudget <= 0) {
    cues.push({ kind: 'budget_exhausted', patientId: patient.id });
  }

  state.rngCursor = rng.cursor();
  return { state, cues, outcomes };
}

function advanceTurn(
  state: GameState,
  allCases: Record<string, CaseFile>,
  rng: Rng,
  cues: DmCue[],
): void {
  state.shiftClockMin += state.defaults.turnTickMinutes;
  state.turnIx += 1;
  state.withinTurnBudget = state.defaults.withinTurnBudgetMax;

  // Resolve pending orders due this turn.
  const stillPending: PendingOrder[] = [];
  for (const po of state.pendingOrders) {
    if (po.resolvesTurn <= state.turnIx) {
      const patient = state.patients.find((p) => p.id === po.patientId);
      if (!patient) continue;
      const cf = allCases[patient.caseRef];
      const cat = cf?.orders_available.find((o) => o.order_id === po.orderId);
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
      const fk = facilityForOrder(po.orderId);
      if (fk && state.facilityLoad[fk] > 0) state.facilityLoad[fk] -= 1;
    } else {
      stillPending.push(po);
    }
  }
  state.pendingOrders = stillPending;

  // Tick each active patient: vitals delta + probabilistic tier drift.
  for (const patient of state.patients) {
    if (patient.dispoCommitted) continue;
    const cf = allCases[patient.caseRef];
    if (!cf) continue;
    const trajByTier = cf.vitals_trajectory[patient.hiddenDx];
    if (!trajByTier) continue;
    const trajectory = trajByTier[`tier_${patient.acuityTier}`];
    if (!trajectory) continue;

    applyVitalDeltas(patient.vitalsCurrent, trajectory);

    const driftKey = `drift_to_tier_${patient.acuityTier + 1}_per_turn` as const;
    const driftP = (trajectory as Record<string, number | undefined>)[driftKey];
    if (driftP && rng.chance(driftP)) {
      const from = patient.acuityTier;
      patient.acuityTier = Math.min(3, patient.acuityTier + 1);
      cues.push({ kind: 'tier_change', patientId: patient.id, from, to: patient.acuityTier });
    }
  }

  // Patient arrivals — at or after nextArrivalTurn, place into a free bay if cap allows.
  if (state.turnIx >= state.nextArrivalTurn) {
    const active = state.patients.filter((p) => !p.dispoCommitted);
    const occupied = new Set(active.map((p) => p.room));
    const freeBay = state.defaults.bayPool.find((b) => !occupied.has(b));
    if (
      active.length < state.defaults.maxActivePatients &&
      freeBay &&
      state.patientQueue.length > 0 &&
      state.shiftClockMin < 720
    ) {
      const nextId = state.patientQueue.shift();
      if (nextId) {
        const cf = allCases[nextId];
        if (cf) {
          state.patientCounter += 1;
          const patientId = `p${state.patientCounter}`;
          const newPatient = createPatientFromCase(cf, rng, patientId, freeBay, state.turnIx);
          state.patients.push(newPatient);
          cues.push({
            kind: 'arrival',
            patientId,
            room: freeBay,
            caseRef: cf.id,
          });
        }
      }
    }
    state.nextArrivalTurn = state.turnIx + state.defaults.arrivalEveryTurns;
  }

  if (state.turnIx === SHIFT_END_TURN) {
    cues.push({ kind: 'shift_end' });
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
  for (let t = tier; t >= 0; t--) {
    const text = byDispo[`tier_${t}`];
    if (text) return text;
  }
  return Object.values(byDispo)[0] ?? 'Outcome not authored.';
}

function log(
  state: GameState,
  patientId: string | null,
  action: string,
  detail?: string,
): void {
  const entry: {
    turn: number;
    shiftClockMin: number;
    patientId: string | null;
    action: string;
    detail?: string;
  } = {
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

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

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
