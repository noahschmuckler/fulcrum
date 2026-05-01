// Engine types — see /spec/rules-engine.md

export type Vitals = {
  hr: number;
  sbp: number;
  dbp: number;
  rr: number;
  spo2: number;
  tempC: number;
};

export type Disposition =
  | 'DISCHARGE_HOME'
  | 'TRANSFER_ED'
  | 'REFER_PCP'
  | 'REFER_SPECIALIST'
  | 'OBSERVE';

export type Patient = {
  id: string;
  caseRef: string;
  hiddenDx: string;
  acuityTier: number; // 0 = stable, 1 = drifting, 2 = deteriorating, 3 = critical
  vitalsCurrent: Vitals;
  room: string;
  arrivedTurn: number;
  dispoCommitted: Disposition | null;
  outcomeText: string | null;
  examsPerformed: string[];
  historyAsked: string[];
  ordersPlaced: string[];
  medsGiven: string[];
};

export type PendingOrder = {
  orderId: string;
  patientId: string;
  placedTurn: number;
  resolvesTurn: number;
};

export type ResolvedOrder = {
  orderId: string;
  patientId: string;
  resolvedTurn: number;
  resultText: string;
  resultData: Record<string, unknown>;
};

export type FacilityLoad = {
  ct: number;
  mri: number;
  xray: number;
  lab: number;
  ivPump: number;
};

export type ActionLogEntry = {
  turn: number;
  shiftClockMin: number;
  patientId: string | null;
  action: string;
  detail?: string;
};

export type GameState = {
  caseId: string; // first / lead-in case id, kept for ref
  seed: number;
  rngCursor: number;
  shiftClockMin: number;
  paused: boolean;
  patients: Patient[];
  patientQueue: string[]; // case_ids waiting to arrive
  nextArrivalTurn: number;
  patientCounter: number; // monotonic id source
  pendingOrders: PendingOrder[];
  resolvedOrders: ResolvedOrder[];
  facilityLoad: FacilityLoad;
  activeRoom: string | null;
  activePatientId: string | null;
  withinTurnBudget: number;
  turnIx: number;
  log: ActionLogEntry[];
  defaults: {
    turnTickMinutes: number;
    withinTurnBudgetMax: number;
    loadFactor: number;
    arrivalEveryTurns: number;
    maxActivePatients: number;
    bayPool: string[];
  };
};

// ---- Case-file types (the YAML shape) ----

export type CaseFile = {
  id: string;
  title: string;
  version: number;
  kind: 'complex' | 'mook';
  chief_complaint: string;
  demographics: {
    age: number;
    sex: 'M' | 'F';
    pmh: string[];
    meds: string[];
    allergies: string[];
  };
  arrival: { room: string; arrival_turn: number };
  hidden_dx_draw: { dx: string; weight: number }[];
  vitals_initial: Vitals;
  vitals_trajectory: Record<string, Record<string, TierTrajectory>>; // dx -> tier_N -> trajectory
  deterioration_triggers?: Record<string, DeteriorationRules>;
  orders_available: OrderAvailability[];
  history_items: { id: string; label: string; cost: number }[];
  exam_regions: { id: string; label: string; cost: number }[];
  dispo_outcomes: Record<string, Record<string, Record<string, string>>>; // dx -> dispo -> tier_N -> text
};

export type TierTrajectory = {
  hr_delta?: number;
  sbp_delta?: number;
  dbp_delta?: number;
  rr_delta?: number;
  spo2_delta?: number;
  temp_delta?: number;
  drift_to_tier_1_per_turn?: number;
  drift_to_tier_2_per_turn?: number;
  drift_to_tier_3_per_turn?: number;
};

export type DeteriorationRules = {
  advance_tier_on?: { condition: string; delta: number }[];
  hold_tier_on?: { condition: string; effect: 'hold' }[];
};

export type OrderAvailability = {
  order_id: string;
  base_minutes: number;
  after_order?: string;
  result_by_dx: Record<string, { text: string; data: Record<string, unknown> }>;
};
