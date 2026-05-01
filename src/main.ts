// Fulcrum SPA entry. Glues engine → UI.

import {
  applyEvent,
  newGame,
  SnapshotBuffer,
  type EngineEvent,
  type DmCue,
} from './engine.js';
import type { CaseFile, GameState, Patient, Vitals } from './types.js';

type CasesPayload = { cases: Record<string, CaseFile>; builtAt: string };

const TURN_SECONDS = 90;

// ---- App state ----

let cases: Record<string, CaseFile> = {};
let currentCaseId: string | null = null;
let state: GameState | null = null;
let snapshots = new SnapshotBuffer(30);
let dmCues: { tag: string; text: string; turn: number }[] = [];
let turnTimerHandle: number | null = null;
let turnSecondsRemaining = TURN_SECONDS;
let activeTab: 'history' | 'exam' | 'orders' | 'meds' | 'dispo' = 'history';

// ---- Bootstrap ----

const startup = async () => {
  const resp = await fetch('/cases.json', { cache: 'no-store' });
  const payload = (await resp.json()) as CasesPayload;
  cases = payload.cases;
  populateCaseSelect();
  bindGlobalEvents();
  // Auto-start with the first case so the demo lands on something playable.
  const firstId = Object.keys(cases)[0];
  if (firstId) {
    currentCaseId = firstId;
    (document.getElementById('case-select') as HTMLSelectElement).value = firstId;
    startNewGame();
  }
};
startup().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="padding:16px;color:#b91c1c">Failed to load: ${String(err)}</pre>`,
  );
});

// ---- Case picker ----

function populateCaseSelect() {
  const sel = document.getElementById('case-select') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const c of Object.values(cases).sort((a, b) => a.title.localeCompare(b.title))) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.title}${c.kind === 'mook' ? ' · simple' : ''}`;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    currentCaseId = sel.value;
  });
}

// ---- Global events ----

function bindGlobalEvents() {
  document.getElementById('new-game')!.addEventListener('click', startNewGame);
  document.getElementById('pause-btn')!.addEventListener('click', togglePause);
  document.getElementById('exit-room')!.addEventListener('click', () => dispatch({ kind: 'exit_room' }));
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as typeof activeTab;
      if (!tab) return;
      activeTab = tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
      document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => {
        p.hidden = p.id !== `pane-${tab}`;
      });
      renderRoom();
    });
  });
  document.getElementById('outcome-close')!.addEventListener('click', () => {
    (document.getElementById('outcome-dialog') as HTMLDialogElement).close();
  });
  document.getElementById('library-btn')!.addEventListener('click', openLibrary);
  document.getElementById('library-close')!.addEventListener('click', () => {
    (document.getElementById('library-dialog') as HTMLDialogElement).close();
  });
  document.getElementById('lib-download-all')!.addEventListener('click', downloadLibraryBundle);
}

// ---- Library ----

type LibraryManifest = {
  builtAt: string;
  cases: { file: string; path: string; title: string; kind: string }[];
  dmPackets: { file: string; path: string }[];
  specs: { file: string; path: string }[];
};

let libraryCache: LibraryManifest | null = null;

async function loadLibrary(): Promise<LibraryManifest> {
  if (libraryCache) return libraryCache;
  const resp = await fetch('/library.json', { cache: 'no-store' });
  libraryCache = (await resp.json()) as LibraryManifest;
  return libraryCache;
}

async function openLibrary() {
  const lib = await loadLibrary();
  const packetsEl = document.getElementById('lib-packets')!;
  const casesEl = document.getElementById('lib-cases')!;
  const specsEl = document.getElementById('lib-specs')!;

  // DM packets: try to match a case by basename for the title hint
  const titleByFile = new Map<string, string>();
  for (const c of lib.cases) {
    const base = c.file.replace(/\.ya?ml$/, '');
    titleByFile.set(`${base}.md`, c.title);
  }

  packetsEl.innerHTML = lib.dmPackets
    .map(
      (p) => `
      <div class="lib-row">
        <span class="lib-name">${escape(p.file)}</span>
        <span class="lib-title">${escape(titleByFile.get(p.file) ?? '')}</span>
        <span class="lib-actions">
          <a href="${escape(p.path)}" target="_blank" rel="noopener">view</a>
          <a href="${escape(p.path)}" download="${escape(p.file)}">download</a>
        </span>
      </div>`,
    )
    .join('');

  casesEl.innerHTML = lib.cases
    .map(
      (c) => `
      <div class="lib-row">
        <span class="lib-name">${escape(c.file)}</span>
        <span class="lib-title">${escape(c.title)}</span>
        <span class="lib-kind ${escape(c.kind)}">${escape(c.kind)}</span>
        <span class="lib-actions">
          <a href="${escape(c.path)}" target="_blank" rel="noopener">view</a>
          <a href="${escape(c.path)}" download="${escape(c.file)}">download</a>
        </span>
      </div>`,
    )
    .join('');

  specsEl.innerHTML = lib.specs
    .map(
      (s) => `
      <div class="lib-row">
        <span class="lib-name">${escape(s.file)}</span>
        <span class="lib-actions">
          <a href="${escape(s.path)}" target="_blank" rel="noopener">view</a>
          <a href="${escape(s.path)}" download="${escape(s.file)}">download</a>
        </span>
      </div>`,
    )
    .join('');

  const dlg = document.getElementById('library-dialog') as HTMLDialogElement;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

async function downloadLibraryBundle() {
  const lib = await loadLibrary();
  // Build a single self-contained Markdown document with all cases + packets + specs.
  // Markdown is the most readable single-file format; opens in any text/markdown viewer.
  const parts: string[] = [];
  parts.push('# Fulcrum library — full bundle');
  parts.push(`Built: ${lib.builtAt}`);
  parts.push('\nThis is every authored case, DM packet, and spec document concatenated into a single readable file. Section headings let you skim or search.');

  parts.push('\n\n---\n\n# Specs\n');
  for (const s of lib.specs) {
    const txt = await (await fetch(s.path)).text();
    parts.push(`\n\n## spec/${s.file}\n\n${txt}\n`);
  }

  parts.push('\n\n---\n\n# DM packets\n');
  for (const p of lib.dmPackets) {
    const txt = await (await fetch(p.path)).text();
    parts.push(`\n\n## cases/dm-packets/${p.file}\n\n${txt}\n`);
  }

  parts.push('\n\n---\n\n# Cases (YAML)\n');
  for (const c of lib.cases) {
    const txt = await (await fetch(c.path)).text();
    parts.push(`\n\n## cases/${c.file}\n\n\`\`\`yaml\n${txt}\n\`\`\`\n`);
  }

  const blob = new Blob([parts.join('')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fulcrum-library-${lib.builtAt.slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function startNewGame() {
  if (!currentCaseId) return;
  const caseFile = cases[currentCaseId];
  if (!caseFile) return;
  const seed = (Date.now() ^ Math.floor(Math.random() * 1_000_000)) >>> 0;
  const result = newGame(caseFile, seed);
  state = result.state;
  snapshots = new SnapshotBuffer(30);
  snapshots.push(state);
  dmCues = [];
  pushCues(result.cues);
  resetTurnTimer();
  renderAll();
}

// ---- Engine dispatch ----

function dispatch(ev: EngineEvent) {
  if (!state || !currentCaseId) return;
  const caseFile = cases[currentCaseId];
  if (!caseFile) return;
  const result = applyEvent(state, caseFile, ev);
  state = result.state;
  pushCues(result.cues);
  if (result.outcomes.length > 0) {
    showOutcome(result.outcomes.join('\n\n'));
  }
  // After a turn-ending event the active room becomes null. Reset turn timer.
  if (state.activeRoom === null && (ev.kind === 'commit_dispo' || ev.kind === 'exit_room')) {
    snapshots.push(state);
    resetTurnTimer();
  }
  renderAll();
}

function pushCues(cues: DmCue[]) {
  if (!state) return;
  for (const c of cues) {
    let tag: string = c.kind;
    let text = '';
    const patient = state.patients.find((p) => p.id === c.patientId);
    const caseFile = currentCaseId ? cases[currentCaseId] : null;
    switch (c.kind) {
      case 'history': {
        const item = caseFile?.history_items.find((h) => h.id === c.itemId);
        text = `Voice the patient's answer to: "${item?.label ?? c.itemId}"`;
        tag = 'DM';
        break;
      }
      case 'exam': {
        const region = caseFile?.exam_regions.find((r) => r.id === c.regionId);
        text = `Voice the exam finding for: ${region?.label ?? c.regionId}`;
        tag = 'DM';
        break;
      }
      case 'order_placed': {
        text = `Order placed: ${c.orderId} (resolves at turn ${c.resolvesTurn})`;
        tag = 'order';
        break;
      }
      case 'order_result': {
        text = `Result: ${c.orderId} → ${c.text}`;
        tag = 'result';
        break;
      }
      case 'tier_change': {
        text = `Patient ${patient?.id ?? c.patientId}: manifest tier ${c.from} → ${c.to}`;
        tag = 'tier';
        break;
      }
      case 'budget_exhausted': {
        text = `Time in room exhausted — turn ends.`;
        tag = 'time';
        break;
      }
    }
    dmCues.unshift({ tag, text, turn: state.turnIx });
  }
  if (dmCues.length > 60) dmCues.length = 60;
}

// ---- Wall-clock turn timer ----

function resetTurnTimer() {
  turnSecondsRemaining = TURN_SECONDS;
  if (turnTimerHandle !== null) clearInterval(turnTimerHandle);
  turnTimerHandle = window.setInterval(() => {
    if (!state || state.paused) return;
    if (state.activeRoom === null) return; // only run while a player is on the floor
    turnSecondsRemaining = Math.max(0, turnSecondsRemaining - 1);
    renderTopbar();
    if (turnSecondsRemaining === 0) {
      // Soft expiry — just visual; DM keeps the floor moving manually
      // Could auto-exit in v1.5
    }
  }, 1000);
}

function togglePause() {
  if (!state) return;
  dispatch({ kind: 'toggle_pause' });
}

// ---- Render ----

function renderAll() {
  renderTopbar();
  renderFloor();
  renderRoom();
  renderInbox();
  renderCues();
}

function renderTopbar() {
  if (!state) return;
  const sc = document.getElementById('shift-clock')!;
  const mins = state.shiftClockMin;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  sc.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  document.getElementById('turn-timer')!.textContent = String(turnSecondsRemaining);
  const pb = document.getElementById('pause-btn')!;
  pb.textContent = state.paused ? 'Resume' : 'Pause';
  pb.classList.toggle('paused', state.paused);
}

function renderFloor() {
  if (!state) return;
  const svg = document.getElementById('floor-svg')!;
  // Static layout. Rooms placed on a deliberate floor-plan grid.
  const rooms = [
    { id: 'waiting_room', x: 200, y: 16, w: 200, h: 56, label: 'Waiting room', occupants: 'queue' },
    { id: 'front_desk',   x: 200, y: 84, w: 200, h: 36, label: 'Front desk' },
    { id: 'workstation',  x: 220, y: 196, w: 160, h: 88, label: 'Workstation' },
    { id: 'bay_1',        x: 16,  y: 100, w: 160, h: 80, label: 'Bay 1', occupant: true },
    { id: 'bay_2',        x: 16,  y: 196, w: 160, h: 80, label: 'Bay 2', occupant: true },
    { id: 'bay_3',        x: 16,  y: 292, w: 160, h: 80, label: 'Bay 3', occupant: true },
    { id: 'bay_4',        x: 424, y: 100, w: 160, h: 80, label: 'Bay 4', occupant: true },
    { id: 'bay_5',        x: 424, y: 196, w: 160, h: 80, label: 'Bay 5', occupant: true },
    { id: 'bay_6',        x: 424, y: 292, w: 160, h: 80, label: 'Bay 6', occupant: true },
    { id: 'radiology',    x: 200, y: 392, w: 90,  h: 72, label: 'Radiology', facility: 'ct' },
    { id: 'lab',          x: 296, y: 392, w: 90,  h: 72, label: 'Lab',       facility: 'lab' },
    { id: 'iv_pumps',     x: 392, y: 392, w: 100, h: 72, label: 'IV pumps',  facility: 'ivPump' },
  ];

  const patientsByRoom = new Map<string, Patient[]>();
  for (const p of state.patients) {
    if (p.dispoCommitted) continue;
    const arr = patientsByRoom.get(p.room) ?? [];
    arr.push(p);
    patientsByRoom.set(p.room, arr);
  }

  let html = '';
  for (const r of rooms) {
    const has = patientsByRoom.get(r.id) ?? [];
    const isActive = state.activeRoom === r.id;
    const cls = ['room-rect'];
    if (r.facility) cls.push('facility-rect');
    else {
      if (has.length > 0) cls.push('has-patient');
      if (isActive) cls.push('active');
    }
    const fill = r.facility ? '' : '';
    const cursor = r.occupant && has.length > 0 ? 'pointer' : (r.facility ? 'default' : 'pointer');
    html += `<g data-room="${r.id}" data-clickable="${r.occupant ? '1' : '0'}" style="cursor:${cursor}">`;
    html += `<rect class="${cls.join(' ')}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" />`;
    html += `<text class="${r.facility ? 'facility-label' : 'room-label'}" x="${r.x + 8}" y="${r.y + 16}">${r.label}</text>`;
    if (has.length > 0) {
      const p = has[0]!;
      html += `<text class="room-occupant" x="${r.x + 8}" y="${r.y + 32}">${escape(p.caseRef.replace(/_/g, ' '))}</text>`;
      // Tier bar
      const barY = r.y + r.h - 10;
      const fullW = r.w - 16;
      const tierW = ((p.manifestTier + 1) / 4) * fullW;
      html += `<line class="tier-bar t${p.manifestTier}" x1="${r.x + 8}" y1="${barY}" x2="${r.x + 8 + tierW}" y2="${barY}" />`;
    }
    if (r.facility) {
      const queue = state.facilityLoad[r.facility as keyof typeof state.facilityLoad];
      for (let i = 0; i < queue; i++) {
        html += `<circle class="queue-dot" cx="${r.x + 14 + i * 9}" cy="${r.y + r.h - 14}" r="3" />`;
      }
    }
    html += `</g>`;
  }
  svg.innerHTML = html;

  // Wire clicks
  svg.querySelectorAll<SVGGElement>('g[data-room]').forEach((g) => {
    if (g.dataset.clickable !== '1') return;
    g.addEventListener('click', () => {
      const roomId = g.dataset.room!;
      const occupants = patientsByRoom.get(roomId) ?? [];
      if (occupants.length === 0) return;
      const target = occupants[0]!;
      dispatch({ kind: 'enter_room', roomId, patientId: target.id });
    });
  });
}

function renderRoom() {
  if (!state || !currentCaseId) return;
  const caseFile = cases[currentCaseId];
  if (!caseFile) return;
  const room = state.activeRoom;
  const empty = document.getElementById('room-empty')!;
  const body = document.getElementById('room-body')!;
  if (!room || !state.activePatientId) {
    empty.hidden = false;
    body.hidden = true;
    document.getElementById('room-title')!.textContent = 'No room selected';
    return;
  }
  const activeId = state.activePatientId;
  const patient = state.patients.find((p) => p.id === activeId);
  if (!patient) return;

  empty.hidden = true;
  body.hidden = false;
  document.getElementById('room-title')!.textContent = roomLabel(room);
  document.getElementById('patient-name')!.textContent =
    `${caseFile.demographics.age}${caseFile.demographics.sex} · ${caseFile.title}`;
  document.getElementById('patient-cc')!.textContent = `Chief complaint: ${caseFile.chief_complaint}`;

  // Manifest fill
  const fill = document.getElementById('manifest-fill')!;
  const pct = ((patient.manifestTier + 1) / 4) * 100;
  fill.style.width = `${pct}%`;
  fill.className = `manifest-fill t${patient.manifestTier}`;

  renderVitals(patient.vitalsCurrent);
  renderBudget();
  renderActionPane(caseFile, patient);
}

function renderVitals(v: Vitals) {
  const box = document.getElementById('vitals-box')!;
  const items = [
    { lbl: 'HR', val: v.hr, unit: 'bpm', alert: v.hr > 110 || v.hr < 50, crit: v.hr > 140 || v.hr < 40 },
    { lbl: 'BP', val: `${Math.round(v.sbp)}/${Math.round(v.dbp)}`, unit: 'mmHg', alert: v.sbp < 100 || v.sbp > 160, crit: v.sbp < 90 },
    { lbl: 'RR', val: Math.round(v.rr), unit: '/min', alert: v.rr > 22 || v.rr < 10, crit: v.rr > 28 || v.rr < 8 },
    { lbl: 'SpO₂', val: `${Math.round(v.spo2)}%`, unit: '', alert: v.spo2 < 94, crit: v.spo2 < 90 },
    { lbl: 'Temp', val: v.tempC.toFixed(1), unit: '°C', alert: v.tempC >= 38 || v.tempC < 36, crit: v.tempC >= 39.5 || v.tempC < 35 },
    { lbl: 'Tier', val: `${0 + 1 * 0}`, unit: '', alert: false, crit: false },
  ];
  // Replace the placeholder Tier with manifest tier numeric for clarity (kept for symmetry).
  items[5] = { lbl: 'Tier', val: '—', unit: '', alert: false, crit: false };
  box.innerHTML = items
    .map((it) => {
      const cls = it.crit ? 'vital crit' : it.alert ? 'vital alert' : 'vital';
      return `<div class="${cls}"><span class="lbl">${it.lbl}</span><span class="val">${it.val}<small style="font-size:11px;color:var(--ink-muted);margin-left:3px">${it.unit}</small></span></div>`;
    })
    .join('');
}

function renderBudget() {
  if (!state) return;
  const max = state.defaults.withinTurnBudgetMax;
  const remaining = Math.max(0, state.withinTurnBudget);
  document.getElementById('budget-units')!.textContent = `${remaining} / ${max}`;
  const pct = (remaining / max) * 100;
  const bf = document.getElementById('budget-fill')!;
  bf.style.width = `${pct}%`;
  bf.style.background = remaining < 3 ? 'var(--bad)' : remaining < 5 ? 'var(--warn)' : 'var(--accent)';
}

function renderActionPane(caseFile: CaseFile, patient: Patient) {
  const paneH = document.getElementById('pane-history')!;
  paneH.innerHTML = `<div class="action-list">${caseFile.history_items
    .map((h) => actionBtn(h.id, h.label, h.cost, patient.historyAsked.includes(h.id)))
    .join('')}</div>`;
  paneH.querySelectorAll<HTMLButtonElement>('.action-btn').forEach((btn) => {
    btn.addEventListener('click', () => dispatch({ kind: 'ask_history', itemId: btn.dataset.id! }));
  });

  const paneE = document.getElementById('pane-exam')!;
  paneE.innerHTML = `<div class="action-list">${caseFile.exam_regions
    .map((r) => actionBtn(r.id, r.label, r.cost, patient.examsPerformed.includes(r.id)))
    .join('')}</div>`;
  paneE.querySelectorAll<HTMLButtonElement>('.action-btn').forEach((btn) => {
    btn.addEventListener('click', () => dispatch({ kind: 'exam_region', regionId: btn.dataset.id! }));
  });

  const paneO = document.getElementById('pane-orders')!;
  paneO.innerHTML = `<div class="action-list">${caseFile.orders_available
    .map((o) => {
      const blocked = Boolean(o.after_order && !patient.ordersPlaced.includes(o.after_order));
      return actionBtn(o.order_id, prettyOrder(o.order_id), 1, patient.ordersPlaced.includes(o.order_id), blocked);
    })
    .join('')}</div>`;
  paneO.querySelectorAll<HTMLButtonElement>('.action-btn').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => dispatch({ kind: 'place_order', orderId: btn.dataset.id! }));
  });

  // Meds — small fixed catalog for v1
  const meds = [
    { id: 'asa_325', label: 'Aspirin 325mg PO' },
    { id: 'metoprolol_5_iv', label: 'Metoprolol 5mg IV' },
    { id: 'ondansetron_4_iv', label: 'Ondansetron 4mg IV' },
    { id: 'ivf_ns_bolus', label: 'NS 1L IV bolus' },
    { id: 'ceftriaxone_1g_iv', label: 'Ceftriaxone 1g IV' },
    { id: 'morphine_4_iv', label: 'Morphine 4mg IV' },
  ];
  const paneM = document.getElementById('pane-meds')!;
  paneM.innerHTML = `<div class="action-list">${meds
    .map((m) => actionBtn(m.id, m.label, 1, patient.medsGiven.includes(m.id)))
    .join('')}</div>`;
  paneM.querySelectorAll<HTMLButtonElement>('.action-btn').forEach((btn) => {
    btn.addEventListener('click', () => dispatch({ kind: 'give_med', medId: btn.dataset.id! }));
  });

  const paneD = document.getElementById('pane-dispo')!;
  paneD.innerHTML = `
    <div class="dispo-list">
      ${dispoBtn('DISCHARGE_HOME', 'Discharge home', 'Outpatient follow-up; patient leaves the bay.')}
      ${dispoBtn('TRANSFER_ED', 'Transfer to ED', 'Activate EMS; bed in receiving ED.')}
      ${dispoBtn('REFER_PCP', 'Refer to PCP', 'Discharge with PCP follow-up arranged.')}
      ${dispoBtn('REFER_SPECIALIST', 'Refer to specialist', 'Discharge with specialty follow-up arranged.')}
      ${dispoBtn('OBSERVE', 'Observe in bay', 'Continue monitoring; not a terminal dispo.')}
    </div>`;
  paneD.querySelectorAll<HTMLButtonElement>('.dispo-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      dispatch({ kind: 'commit_dispo', dispo: btn.dataset.dispo as never }),
    );
  });
}

function actionBtn(id: string, label: string, cost: number, done: boolean, disabled = false) {
  return `<button class="action-btn ${done ? 'done' : ''}" data-id="${id}" ${disabled ? 'disabled' : ''}>
    ${done ? '<span class="check">✓</span>' : ''}
    <span class="lbl">${escape(label)}</span>
    <span class="cost">${cost}u</span>
  </button>`;
}

function dispoBtn(dispo: string, name: string, desc: string) {
  return `<button class="dispo-btn" data-dispo="${dispo}">
    <span class="dispo-name">${name}</span>
    <span class="dispo-desc">${desc}</span>
  </button>`;
}

function renderInbox() {
  if (!state || !currentCaseId) return;
  const caseFile = cases[currentCaseId];
  if (!caseFile) return;
  const results = document.getElementById('results-list')!;
  if (state.resolvedOrders.length === 0) {
    results.innerHTML = '<div class="empty-state" style="padding:14px">No results yet.</div>';
  } else {
    results.innerHTML = state.resolvedOrders
      .slice()
      .reverse()
      .map(
        (r) => `
        <div class="result-item">
          <div class="result-h">${prettyOrder(r.orderId)}<span class="when">turn ${r.resolvedTurn}</span></div>
          <div>${escape(r.resultText)}</div>
        </div>`,
      )
      .join('');
  }
  const pending = document.getElementById('pending-list')!;
  if (state.pendingOrders.length === 0) {
    pending.innerHTML = '<div class="empty-state" style="padding:14px">Nothing pending.</div>';
  } else {
    pending.innerHTML = state.pendingOrders
      .map(
        (p) => `<div class="pending-item">
          <div class="result-h">${prettyOrder(p.orderId)}<span class="when">resolves turn ${p.resolvesTurn}</span></div>
        </div>`,
      )
      .join('');
  }
  // Touch caseFile to silence unused warnings — used elsewhere
  void caseFile;
}

function renderCues() {
  const list = document.getElementById('cues-list')!;
  if (dmCues.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:14px">No cues yet.</div>';
    return;
  }
  list.innerHTML = dmCues
    .map((c) => {
      const isDm = c.tag === 'DM';
      return `<div class="cue-item ${isDm ? 'dm-cue' : ''}">
        <span class="cue-tag" style="${isDm ? '' : 'background:var(--slate-soft)'}">${c.tag}</span>
        <span class="cue-text">${escape(c.text)}</span>
      </div>`;
    })
    .join('');
}

function showOutcome(text: string) {
  const dlg = document.getElementById('outcome-dialog') as HTMLDialogElement;
  document.getElementById('outcome-text')!.textContent = text;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

// ---- helpers ----

function roomLabel(roomId: string): string {
  return roomId
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function prettyOrder(orderId: string): string {
  const map: Record<string, string> = {
    ecg_12_lead: '12-lead ECG',
    troponin_initial: 'Troponin (initial)',
    troponin_repeat: 'Troponin (repeat 2h)',
    cbc: 'CBC',
    bmp: 'BMP',
    ua: 'UA',
    cxr: 'Chest X-ray',
    ct_abd_pelv_contrast: 'CT abdomen/pelvis with contrast',
    ct_chest_pe: 'CT chest (PE protocol)',
    ct_head_noncon: 'CT head non-contrast',
    pocus_pelvic: 'POCUS pelvic',
    pocus_fast: 'POCUS FAST',
    pocus_lung: 'POCUS lung',
    urine_hcg: 'Urine hCG',
    lactate: 'Lactate',
    troponin_third: 'Troponin (third)',
    d_dimer: 'D-dimer',
    bnp: 'BNP',
    procalcitonin: 'Procalcitonin',
    influenza_pcr: 'Influenza PCR',
    covid_pcr: 'COVID PCR',
    strep_rapid: 'Strep rapid',
    blood_culture: 'Blood culture x2',
  };
  return map[orderId] ?? orderId;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
