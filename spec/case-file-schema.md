# Case-File Schema — v1

Each case is one YAML file in `/cases/`. The build step bundles them into `public/cases.json` for the SPA to fetch. The schema is validated at load time (Pydantic-style at the engine boundary).

## Top-level

```yaml
id: chest_pain_palpitations         # required, unique
title: Chest Pain and Palpitations  # required
version: 1                          # required
kind: complex                       # complex | mook
chief_complaint: "Sudden palpitations and chest tightness"
demographics:
  age: 54
  sex: F
  pmh: ["HTN (lisinopril)"]
  meds: ["lisinopril"]
  allergies: ["NKDA"]
arrival:
  room: bay_3                       # which floor-plan room
  arrival_turn: 0                   # placed at game start

hidden_dx_draw:                     # weighted draw at patient creation
  - dx: afib_with_nstemi
    weight: 70
  - dx: afib_alone
    weight: 30

vitals_initial:
  hr: 162
  sbp: 118
  dbp: 74
  rr: 18
  spo2: 97
  tempC: 36.8

vitals_trajectory:                  # per-dx, per-acuity-tier
  afib_with_nstemi:
    tier_0:
      hr_delta: 0
      sbp_delta: 0
      drift_to_tier_1_per_turn: 0.15
    tier_1:
      hr_delta: -10                 # rate-controls a bit on its own
      sbp_delta: -2
      drift_to_tier_2_per_turn: 0.10
    tier_2:
      hr_delta: -5
      sbp_delta: -8
      drift_to_tier_3_per_turn: 0.20
    tier_3:
      hr_delta: 0
      sbp_delta: -15
      drift_to_tier_3_per_turn: 0   # terminal tier
  afib_alone:
    tier_0:
      hr_delta: -2
      drift_to_tier_1_per_turn: 0.05
    # ...

deterioration_triggers:             # action-driven changes (per-dx)
  afib_with_nstemi:
    advance_tier_on:
      - condition: time_in_bay_min >= 60 and order_count('troponin') == 0
        delta: 1
      - condition: dispo == 'DISCHARGE_HOME' and tier < 2
        delta: 2                    # off-stage — patient comes back to ED
    hold_tier_on:
      - condition: gave_med('metoprolol') and gave_med('aspirin')
        effect: hold

orders_available:                   # which orders surface useful info for this case
  - order_id: ecg_12_lead
    base_minutes: 5
    result_by_dx:
      afib_with_nstemi:
        text: "Atrial fibrillation with rapid ventricular response, rate ~160. ST depressions noted in II, III, aVF."
        data: { rhythm: afib_rvr, rate: 160, st_changes: true }
      afib_alone:
        text: "Atrial fibrillation with rapid ventricular response, rate ~160. No acute ST-T changes."
        data: { rhythm: afib_rvr, rate: 160, st_changes: false }
  - order_id: troponin_initial
    base_minutes: 30
    result_by_dx:
      afib_with_nstemi:
        text: "Troponin I: 0.04 ng/mL (borderline — single timepoint)."
        data: { trop: 0.04 }
      afib_alone:
        text: "Troponin I: <0.01 ng/mL (negative)."
        data: { trop: 0.005 }
  - order_id: troponin_repeat
    base_minutes: 120
    after_order: troponin_initial   # gated — must order initial first
    result_by_dx:
      afib_with_nstemi:
        text: "Troponin I (repeat at 2h): 0.18 ng/mL — rising."
        data: { trop: 0.18, delta: positive }
      afib_alone:
        text: "Troponin I (repeat): <0.01 ng/mL."
        data: { trop: 0.005 }
  # ...

history_items:                      # what the player can ask; DM voices answers per packet
  - id: hpi_onset
    label: "Onset and timing"
    cost: 1
  - id: hpi_quality
    label: "Pain quality / radiation"
    cost: 1
  - id: pmh_cardiac
    label: "Prior cardiac history"
    cost: 1
  - id: meds
    label: "Current medications"
    cost: 1
  - id: family_hx
    label: "Family cardiac history"
    cost: 1
  - id: social_hx
    label: "Tobacco / EtOH / drugs"
    cost: 1

exam_regions:                        # what the player can examine; DM voices findings per packet
  - id: general
    label: "General appearance"
    cost: 2
  - id: cardiac
    label: "Cardiac auscultation"
    cost: 2
  - id: lungs
    label: "Pulmonary exam"
    cost: 2
  - id: vascular
    label: "Peripheral vascular / pulses"
    cost: 2

dispo_outcomes:                       # outcome text by (hidden_dx, dispo, acuity_tier)
  afib_with_nstemi:
    DISCHARGE_HOME:
      tier_0: "She presents to the ED that evening with worsening chest pain. Posterior NSTEMI identified; cath next morning. Recovers fully. The cardiologist's note references your earlier ST changes."
      tier_1: "She returns by EMS within 4 hours. Posterior NSTEMI confirmed. Recovers fully but the time-to-cath was longer than ideal."
      tier_2: "She arrests in the parking lot. ROSC achieved by EMS. Survives with mild anoxic injury."
    TRANSFER_ED:
      tier_0: "Transferred stably. Posterior NSTEMI identified on repeat ECG. Cath the next morning. Recovers fully. Your clinical instinct was sound."
      tier_1: "Transferred stably. Posterior NSTEMI. Cath same day. Recovers fully."
      tier_2: "Transferred urgently. Cath within 2 hours. Recovers fully. Timing was tight."
    OBSERVE:
      tier_0: "Continued monitoring in your bay. ST changes evolve over the next hour. You ultimately transfer. NSTEMI confirmed; cath next morning. Recovers fully."
  afib_alone:
    DISCHARGE_HOME:
      tier_0: "She follows up with cardiology next week. Rate-controlled on a beta-blocker. Anticoagulation initiated. Does well."
    TRANSFER_ED:
      tier_0: "Admitted for telemetry. Rate-controlled, anticoagulated. Discharged the next day. Likely could have been managed outpatient."
```

## DM packet (separate file)

`/cases/dm-packets/<case_id>.md` — a Markdown file you (the DM) read before the session. Holds the things the YAML doesn't: how the patient sounds, what they say when asked about the kids waiting at home, what the chest tightness "feels like." See [`/cases/dm-packets/example.md`](../cases/dm-packets/example.md) for shape.

## Validation rules (engine-enforced at load)

- `id` matches the YAML filename
- All `hidden_dx_draw` keys appear as keys in `vitals_trajectory`, `orders_available[*].result_by_dx`, and `dispo_outcomes`
- `vitals_initial` is a complete `Vitals` object
- All `orders_available[*].order_id` exist in the global order catalog (defined in `cases/_orders.yaml`)
- `dispo_outcomes` covers at least `DISCHARGE_HOME` and `TRANSFER_ED` for every dx; tier_0 minimum

## What goes in the YAML vs. the DM packet

| In the YAML | In the DM packet |
|---|---|
| Vitals (objective) | Patient's mood, demeanor, language |
| Lab/imaging results (objective) | What the patient says when you ask about onset |
| Deterioration timing rules | Exam findings to voice per region (per dx) |
| Hidden dx draw weights | "Hooks" — moments that should color the role-play |
| Dispo outcome text (objective resolution) | Family/bystander dialogue if relevant |
| Order resolution times | Triage hints (what should make a careful provider suspicious) |
