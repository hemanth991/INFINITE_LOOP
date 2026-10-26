import {capitalSummary, fitEarmarks, compactSnapshotResult} from './engine/planning.js';
import {CONFIG as C} from './data/config.js';
import {PERSONAS, loadPersona, clone} from './data/personas.js';
import {collateralSwap, familyTreasury, bondSensitivity, foreignSleeve, strategySeries, fractionalKelly} from './engine/advanced.js';
import {evaluate, validate, emi, amortize, requiredSaving, goalRate, basket, weights, sum, clamp, medicalOutOfPocket, debtAnalysis, cppi, riskParity, backtest, rng, canDelay, futureValue} from './engine/core.js';

// --- AUTH & PERSISTENCE STATE ---
let session = null;
try {
  session = JSON.parse(localStorage.getItem('goalpulse_family_session') || 'null');
} catch {}

let persisted = null;
try {
  persisted = JSON.parse(localStorage.getItem('goalpulse-v1') || 'null');
} catch {}

// Initialize plan: prioritize active session, then persisted, then reference persona
const sessionPlan = session?.familyId ? (() => { try { return JSON.parse(localStorage.getItem(`goalpulse_family_${session.familyId}`) || 'null'); } catch { return null; } })() : null;
let recoveryBackup = null;
const recoveryKey = () => session?.familyId ? `goalpulse-recovery-backup-${session.familyId}` : 'goalpulse-recovery-backup';
const savedCandidate = sessionPlan || (!session ? persisted?.plan : null);
if (savedCandidate && validate(savedCandidate).length && !isBenchmarkPlan(savedCandidate)) {
  recoveryBackup = {plan: savedCandidate};
  try { localStorage.setItem(recoveryKey(), JSON.stringify(recoveryBackup)); } catch {}
} else {
  try { recoveryBackup = JSON.parse(localStorage.getItem(recoveryKey()) || 'null'); } catch {}
}

// Prefer a plan stored under this exact household ID. A global last-opened plan must not
// silently become another signed-in household's plan.
function isBenchmarkPlan(candidate) {
  return Boolean(candidate && (candidate.id === 'hackathon' || /Sharma Household.*Hackathon Benchmark/i.test(candidate.name || '') || candidate.familyId === 'FAM-1800'));
}
function createEmptyHouseholdPlan() {
  // Use the schema shape only; never silently load a benchmark household as a user's finances.
  const p = clone(loadPersona('hackathon'));
  p.id = undefined;
  p.name = 'My Household';
  p.income = 0;
  p.essential = 0;
  p.discretionary = 0;
  p.savings = 0;
  p.emergency = 0;
  p.bonus = 0;
  p.extraIncome = 0;
  p.epf = 0; p.ppf = 0; p.nps = 0; p.basic = 0;
  p.regularCorpus = 0; p.unrealisedGains = 0;
  p.term = 0; p.health = 0; p.topup = 0;
  p.loans = [];
  p.goals = (p.goals || []).map((g, i) => ({...g,
    id: ['emergency', 'education', 'retirement'][i] || `goal-${i+1}`,
    name: ['Emergency reserve', 'Education', 'Retirement'][i] || `Goal ${i+1}`,
    cost: 0, earmarked: 0
  }));
  p.shocks = [];
  p.expenses = [];
  p.assets = {goldGrams: 0, goldPricePerGram: 0, jewelleryGrams: 0, jewelleryPricePerGram: 0, silverGrams: 0, silverPricePerGram: 0, landValue: 0, otherPreciousValue: 0};
  return p;
}
let plan = sessionPlan && validate(sessionPlan).length === 0
  ? sessionPlan
  : (!session && persisted?.plan && !isBenchmarkPlan(persisted.plan) && validate(persisted.plan).length === 0 ? persisted.plan : createEmptyHouseholdPlan());
if (session && !session.token) {
  // Old offline-only sessions are not authenticated server sessions. Do not treat them as such.
  session = null;
  try { localStorage.removeItem('goalpulse_family_session'); } catch {}
}

// Ensure optimizations and strategy defaults exist
plan.optimizations = plan.optimizations || {
  cashUpgrade: true,
  directFeeRecapture: true,
  ltcgTaxHarvest: true,
  sovereignCouponCore: false,
  reitCashflowShield: false,
  globalSovereignSleeve: false,
  velocityOffsetRefi: false,
  familyLoanSwap: false
};
plan.investmentStrategy = plan.investmentStrategy || 'horizon_default';
// Household tangible assets are user-entered estimates; no live metal/land valuation is implied.
plan.assets = plan.assets || {goldGrams: 0, goldPricePerGram: 0, jewelleryGrams: 0, jewelleryPricePerGram: 0, silverGrams: 0, silverPricePerGram: 0, landValue: 0, otherPreciousValue: 0};

const arrayOrEmpty = value => Array.isArray(value) ? value : [];
let snapshots = arrayOrEmpty((session ? (() => { try { return JSON.parse(localStorage.getItem(`goalpulse_snapshots_${session.familyId}`) || '[]'); } catch { return []; } })() : persisted?.snapshots) || []).filter(snapshot => snapshot?.plan && Array.isArray(snapshot?.result?.goal_outcomes) && Number.isFinite(snapshot.result.totalShortfall) && Number.isFinite(snapshot.result.healthScore)).filter(snapshot => !isBenchmarkPlan(snapshot?.plan)),
  theme = persisted?.theme || 'light',
  units = persisted?.units || 'compact',
  real = persisted?.real ?? false,
  sidebarCollapsed = false,
  authModalOpen = false,
  authTab = 'login', // 'login' | 'register'
  registerStep = 1, // 1 to 5
  route = location.pathname.slice(1) || 'overview',
  result = evaluate(plan),
  busy = false,
  recovery = null,
  recovering = false,
  worker = null,
  requestId = 0,
  calcStore = [],
  selectedGoal = plan.goals.find(g => g.category !== 'emergency')?.id,
  ledgerPage = 0,
  investmentMonths = 60,
  crisis = 'all',
  debtExtra = 5000,
  debtRate = 0.085,
  debtFee = 5000,
  selectedLoan = 0,
  menu = false,
  lastError = '',
  baseline = null,
  marketData = null,
  liveMarketData = null,
  marketSyncing = false,
  cppiCache = null,
  goalDraft = null,
  goalDraftResult = null,
  goalDraftBase = '',
  shockDemoStep = 1,
  shockDemoAlt = 'A',
  scenarioBaseline = null,
  saveQueue = Promise.resolve(),
  pendingInput = null,
  inputTimer = null,
  pendingField = null,
  vaultSaveState = 'device',
  pointerActive = false,
  pendingAsyncRender = false,
  editingCommit = false,
  editAwaitingClick = false;

// Authoritative multi-earner state for the 5-step registration wizard
let regWizard = {
  step1: {
    familyId: '',
    password: '',
    familyName: '',
    age: 34,
    cityTier: 'metro',
    dependents: 2,
    salaryType: 'take_home', // 'take_home' | 'gross'
    p1Name: 'Person 1',
    p1Fixed: 0,
    p1Variable: 0,
    p2Name: 'Person 2',
    p2Fixed: 0,
    p2Variable: 0,
    otherIncome: 0,
    includeVariable: true
  },
  step2: {
    essential: 0,
    discretionary: 0,
    existingEmi: 0,
    emiIncludedInLiving: false, // Prevents double-deducting EMI
    insurancePremiums: 0,
    otherCommitments: 0,
    savings: 0,
    emergencyAllocated: 0,
    regularCorpus: 0,
    epf: 0,
    ppf: 0,
    familyPool: 0
  },
  step3: {
    goals: [
      {id: 'emergency', name: 'Emergency Fund Reserve', cost: 0, months: 6, tier: 'Need', category: 'emergency', weight: 1, inflation: 0, earmarked: 0, hard: true, flexible: false},
      {id: 'education', name: 'Education goal', cost: 0, months: 120, tier: 'Need', category: 'education', weight: 2, inflation: 0.06, earmarked: 0, hard: false, flexible: true},
      {id: 'retire', name: 'Retirement goal', cost: 0, months: 240, tier: 'Need', category: 'retirement', weight: 3, inflation: 0.06, earmarked: 0, hard: false, flexible: true}
    ]
  },
  step4: {
    generalInflation: 0.06,
    expectedReturn: 0.105,
    includeVariableInPlan: true,
    lockEmergencySavings: true,
    loanName: 'Home Loan',
    loanPrincipal: 0,
    loanApr: 0.088,
    loanMonths: 180,
    term: 0,
    health: 0
  }
};

function importBackupKey() { return session?.familyId ? `goalpulse-before-import-${session.familyId}` : 'goalpulse-before-import'; }

function safeStored(key) { try { return localStorage.getItem(key); } catch { return null; } }

// AI Co-Pilot State
let aiDrawerOpen = false,
  aiSettingsOpen = false,
  aiThinking = false,
  aiMessages = [],
  aiConfig = {
    apiKey: safeStored('goalpulse_ai_key') || safeStored('goalpulse-ai-key') || window.GEMINI_API_KEY || '',
    provider: safeStored('goalpulse-ai-provider') || 'gemini',
    model: normalizeAIModel(safeStored('goalpulse-ai-provider') || 'gemini', safeStored('goalpulse-ai-model'))
  };

function normalizeAIModel(provider, value) {
  const model = (value || '').trim().replace(/^models\//, '');
  if (provider === 'gemini') return !model || model === 'gemini-2.5-flash' ? 'gemini-3.8-flash' : model;
  return model || 'gpt-4o-mini';
}
// Migrate the retired default while preserving custom models and the saved key.
try { localStorage.setItem('goalpulse-ai-model', aiConfig.model); } catch {}

let experiment = {
  familyEnabled: false,
  familyAmount: 500000,
  familyRate: 0.085,
  collateral: 1000000,
  ltv: 0.7,
  bondDuration: 6,
  bondConvexity: 45,
  yieldChange: -0.0075,
  fxDrift: 0.025,
  fxVol: 0.08,
  kellyEnabled: false,
  kellyMean: 0.08
};

// 12 Comprehensive Routes organized into 4 Core Workflow sections + Diagnostics
const routes = [
  ['overview', '01 My Financial Plan'],
  ['goals', '02 My Goals & Priority'],
  ['stress', '03 What if?'],
  ['debt', '04 Debt Repayment & Tools'],
  ['cashflow', '05 Cash-Flow Sankey & Ledger'],
  ['invest', '06 Investment & Live Market Lab'],
  ['compare', '07 Side-by-Side Plan Comparator'],
  ['action', '08 Monthly actions'],
  ['copilot', '09 Planning assistant'],
  ['method', '10 Methodology & Assumptions'],
  ['profile', '11 Your financial profile'],
  ['fix', '12 Planning options']
];

if (route === 'start') route = 'profile';
if (route === 'login' || route === 'register') { authModalOpen = true; authTab = route; route = 'overview'; }
if (!routes.some(([r]) => r === route)) route = 'overview';

// Helper Utilities
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

function compactMoney(x) {
  x = Number(x) || 0;
  const sign = x < 0 ? '−' : '';
  x = Math.abs(x);
  if (x >= 1e7) return `${sign}₹${(x / 1e7).toFixed(2)}Cr`;
  if (x >= 1e5) return `${sign}₹${(x / 1e5).toFixed(2)}L`;
  if (x >= 1e4) return `${sign}₹${(x / 1e3).toFixed(1)}k`;
  return `${sign}₹${Math.round(x).toLocaleString('en-IN')}`;
}

function money(x, t = 0) {
  x = Number(x) || 0;
  if (Math.abs(x) < .5) x = 0;
  if (real && t) x /= (1 + C.inflation.general) ** (t / 12);
  let sign = x < 0 ? '−' : '';
  x = Math.abs(x);
  return (
    sign +
    '₹' +
    (units === 'full'
      ? Math.round(x).toLocaleString('en-IN')
      : x >= 1e7
      ? (x / 1e7).toFixed(2) + ' Cr'
      : x >= 1e5
      ? (x / 1e5).toFixed(2) + ' L'
      : Math.round(x).toLocaleString('en-IN'))
  );
}

function date(month) {
  let d = new Date(plan.startDate + 'T12:00:00');
  d.setDate(1);
  d.setMonth(d.getMonth() + month);
  return d.toLocaleDateString('en-IN', {month: 'short', year: 'numeric'});
}

async function persist() {
  const capture = {plan: clone(plan), snapshots: snapshots.map(s => ({...s, result: compactSnapshotResult(s.result)})), theme, units, real};
  const identity = session ? {...session} : null;
  const syncAllowed = !recoveryBackup;
  const task = async () => {
    if (identity?.familyId === session?.familyId && identity) { vaultSaveState = 'syncing'; if ($('#save-status')) $('#save-status').textContent = 'Syncing…'; }
    let localSaved = false, serverSaved = false;
    try {
      // Do not let a delayed save repopulate the global view after logout/switch.
      if ((session?.familyId || null) === (identity?.familyId || null)) localStorage.setItem('goalpulse-v1', JSON.stringify(capture));
      if (identity) {
        localStorage.setItem(`goalpulse_family_${identity.familyId}`, JSON.stringify(capture.plan));
        localStorage.setItem(`goalpulse_snapshots_${identity.familyId}`, JSON.stringify(capture.snapshots));
      }
      localSaved = true;
    } catch { toast('Browser storage is unavailable. Export your plan to keep a copy.'); }
    if (identity?.token && syncAllowed) {
      try {
        const response = await fetch('/api/auth/save', {
          method: 'POST', signal: AbortSignal.timeout(10000),
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}`},
          body: JSON.stringify({familyId: identity.familyId, plan: capture.plan, snapshots: capture.snapshots})
        });
        const data = await response.json().catch(() => ({}));
        serverSaved = response.ok && data.ok === true;
      } catch {}
    }
    if (identity?.familyId === session?.familyId && identity) { vaultSaveState = serverSaved ? 'saved' : 'device'; if ($('#save-status')) $('#save-status').textContent = serverSaved ? 'Saved to vault' : 'Device copy · sync not confirmed'; }
    return {localSaved, serverSaved, hasSession: Boolean(identity?.familyId)};
  };
  const pending = saveQueue.then(task, task);
  saveQueue = pending.catch(() => {});
  return pending;
}

function toast(s) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = s;
  el.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.style.display = 'none'), 4800);
}

function calc(value, title, formula, inputs = {}, note = '') {
  let id = calcStore.push({title, formula, inputs, note}) - 1;
  return `<button class="fx-btn" data-calc="${id}" title="Inspect Calculation: ${esc(title)}">𝑓(x)</button>`;
}

function metric(label, value, note, formula, inputs, cls = '') {
  return `<div class="metric"><label>${label}</label><strong class="${cls}">${value} ${calc(value, label, formula, inputs)}</strong><small>${note}</small></div>`;
}

function status(g) {
  if (g.probability == null) return '<span class="status">Calculating</span>';
  let c = g.probability >= C.targets[g.tier] ? 'good' : g.probability >= 0.5 ? 'warn' : 'bad';
  return `<span class="status ${c}">${g.probability >= C.targets[g.tier] ? 'On track' : g.probability >= 0.5 ? 'At risk' : 'Off track'}</span>`;
}

function probability(g) {
  if (g.probability == null) return '<span class="loading">Updating…</span>';
  let c = g.probability >= C.targets[g.tier] ? 'good' : g.probability >= 0.5 ? 'warn' : 'bad';
  return `<div class="prob ${c}"><span class="bar"><i style="width:${g.probability * 100}%"></i></span><span class="mono">${pct(g.probability)}</span> ${calc(
    pct(g.probability),
    'Goal success probability',
    'Paths with final wealth ≥ path-specific target ÷ total paths',
    {goal: g.name, successfulPaths: Math.round(g.probability * (result.paths || 1000)), paths: result.paths || 1000, targetProbability: C.targets[g.tier]},
    'Probability is an institutional 1,000-path Monte Carlo estimate. Targets are inflation-indexed separately on every path.'
  )}</div>`;
}

function heading(kicker, title, subtitle, actions = '') {
  return `<div class="heading"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}

function panel(title, subtitle, content, actions = '') {
  return `<section class="panel"><div class="panelhead"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${actions}</div>${content}</section>`;
}

function link(route, label, primary = false) {
  return `<button data-nav="${route}" class="${primary ? 'primary' : ''}">${label}</button>`;
}

function field(label, path, value, {step = 1, min = 0, max, type = 'number', help = ''} = {}) {
  return `<label class="field">${label}<input type="${type}" data-field="${path}" value="${esc(value)}" ${
    type === 'number' ? `step="${step}" min="${min}" ${max !== undefined ? `max="${max}"` : ''}` : ''
  }>${help ? `<small>${help}</small>` : ''}</label>`;
}

function select(label, path, value, options) {
  return `<label class="field">${label}<select data-field="${path}">${options
    .map(o => {
      let [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${l}</option>`;
    })
    .join('')}</select></label>`;
}

function check(label, path, value) {
  return `<label class="checkfield"><input type="checkbox" data-field="${path}" ${value ? 'checked' : ''}>${label}</label>`;
}

// --- ENGINE RE-COMPUTATION ---
let baselineWorker = null,
  recoveryWorker = null;

function compute() {
  let errors = validate(plan);
  if (errors.length) {
    lastError = errors.join(' ');
    render();
    return;
  }
  lastError = '';
  result = evaluate(plan);
  recovery = null;
  recovering = false;
  baseline = null;
  worker?.terminate();
  baselineWorker?.terminate();
  recoveryWorker?.terminate();
  busy = true;
  requestId++;
  let id = requestId;

  try { worker = new Worker('/engine/worker.js', {type: 'module'}); } catch (error) { busy = false; lastError = 'Simulation could not start. Reload the page or use a browser that supports module workers.'; render(); return; }
  worker.onmessage = ({data}) => {
    if (data.id !== requestId) return;
    busy = false;
    if (data.error) lastError = data.error;
    else result = data.result;
    renderAsync();
  };
  worker.onerror = e => {
    busy = false;
    lastError = 'Probability engine worker fallback: ' + e.message;
    render();
  };
  worker.postMessage({id, type: 'simulate', plan, targets: C.targets});

  if (plan.shocks.length) {
    let b = clone(plan);
    b.shocks = [];
    baselineWorker = new Worker('/engine/worker.js', {type: 'module'});
    baselineWorker.onmessage = ({data}) => {
      if (id === requestId && !data.error) {
        baseline = data.result;
        if (route === 'stress') renderAsync();
      }
    };
    baselineWorker.postMessage({id, type: 'simulate', plan: b, targets: C.targets});
  }

  persist();
  if (!editingCommit) renderAsync();
}

function flushInput() {
  clearTimeout(inputTimer);
  const commit = pendingInput; pendingInput = null;
  commit?.();
}

function navigate(r) {
  flushInput();
  if (r === 'login' || r === 'register') {
    authModalOpen = true;
    authTab = r;
    render();
    return;
  }
  if (!routes.some(([v]) => v === r)) return;
  route = r;
  menu = false;
  history.pushState({}, '', '/' + r);
  render();
  window.scrollTo({top: 0});
  $('#main')?.focus({preventScroll: true});
}

function setValue(path, value) {
  let keys = path.split('.');
  if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw Error('Invalid input path');
  let o = plan;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys.at(-1)] = value;
}

function changed() {
  // Live-plan changes invalidate any draft computed from the previous live state.
  if (goalDraftBase !== JSON.stringify(plan.goals)) goalDraft = null;
  goalDraftResult = null;
  // `essential` is the authoritative monthly total edited by registration/profile.
  // Do not silently overwrite it from the persona's legacy expense breakdown:
  // those rows may be demo defaults and are not currently an editable source of truth.
  compute();
}

function download(name, content, type = 'application/json') {
  let url = URL.createObjectURL(new Blob([content], {type})),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csv(rows) {
  let keys = Object.keys(rows[0] || {});
  let q = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [keys.map(q).join(','), ...rows.map(r => keys.map(k => q(typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])).join(','))].join('\r\n');
}

function openCalculation(d) {
  $('#explain-content').innerHTML = `
    <p class="eyebrow">EQUATION &amp; AUDIT INSPECTION</p>
    <h2>${esc(d.title)}</h2>
    <p style="font-family:var(--mono);color:var(--accent);font-size:13px">${esc(d.formula)}</p>
    <pre>${esc(JSON.stringify(d.inputs, null, 2))}</pre>
    <p>${esc(d.note)}</p>
    <p class="quiet">GoalPulse planning model ${C.version} · estimates depend on entered data and stated assumptions.</p>
  `;
  $('#explain').showModal();
}

function saveSnapshot() {
  if (busy) {
    toast('Wait for the 1,000-path simulation to finish before saving a plan.');
    return;
  }
  if (snapshots.length >= 3) {
    toast('Three plan snapshots are saved. Delete one in Plan Comparator to make room.');
    return;
  }
  const isDuplicate = snapshots.some(snapshot => JSON.stringify(snapshot.plan) === JSON.stringify(plan));
  snapshots.push({
    label: plan.name + (plan.shocks.length ? ' · Shocked' : Object.values(plan.optimizations || {}).some(Boolean) ? ' · Scenario modified' : ' · Snapshot') + (isDuplicate ? ' · Identical copy' : ''),
    savedAt: new Date().toISOString(),
    plan: clone(plan),
    result: compactSnapshotResult(result)
  });
  persist();
  toast('Saved Plan ' + String.fromCharCode(64 + snapshots.length) + '.');
  render();
}

function addShock(type) {
  let add =
    type === 'recession'
      ? [
          {type: 'crash', month: 12, duration: 1, value: 0.35},
          {type: 'job', month: 12, duration: 4, value: 0.5}
        ]
      : [
          {
            type,
            month: 12,
            duration: type === 'job' ? 6 : type === 'inflation' ? 24 : 1,
            value: {job: 1, medical: 1200000, rate: 0.015, dependent: 15000, bonus: 200000, inflation: 0.03}[type]
          }
        ];
  if (plan.shocks.length + add.length > 10) {
    toast('Use at most ten events in one scenario.');
    return;
  }
  plan.shocks.push(...add);
  changed();
}

// --- Optimization ideas: distinguish user-data calculations from unmodelled strategies ---
function getDynamicOptimizationLevers(p, res) {
  const hasLoans = Boolean(p.loans && p.loans.length > 0);
  const loan = hasLoans ? p.loans[0] : null;
  const shortGoals = (p.goals || []).filter(g => Number(g.months) >= 24 && Number(g.months) <= 96);
  const nearTermGoals = sum(shortGoals.map(g => Number(g.cost) || 0));
  const corpus = Math.max(0, Number(p.regularCorpus) || 0) + sum((p.goals || []).map(g => Number(g.earmarked) || 0));
  const emergency = Math.max(0, Number(p.emergency) || 0);
  const savingsRate = Number(C.rates?.savings);
  const assumedArbitrageRate = Number(C.assets?.[3]?.mean);
  const postTaxSavings = Number.isFinite(savingsRate) ? savingsRate * (1 - (Number(p.slab) || 0)) : null;
  const postTaxArb = Number.isFinite(assumedArbitrageRate) ? assumedArbitrageRate * (1 - (Number(p.slab) || 0)) : null;
  const annualGain = postTaxSavings !== null && postTaxArb !== null ? Math.round(emergency * (postTaxArb - postTaxSavings)) : null;
  const notModelled = 'Not modelled by current engine';
  const idea = (key, title, category, explanation, impact, extra = {}) => ({
    key, title, category, formula: explanation, badgeText: 'Illustrative idea',
    beforeVal: '—', afterVal: '—', beforeWidth: 0, afterWidth: 0,
    impact, calcFn: () => ({modelled: false, ...extra})
  });
  return [
    {
      key: 'cashUpgrade', title: 'Compare Cash Options', category: 'Liquidity',
      formula: 'Estimate the difference using your emergency-fund amount and the planner’s configured rate assumptions. This is not a product recommendation.',
      badgeText: annualGain === null ? 'Missing rate inputs' : 'Estimate from assumptions',
      beforeVal: emergency > 0 ? money(emergency) : 'No emergency fund entered',
      afterVal: annualGain === null ? 'Not available' : `${money(Math.max(0, annualGain))}/yr estimated difference`,
      beforeWidth: 0, afterWidth: 0,
      impact: emergency > 0 && annualGain !== null ? `Estimated annual difference: ${money(annualGain)} (before tax/product risk validation)` : 'Enter an emergency-fund amount to estimate',
      calcFn: () => ({savingsRate, assumedArbitrageRate, slab: p.slab, emergency, annualGain, assumptionBased: true})
    },
    {...idea('directFeeRecapture', 'Compare Fund Fees', 'Fee Drag', 'Uses the configured regular/direct equity fee assumptions in portfolio growth. No cash is added to salary.', 'Portfolio fee assumption'), badgeText: 'Modelled fee comparison', beforeVal: pct(C.rates.regularFee, 2) + ' annual equity fee', afterVal: pct(C.rates.directFee, 2) + ' annual equity fee'},
    idea('ltcgTaxHarvest', 'Capital-Gains Tax Review', 'Tax Planning', 'Tax outcomes depend on actual realised/unrealised gains, holding periods, available exemptions, transactions, and current tax rules.', notModelled, {unrealisedGainsProvided: Number.isFinite(Number(p.unrealisedGains))}),
    {
      key: 'sovereignCouponCore', title: 'Protect Near-Term Goals', category: 'Goal Risk',
      formula: 'Identifies goals due in 2–8 years; it does not construct a sovereign-bond or principal-protection portfolio.',
      badgeText: 'Goal amounts only', beforeVal: 'Portfolio not modelled', afterVal: nearTermGoals > 0 ? money(nearTermGoals) + ' goal costs' : 'No matching goals',
      beforeWidth: 0, afterWidth: 0,
      impact: nearTermGoals > 0 ? `${money(nearTermGoals)} in goal costs fall 2–8 years out; no protection guarantee is calculated.` : 'No goals due in 2–8 years to evaluate',
      calcFn: () => ({modelled: false, nearTermGoals, goalCount: shortGoals.length})
    },
    idea('reitCashflowShield', 'Real-Asset Income Strategy', 'Real Assets', 'REIT distributions, prices, taxes, liquidity, and allocation risk are not simulated by this planner.', notModelled),
    idea('globalSovereignSleeve', 'Global Diversification', 'Diversification', 'Foreign-currency assets, FX drift, correlations, and hedging costs are not simulated by this planner.', notModelled),
    {
      key: 'velocityOffsetRefi', title: 'Debt Repayment Scenario', category: 'Debt',
      formula: 'A real comparison requires each loan balance, APR, payment, fees, and an explicitly chosen extra-payment amount.',
      badgeText: hasLoans ? 'Loan data available' : 'Add loan data',
      beforeVal: hasLoans ? `${money(Number(loan.principal) || 0)} balance` : 'No loan entered',
      afterVal: 'No scenario run', beforeWidth: 0, afterWidth: 0,
      impact: hasLoans ? 'Open Debt Planner and choose an extra payment to calculate a repayment scenario.' : 'Add a loan to evaluate repayment options',
      calcFn: () => ({modelled: false, hasLoans, loanCount: (p.loans || []).length})
    },
    idea('familyLoanSwap', 'Family Refinance Comparison', 'Debt', 'A family refinance is not modelled. It would require a user-entered proposed rate, fees, term, and legal/tax review.', notModelled, {hasLoans})
  ];
}

// --- 6 PURE HELPER FUNCTIONS FOR SVG INFOGRAPHICS ---

// Infographic A: Radial Gauge / Speedometer Ring
function svgRadialGauge(pctValue, bigText, title, badgeText, color = 'var(--accent)') {
  const r = 32, c = 2 * Math.PI * r, dash = clamp(pctValue, 0, 1) * c;
  return `<div class="infocard">
    <svg viewBox="0 0 80 80" class="radial-svg" role="img" aria-label="${esc(title)}">
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--soft)" stroke-width="8"/>
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
        transform="rotate(-90 40 40)"/>
      <text x="40" y="45" text-anchor="middle" class="radial-val">${esc(bigText)}</text>
    </svg>
    <div class="infometa">
      <strong>${esc(title)}</strong>
      <span class="pill">${esc(badgeText)}</span>
    </div>
  </div>`;
}

// Infographic B: Visual Cash-Flow Pipe Sankey Bar
function svgMoneyFlowSankey(m) {
  const actualInflow = m.income + (m.reserveDraw || 0) + (m.unfunded || 0);
  const totalInflow = Math.max(1, actualInflow);
  const essentialsPct = Math.round((m.essential / totalInflow) * 100);
  const lifestylePct = Math.round((m.discretionary / totalInflow) * 100);
  const emiPct = Math.round((m.emi / totalInflow) * 100);
  const refillPct = Math.round((m.refill / totalInflow) * 100);
  const goalPct = Math.round((m.allocation / totalInflow) * 100);
  const residualPct = Math.round(((m.unallocated || 0) / totalInflow) * 100);

  return `<div class="pipe-container">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:14px">Your monthly cash flow · ${money(actualInflow)}</strong>
      <span class="pill" style="color:var(--green)">Balanced ✓</span>
    </div>
    <div class="pipe-bar" role="img" aria-label="Monthly Cash Flow Allocation">
      <div class="pipe-seg" style="width:${essentialsPct}%;background:#3b82f6" title="Essentials: ${money(m.essential)} (${essentialsPct}%)"></div>
      <div class="pipe-seg" style="width:${lifestylePct}%;background:#8b5cf6" title="Lifestyle: ${money(m.discretionary)} (${lifestylePct}%)"></div>
      <div class="pipe-seg" style="width:${emiPct}%;background:#ef4444" title="Debt EMIs: ${money(m.emi)} (${emiPct}%)"></div>
      <div class="pipe-seg" style="width:${refillPct}%;background:#f59e0b" title="Reserve: ${money(m.refill)} (${refillPct}%)"></div>
      <div class="pipe-seg" style="width:${goalPct}%;background:#10b981" title="Goal Investments: ${money(m.allocation)} (${goalPct}%)"></div>
      ${residualPct > 0 ? `<div class="pipe-seg" style="width:${residualPct}%;background:#06b6d4" title="Residual Sweep: ${money(m.unallocated)} (${residualPct}%)"></div>` : ''}
    </div>
    ${(m.reserveDraw || m.unfunded) ? `<p class="warn">Includes reserve draw ${money(m.reserveDraw || 0)} and unfunded gap ${money(m.unfunded || 0)}. An unfunded gap is not available income.</p>` : ''}
    <div class="pipe-legend">
      <div class="pipe-item"><span class="pipe-dot" style="background:#3b82f6"></span><span>Essentials: <strong>${money(m.essential)}</strong> (${essentialsPct}%)</span></div>
      <div class="pipe-item"><span class="pipe-dot" style="background:#8b5cf6"></span><span>Lifestyle: <strong>${money(m.discretionary)}</strong> (${lifestylePct}%)</span></div>
      <div class="pipe-item"><span class="pipe-dot" style="background:#ef4444"></span><span>Debt EMIs: <strong>${money(m.emi)}</strong> (${emiPct}%)</span></div>
      <div class="pipe-item"><span class="pipe-dot" style="background:#f59e0b"></span><span>Reserve: <strong>${money(m.refill)}</strong> (${refillPct}%)</span></div>
      <div class="pipe-item"><span class="pipe-dot" style="background:#10b981"></span><span>Goals: <strong>${money(m.allocation)}</strong> (${goalPct}%)</span></div>
      ${residualPct > 0 ? `<div class="pipe-item"><span class="pipe-dot" style="background:#06b6d4"></span><span>Available: <strong>${money(m.unallocated)}</strong> (${residualPct}%)</span></div>` : ''}
    </div>
  </div>`;
}

// Infographic C: Authoritative Visual Goal Cards with PV, FV, Required/mo, Planned/mo, Projected, and Shortfall
function svgGoalInfographicCards(goals = result.goal_outcomes) {
  if (!goals.length) return '<p class="quiet">No active goals configured.</p>';
  const icons = {
    home: '🏡',
    education: '🎓',
    retirement: '🌅',
    retire: '🌅',
    car: '🚗',
    vehicle: '🚗',
    emergency: '🛡️',
    general: '🎯'
  };

  const m1 = result.monthly_ledger[0] || {};
  const monthlySurplus = Number(m1.surplus || 0);

  return `<div class="goal-cards-grid">
    ${goals.map((g, i) => {
      const planGoal = plan.goals.find(pg => pg.id === g.id) || {};
      const pvCost = planGoal.cost ?? g.cost ?? g.target;
      const fvTarget = g.target || pvCost;
      const earmarked = planGoal.earmarked || 0;
      const months = g.months || planGoal.months || 60;
      const remainingToFund = Math.max(0, fvTarget - earmarked);
      const reqMonthly = Math.round(g.required ?? (remainingToFund / Math.max(1, months)));
      const plannedMonthly = g.category === 'emergency' ? Math.round(m1.refill || 0) : m1.contributions?.[i] !== undefined ? Math.round(m1.contributions[i]) : 0;
      const corpusVal = g.corpus || 0;
      const shortfallVal = g.shortfall || Math.max(0, fvTarget - corpusVal);

      const ready = g.cost > 0;
      const simulated = g.probability != null;
      const statusClass = !ready || !simulated ? 'warn' : g.probability >= C.targets[g.tier] ? 'good' : g.probability >= .5 ? 'warn' : 'bad';
      const statusLabel = !ready ? 'Enter a target amount' : !simulated ? 'Calculating probability' : `${status(g).replace(/<[^>]+>/g, '')} · ${pct(g.probability)} likely`;

      const ringColor = statusClass === 'good' ? 'var(--green)' : statusClass === 'warn' ? 'var(--amber)' : 'var(--red)';
      const corpusPct = Math.min(100, Math.round((corpusVal / Math.max(1, fvTarget)) * 100));
      const icon = icons[g.category] || '🎯';

      const chance = simulated ? clamp(g.probability) : 0;
      return `<article class="goal-card airy-goal">
        <div class="goal-card-top"><div class="goal-title-wrap"><span class="goal-ico">${icon}</span><div><h3>${esc(g.name)}</h3><small>${date(months)} · ${g.tier}</small></div></div>
        <svg class="chance-ring" viewBox="0 0 56 56" role="img" aria-label="${simulated ? pct(chance) : 'Calculating'} success probability"><circle cx="28" cy="28" r="23" class="ring-track"/><circle cx="28" cy="28" r="23" fill="none" stroke="${ringColor}" stroke-width="4" stroke-dasharray="${chance*144.51} 144.51" transform="rotate(-90 28 28)"/><text x="28" y="32" text-anchor="middle">${simulated ? pct(chance) : '…'}</text></svg></div>
        <span class="goal-status ${statusClass}">${statusLabel}</span>
        <div class="goal-hero"><span>Projected median</span><strong>${money(corpusVal,months)}</strong><small>of ${money(fvTarget,months)} target</small></div>
        <div class="goal-bar-bg"><div class="goal-bar-core" style="width:${corpusPct}%;background:${ringColor}"></div></div>
        <div class="goal-quick"><div><span>Monthly saving</span><b>${money(plannedMonthly)}</b></div><div><span>Expected shortfall</span><b class="${shortfallVal > 1000 ? 'bad' : 'good'}">${money(shortfallVal,months)}</b></div></div>
        <details class="goal-calculation"><summary>Calculation details</summary><dl><div><dt>Today’s cost</dt><dd>${money(pvCost)}</dd></div><div><dt>Earmarked</dt><dd>${money(earmarked)}</dd></div><div><dt>Required / month</dt><dd>${money(reqMonthly)}</dd></div><div><dt>Horizon</dt><dd>${months} months</dd></div></dl>${calc('Inspect 𝑓(x)',g.name,'FV = PV × (1 + i)ᵗ and Monthly Ledger Allocation',{pv:pvCost,fv:fvTarget,months,reqMonthly,plannedMonthly,shortfall:shortfallVal})}</details>
      </article>`;
    }).join('')}
  </div>`;
}

// Infographic D: 8 De-congested Optimization Switches (NO PARAGRAPHS!)
function svgOptimizationToggleGrid(p, res) {
  const levers = getDynamicOptimizationLevers(p, res);
  return `<div class="opt-grid">
    ${levers.map(l => {
      const supported = ['cashUpgrade', 'directFeeRecapture'].includes(l.key);
      const isActive = supported && Boolean(p.optimizations?.[l.key]);
      const calcData = l.calcFn(p);
      return `<div class="opt-card ${isActive ? 'active' : ''}">
        <div class="opt-head">
          <div>
            <span class="opt-cat">${l.category}</span>
            <h3 class="opt-title">${l.title}</h3>
          </div>
          ${supported ? `<label class="switch" title="Toggle ${l.title}">
            <input type="checkbox" data-opt-toggle="${l.key}" ${supported ? '' : 'disabled'} ${isActive ? 'checked' : ''}>
            <span class="slider"></span>
          </label>` : `<span class="status">Not in forecast</span>`}
        </div>
        <div class="opt-meter">
          <div class="opt-meter-row">
            <span class="opt-meter-label">Before:</span>
            <div class="opt-meter-track"><div class="opt-meter-fill" style="width:${l.beforeWidth}%;background:var(--muted);opacity:0.6"></div></div>
            <span class="opt-meter-val">${l.beforeVal}</span>
          </div>
          <div class="opt-meter-row">
            <span class="opt-meter-label">Active:</span>
            <div class="opt-meter-track"><div class="opt-meter-fill" style="width:${l.afterWidth}%;background:var(--green)"></div></div>
            <span class="opt-meter-val" style="color:var(--green)">${l.afterVal}</span>
          </div>
        </div>
        <div class="opt-meta">
          <span class="opt-impact ${isActive ? '' : 'neutral'}">${l.impact}</span>
          ${calc(l.badgeText, l.title, l.formula, calcData)}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// Infographic E: Visual Debt Payoff Compression Bar
function svgDebtCompressionVisual(l) {
  if (!l) return '<p class="quiet">No active debt account selected.</p>';
  let a = debtAnalysis(plan, l, debtExtra, debtRate, debtFee);
  let totalBase = l.principal + a.baseline.interest;
  let pBasePct = Math.round((l.principal / totalBase) * 100);
  let iBasePct = 100 - pBasePct;

  let optInterest = Math.max(0, a.baseline.interest - a.interestSaved);
  let totalOpt = l.principal + optInterest;
  let pOptPct = Math.round((l.principal / totalBase) * 100);
  let iOptPct = Math.round((optInterest / totalBase) * 100);
  let savedPct = Math.max(0, 100 - (pOptPct + iOptPct));

  return `<div class="debt-visual-box">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong>Debt Payoff Compression Schedule (${esc(l.name)})</strong>
      <span class="pill" style="color:var(--green)">-${a.baseline.months - a.optimized.months} Months Acceleration</span>
    </div>

    <div style="margin-top:16px">
      <small class="quiet">1. Standard Bank Schedule (Ends: ${date(a.baseline.months)}):</small>
      <div class="debt-stacked-bar">
        <div class="debt-seg" style="width:${pBasePct}%;background:#475569">Principal: ${money(l.principal)}</div>
        <div class="debt-seg" style="width:${iBasePct}%;background:#ef4444">Interest Bleed: ${money(a.baseline.interest)}</div>
      </div>
    </div>

    <div>
      <small class="quiet">2. With selected monthly extra principal (Ends: ${date(a.optimized.months)}):</small>
      <div class="debt-stacked-bar">
        <div class="debt-seg" style="width:${pOptPct}%;background:#475569">Principal: ${money(l.principal)}</div>
        <div class="debt-seg" style="width:${iOptPct}%;background:#0d9488">Reduced Interest: ${money(optInterest)}</div>
        <div class="debt-seg" style="width:${savedPct}%;background:#10b981;border:1px dashed #ffffff">💰 Saved: ${money(a.interestSaved)}</div>
      </div>
    </div>

    <div class="actions" style="margin-top:14px">
      <button data-act="apply-debt-strategy" class="primary">Apply Optimized Debt Schedule to My Plan</button>
      <button data-act="debt-csv">Export Amortization CSV</button>
    </div>
  </div>`;
}

// Infographic F: Investment Basket Donut & Crisis Replay
function svgAssetDonutAndCrisisReplay() {
  const w = basket(investmentMonths, plan.investmentStrategy);
  // w = [equity, debt, gold, liquid]
  const rows = marketData?.rows || [];
  let filtered = crisis === 'all'
    ? rows
    : rows.filter(r => (crisis === '2008' ? r.date >= '2008-01' && r.date <= '2009-12' : crisis === '2020' ? r.date >= '2020-01' && r.date <= '2020-12' : r.date >= '2022-01' && r.date <= '2022-12'));
  let replay = backtest(filtered, w, 12, 0);
  let equity = backtest(filtered, [1, 0, 0, 0], 12, 0);
  let fd = filtered.map((_, i) => (1 + C.rates.fd) ** ((i + 1) / 12));

  // Donut SVG
  const r = 36, c = 2 * Math.PI * r;
  const eqDash = w[0] * c, debtDash = w[1] * c, goldDash = w[2] * c, liqDash = w[3] * c;

  return `<div class="twocol equal" style="margin-bottom:24px">
    <div class="panel">
      <div class="panelhead">
        <div>
          <h2>Horizon Allocation Donut</h2>
          <p>Horizon: ${investmentMonths} Months • Strategy: ${esc(plan.investmentStrategy)}</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:20px">
        <svg viewBox="0 0 100 100" style="width:120px;height:120px;flex-shrink:0">
          <circle cx="50" cy="50" r="${r}" fill="none" stroke="#3b82f6" stroke-width="14" stroke-dasharray="${eqDash.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="0"/>
          <circle cx="50" cy="50" r="${r}" fill="none" stroke="#10b981" stroke-width="14" stroke-dasharray="${debtDash.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-eqDash).toFixed(1)}"/>
          <circle cx="50" cy="50" r="${r}" fill="none" stroke="#f59e0b" stroke-width="14" stroke-dasharray="${goldDash.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-(eqDash + debtDash)).toFixed(1)}"/>
          <circle cx="50" cy="50" r="${r}" fill="none" stroke="#06b6d4" stroke-width="14" stroke-dasharray="${liqDash.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-(eqDash + debtDash + goldDash)).toFixed(1)}"/>
          <text x="50" y="54" text-anchor="middle" style="font-family:var(--mono);font-size:12px;font-weight:700;fill:var(--text)">${investmentMonths}M</text>
        </svg>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
          <div><span class="pipe-dot" style="background:#3b82f6;display:inline-block"></span> Equity: <strong>${pct(w[0])}</strong> (Nifty 50 Index)</div>
          <div><span class="pipe-dot" style="background:#10b981;display:inline-block"></span> Gilt/Debt: <strong>${pct(w[1])}</strong> (10Y Constant Gilt)</div>
          <div><span class="pipe-dot" style="background:#f59e0b;display:inline-block"></span> Gold: <strong>${pct(w[2])}</strong> (Domestic Gold INR)</div>
          <div><span class="pipe-dot" style="background:#06b6d4;display:inline-block"></span> Liquid: <strong>${pct(w[3])}</strong> (Arbitrage / Overnight)</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panelhead">
        <div>
          <h2>Synthetic crisis-style replay</h2>
          <p>2008 GFC · 2020 COVID · 2022 Rate Cycle</p>
        </div>
      </div>
      <div class="chipset" style="margin:0 0 10px">
        <button data-crisis="all" class="${crisis === 'all' ? 'selected' : ''}">2006–2025</button>
        <button data-crisis="2008" class="${crisis === '2008' ? 'selected' : ''}">2008 GFC</button>
        <button data-crisis="2020" class="${crisis === '2020' ? 'selected' : ''}">2020 COVID</button>
        <button data-crisis="2022" class="${crisis === '2022' ? 'selected' : ''}">2022 Rate Hike</button>
      </div>
      ${simpleLine([replay.line, equity.line, fd], ['Goal basket', 'Equity proxy', 'FD assumption'], [filtered[0]?.date || 'No data', filtered.at(-1)?.date || 'No data'])}
    </div>
  </div>`;
}

// --- LIVE AI CO-PILOT ADVISOR (DIRECT GEMINI / OPENAI API + DYNAMIC LOCAL FALLBACK) ---
let aiConnectionState = 'untested';
async function requestAI(payload, endpoint = '/api/explain') {
  try {
    const response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(65000),
      headers: {'Content-Type':'application/json', ...(session?.token ? {Authorization:`Bearer ${session.token}`} : {})},
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.text) throw Error(data.error || data.detail || `AI request failed (HTTP ${response.status}). Check that the Python backend is running.`);
    aiConnectionState = 'connected';
    return data.text;
  } catch (error) {
    aiConnectionState = 'failed';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Error('AI request timed out. Retry or choose a faster model.');
    if (error instanceof TypeError) throw Error('Cannot reach the AI backend. Check the local server and internet connection.');
    throw error;
  }
}

async function askFinancialCoPilot(userMessage, plan, result) {
  const apiKey = aiConfig.apiKey || '';

  // 1. Live AI Snapshot of the User's Exact Verified Numbers
  const liveContext = {
    family: session ? session.familyName : plan.name,
    monthlyIncome: plan.income,
    monthlySurplus: Math.round(result.monthly_ledger?.[0]?.surplus || 0),
    healthScore: Math.round(result.healthScore || 0),
    totalShortfall: Math.round(result.totalShortfall || 0),
    activeOptimizations: plan.optimizations || plan.opt || {},
    loans: (plan.loans || []).map(l => ({ name: l.name, principal: l.principal, apr: l.apr, months: l.months })),
    goals: (result.goal_outcomes || []).map(g => ({
      name: g.name,
      tier: g.tier,
      targetCost: Math.round(g.target),
      projectedCorpus: Math.round(g.corpus),
      shortfall: Math.round(g.shortfall),
      successProbabilityPct: Math.round((g.probability || 0) * 100)
    }))
  };

  if (apiKey || window.hasServerAIKey) {
    return requestAI({provider:aiConfig.provider, model:aiConfig.model, apiKey:apiKey || undefined, prompt:userMessage, context:liveContext});
  }

  // Local fallback must not invent financial calculations or imply a simulation ran.
  return `I can explain the current plan, but the AI service is unavailable and I have not run a new calculation for this question. Current model snapshot: monthly surplus ₹${liveContext.monthlySurplus.toLocaleString('en-IN')}; modelled total shortfall ₹${liveContext.totalShortfall.toLocaleString('en-IN')}. Use the What-If controls to change an input and recalculate the plan. Treat model outputs as estimates based on your assumptions, not financial guarantees.`;
}

async function handleChatSubmit(userQuery) {
  if (!userQuery || !userQuery.trim()) return;
  if (aiThinking) { toast('Wait for the current explanation to finish.'); return; }
  const chatIdentity = session?.familyId || 'device';
  const q = userQuery.trim();
  aiMessages.push({role: 'user', text: q});
  aiThinking = true;
  renderAIDrawer();
  if (route === 'copilot') render();

  try {
    const reply = await askFinancialCoPilot(q, plan, result);
    if ((session?.familyId || 'device') === chatIdentity) aiMessages.push({role: 'ai', text: reply});
  } catch (err) {
    console.warn('AI Co-Pilot error:', err);
    aiMessages.push({role: 'ai', text: `Co-Pilot notice: ${err.message}`});
  } finally {
    aiThinking = false;
    renderAIDrawer();
    if (route === 'copilot') render();
  }
}

function generateDeterministicAdvisoryMemo(plan, result) {
  const firstMonth = result?.monthly_ledger?.[0] || {};
  const income = Number(plan?.income || 0) + Number(plan?.extraIncome || 0);
  const surplus = Number(firstMonth.surplus ?? ((firstMonth.income || 0) + (firstMonth.extraIncome || 0) - (firstMonth.essential || 0) - (firstMonth.discretionary || 0) - (firstMonth.emi || 0)));
  const health = Number(result?.healthScore ?? 0);
  const shortfall = Number(result?.totalShortfall ?? 0);
  const goals = Array.isArray(result?.goal_outcomes) ? result.goal_outcomes : [];
  const goalSummary = goals.length
    ? goals.map(g => `- ${g.name || g.id || 'Goal'}: probability ${g.probability != null && Number.isFinite(Number(g.probability)) ? `${Math.round(Number(g.probability) * (Number(g.probability) <= 1 ? 100 : 1))}%` : 'not available'}; target ${money(g.target || 0)}; shortfall ${money(g.shortfall || 0)}.`).join('\n')
    : '- No goals are configured in the current plan.';
  return `Deterministic plan summary\n\n- Monthly income: ${money(income)}\n- First-month modelled surplus: ${money(surplus)}\n- Modelled financial-health score: ${Math.round(health)}/100\n- Total modelled goal shortfall: ${money(shortfall)}\n\nGoal summary\n${goalSummary}\n\nThese are outputs from the current plan and model assumptions, not verified account balances or guarantees. Review inputs and assumptions before acting.`;
}

function openAIDrawer(initialQuery = null) {
  aiDrawerOpen = true;
  if (!aiMessages.length || initialQuery) {
    if (initialQuery) {
      handleChatSubmit(initialQuery);
    } else {
      aiMessages.push({role: 'ai', text: generateDeterministicAdvisoryMemo(plan, result)});
    }
  }
  renderAIDrawer();
}

function closeAIDrawer() {
  aiDrawerOpen = false;
  renderAIDrawer();
}

function renderAIDrawer() {
  let drawer = $('#ai-drawer-container');
  if (!drawer) return;

  const isLive = Boolean(aiConfig.apiKey || window.hasServerAIKey);

  drawer.innerHTML = `
    <div class="ai-drawer-backdrop ${aiDrawerOpen ? 'open' : ''}" id="ai-backdrop"></div>
    <aside class="ai-drawer ${aiDrawerOpen ? 'open' : ''}" aria-label="GoalPulse AI Co-Pilot">
      <div class="ai-drawer-head">
        <div>
          <h2>GoalPulse AI Co-Pilot ✨</h2>
          <span class="ai-badge ${aiConnectionState === 'failed' ? 'failed' : isLive && aiConnectionState === 'connected' ? 'live' : ''}">${isLive ? `${aiConfig.provider.toUpperCase()} • ${esc(aiConfig.model)} · ${aiConnectionState === 'connected' ? 'Connected' : aiConnectionState === 'failed' ? 'Connection failed' : 'Not tested'}` : 'Local plan summary'}</span>
        </div>
        <div class="actions">
          <button id="ai-settings-btn" title="Configure AI Key">⚙️ Settings</button>
          <button id="ai-close-btn" class="close" style="margin:0;padding:6px 10px">&times;</button>
        </div>
      </div>
      <div class="ai-drawer-body" id="ai-chat-thread">
        <div class="ai-chips">
          <p>Instant Advisory Prompts</p>
          <button class="ai-chip" data-ai-prompt="What if I increase monthly savings by ₹15,000?">🔮 What if I increase monthly savings by ₹15,000?</button>
          <button class="ai-chip" data-ai-prompt="Explain how the Debt Escape strategies save me interest and time.">⚡ Explain how the Debt Escape strategies save me interest.</button>
          <button class="ai-chip" data-ai-prompt="Which investment basket is safest if a 2008-style crash happens?">🛡️ Which investment basket is safest if a 2008 crash happens?</button>
          <button class="ai-chip" data-ai-prompt="Give me my exact step-by-step action checklist for this month.">📋 Give me my exact step-by-step action checklist for this month.</button>
        </div>
        ${aiMessages
          .map(
            m => `
          <div class="ai-msg ${m.role}">
            ${esc(m.text)
              .replace(/### (.*?)\n/g, '<h3>$1</h3>')
              .replace(/## (.*?)\n/g, '<h3>$1</h3>')
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/\n\n/g, '<p></p>')
              .replace(/• (.*?)\n/g, '<li>$1</li>')}
          </div>
        `
          )
          .join('')}
        ${aiThinking ? '<div class="ai-msg ai"><span class="spinner"></span>Preparing an explanation of the current plan…</div>' : ''}
      </div>
      <form class="ai-drawer-foot" id="ai-input-form">
        <input type="text" id="ai-user-query" placeholder="Ask any question or test a 'What if...' scenario..." required autocomplete="off">
        <button type="submit" class="primary">Send</button>
      </form>
    </aside>
  `;

  // Bind drawer events
  $('#ai-backdrop').onclick = closeAIDrawer;
  $('#ai-close-btn').onclick = closeAIDrawer;
  $('#ai-settings-btn').onclick = () => $('#ai-settings-dialog')?.showModal();

  document.querySelectorAll('.ai-chip').forEach(btn => {
    btn.onclick = () => {
      const q = btn.dataset.aiPrompt;
      handleChatSubmit(q);
    };
  });

  $('#ai-input-form').onsubmit = e => {
    e.preventDefault();
    const input = $('#ai-user-query');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    handleChatSubmit(q);
  };

  const thread = $('#ai-chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

// Check server AI status and fetch live market data on boot
fetch('/api/ai-status')
  .then(r => r.json())
  .then(s => {
    window.hasServerAIKey = Boolean(s.serverHasGeminiKey || s.serverHasOpenAIKey);
  })
  .catch(() => {});

function syncLiveMarket() {
  marketSyncing = true;
  render();
  fetch('/api/live-market')
    .then(r => r.json())
    .then(d => {
      marketSyncing = false;
      if (d.ok) {
        liveMarketData = d;
        toast(d.sourceStatus === 'live' ? 'Market feeds updated.' : `Market data status: ${d.sourceStatus || 'unknown'}. Check source labels before relying on values.`);
      }
      renderAsync();
    })
    .catch(() => {
      marketSyncing = false;
      render();
    });
}

// --- SHELL & UI MOUNT ---
function shell(content) {
  document.body.classList.toggle('dark', theme === 'dark');
  calcStore = calcStore || [];

  const familyDisplay = session ? session.familyName : plan.name;
  const familyIdDisplay = session ? session.familyId : '';

  $('#app').innerHTML = `
    <header class="topbar">
      <button class="nav-toggle" id="sidebar-toggle" title="Toggle Navigation Sidebar">☰</button>
      <a href="/overview" data-nav="overview" class="brand brand-mark sf-mark" aria-label="Home" title="Home"><svg viewBox="0 0 96 64" aria-hidden="true" focusable="false"><text x="2" y="52" font-family="Arial,Helvetica,sans-serif" font-size="60" font-weight="800" letter-spacing="-5" fill="currentColor">SF</text><rect x="80" y="43" width="10" height="10" rx="1" fill="#b97851"/></svg></a>
      <div class="planname"><strong>${esc(familyDisplay)}</strong></div>
      <div class="toptools">
        ${session ? `<span id="save-status" role="status" class="quiet">${vaultSaveState === 'saved' ? 'Saved to vault' : vaultSaveState === 'syncing' ? 'Syncing…' : 'Device copy · sync not confirmed'}</span><button id="btn-save-vault" class="primary">Save</button>` : `<button id="btn-open-login" class="primary">Sign In</button>`}
        <details class="feature-menu" id="feature-menu">
          <summary id="features-toggle">Features <span class="feature-chevron" aria-hidden="true">⌄</span></summary>
          <div class="feature-popover" aria-label="Application features">
            <span class="feature-label">PLAN ASSISTANT</span>
            <button id="open-ai-copilot">Explain my plan <span aria-hidden="true">✦</span></button>
            <button id="open-ai-settings" title="Configure AI API Key">AI settings <span aria-hidden="true">⚙</span></button>
            <span class="feature-label">DISPLAY</span>
            <button id="unit-toggle" class="units">Amount format <span>${units === 'compact' ? 'Lakh / Crore' : 'Full ₹'}</span></button>
            <button id="real-toggle">Value basis <span>${real ? 'Today’s ₹' : 'Nominal ₹'}</span></button>
            <button id="theme-toggle">Appearance <span>${theme === 'light' ? 'Light' : 'Dark'}</span></button>
            ${session ? `<div class="feature-account"><span class="feature-label">VAULT ID</span><span>${esc(familyIdDisplay)}</span></div><button id="btn-logout-vault" class="feature-logout" title="Logout from Family Vault">Sign out <span aria-hidden="true">↗</span></button>` : ''}
          </div>
        </details>
      </div>
    </header>
    <div class="layout ${sidebarCollapsed ? 'collapsed' : ''}">
      <aside class="sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${menu ? 'open' : ''}" aria-label="Main navigation">
        <p class="navgroup">Core Workflow</p>
        <a class="navlink ${route === 'overview' ? 'active' : ''}" href="/overview" data-nav="overview"><span class="num">01</span>My plan</a>
        <a class="navlink ${route === 'goals' ? 'active' : ''}" href="/goals" data-nav="goals"><span class="num">02</span>Goals</a>
        <a class="navlink ${route === 'stress' ? 'active' : ''}" href="/stress" data-nav="stress"><span class="num">03</span>What if?</a>
        <a class="navlink ${route === 'debt' ? 'active' : ''}" href="/debt" data-nav="debt"><span class="num">04</span>Debt tools</a>

        <details class="nav-diagnostics" ${['cashflow', 'invest', 'compare', 'action', 'copilot', 'method', 'profile', 'fix'].includes(route) ? 'open' : ''} style="margin-top:14px">
          <summary class="navgroup" style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;user-select:none;padding:4px 0">
            <span>Auditing &amp; Diagnostics</span>
            <span style="font-size:10px">▾</span>
          </summary>
          <a class="navlink ${route === 'cashflow' ? 'active' : ''}" href="/cashflow" data-nav="cashflow"><span class="num">05</span>Cash flow</a>
          <a class="navlink ${route === 'invest' ? 'active' : ''}" href="/invest" data-nav="invest"><span class="num">06</span>Investments</a>
          <a class="navlink ${route === 'compare' ? 'active' : ''}" href="/compare" data-nav="compare"><span class="num">07</span>Plan Comparator</a>
          <a class="navlink ${route === 'action' ? 'active' : ''}" href="/action" data-nav="action"><span class="num">08</span>Monthly actions</a>
          <a class="navlink ${route === 'copilot' ? 'active' : ''}" href="/copilot" data-nav="copilot"><span class="num">09</span>AI Financial Co-Pilot</a>
          <a class="navlink ${route === 'method' ? 'active' : ''}" href="/method" data-nav="method"><span class="num">10</span>Assumptions</a>
          <a class="navlink ${route === 'profile' ? 'active' : ''}" href="/profile" data-nav="profile"><span class="num">11</span>Your financial profile</a>
          <a class="navlink ${route === 'fix' ? 'active' : ''}" href="/fix" data-nav="fix"><span class="num">12</span>Planning options</a>
        </details>

        <div class="sidebottom">
          <b>Planning methodology</b>
          Estimates, not guarantees.
        </div>
      </aside>
      <main id="main" tabindex="-1">
        ${
          route !== 'start'
            ? `<div class="contextbar">
            <span class="loading">${
              busy
                ? '<i class="spinner"></i>Simulating 1,000 Stochastic Monte Carlo Paths…'
                : `${real ? 'Today’s purchasing power' : 'Nominal values'} · Updated with your inputs`
            }</span>
            <div class="locks">
              <label><input type="checkbox" data-field="locks.lifestyle" ${plan.locks.lifestyle ? 'checked' : ''}>Lock Lifestyle</label>
              <label><input type="checkbox" data-field="locks.dates" ${plan.locks.dates ? 'checked' : ''}>Lock Goal Dates</label>
            </div>
          </div>`
            : ''
        }
        ${lastError ? `<div class="error" role="alert">${esc(lastError)}</div>` : ''}
        ${recoveryBackup ? `<div class="callout warning"><div><strong>A saved plan needs review</strong><p>Your original saved inputs were kept as a recovery copy. Export them or explicitly fit their earmarks to available savings.</p><div class="actions"><button data-act="export-recovery">Export recovery copy</button><button data-act="restore-recovery">Repair saved earmarks and restore</button><button data-act="dismiss-recovery">Keep current plan</button></div></div></div>` : ''}
        ${content}
      </main>
    </div>
    <div id="ai-drawer-container"></div>
    <dialog id="ai-settings-dialog">
      <div style="padding:20px">
        <button id="close-ai-settings" class="close">&times;</button>
        <p class="eyebrow">AI CO-PILOT CONFIGURATION</p>
        <h2>Connect LLM Advisory Engine</h2>
        <p class="quiet">GoalPulse AI uses your API key to generate contextual CFP briefings grounded in verified deterministic engine math.</p>
        <div class="formgrid" style="grid-template-columns:1fr;margin:18px 0;gap:12px">
          <label class="field">AI Provider
            <select id="ai-provider-select">
              <option value="gemini" ${aiConfig.provider === 'gemini' ? 'selected' : ''}>Google Gemini (Recommended)</option>
              <option value="openai" ${aiConfig.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
            </select>
          </label>
          <label class="field">Model Name
            <input type="text" id="ai-model-input" value="${esc(aiConfig.model)}">
          </label>
          <label class="field">API Key (Stored locally in your browser)
            <input type="password" id="ai-key-input" placeholder="AIza... or sk-..." value="${esc(aiConfig.apiKey)}">
          </label>
        </div>
        <p class="quiet" style="font-size:11px">If no API key is provided, GoalPulse AI runs a local plan summary. Use the scenario controls to run new calculations.</p>
        <p id="ai-test-status" role="status" class="quiet" style="white-space:pre-wrap"></p>
        <div class="actions" style="margin-top:20px">
          <button id="test-ai-settings">Test connection</button><button id="save-ai-settings" class="primary">Save Configuration</button>
        </div>
      </div>
    </dialog>

    ${renderAuthModalHTML()}
  `;

  // Buttons rendered inside forms must not accidentally submit those forms.
  // Only controls explicitly marked type=submit should submit.
  $('#app').querySelectorAll('button:not([type])').forEach(button => { button.type = 'button'; });
  renderAIDrawer();
  bindEvents();
  updateHeaderSize();
}

function updateHeaderSize() { const height = $('.topbar')?.getBoundingClientRect().height; if (height) document.documentElement.style.setProperty('--header-height', height + 'px'); }
window.addEventListener('resize', updateHeaderSize);

function renderAuthModalHTML() {
  if (!authModalOpen) return '';

  return `
    <div class="auth-overlay" id="auth-modal-overlay">
      <div class="auth-box">
        <div class="auth-tabs">
          <button class="auth-tab ${authTab === 'login' ? 'active' : ''}" id="tab-login-btn">Sign In to Family Vault</button>
          <button class="auth-tab ${authTab === 'register' ? 'active' : ''}" id="tab-reg-btn">Register New Family (5-Step CFP Wizard)</button>
        </div>
        <div class="auth-body">
          ${authTab === 'login' ? renderLoginFormHTML() : renderRegistrationWizardHTML()}
        </div>
      </div>
    </div>
  `;
}

function renderLoginFormHTML() {
  return `
    <h2 style="font-size:20px;margin-bottom:6px">Access Your Family Wealth Vault</h2>
    <p class="quiet" style="margin-bottom:20px">Sign in with your unique Family ID to load your saved multi-goal balance sheet.</p>
    <form id="family-login-form">
      <div class="field" style="margin-bottom:14px">
        <label for="login-family-id">Family ID</label>
        <input type="text" id="login-family-id" placeholder="Your Family ID" required value="${esc(session?.familyId || '')}">
      </div>
      <div class="field" style="margin-bottom:20px">
        <label for="login-password">Vault Password</label>
        <input type="password" id="login-password" placeholder="••••••••" required>
      </div>
      <div class="actions" style="justify-content:space-between;margin-top:24px">
        <button type="submit" class="primary" style="padding:10px 20px">Sign In &amp; Load My Financial Plan →</button>
        <button type="button" id="btn-close-auth">Cancel</button>
      </div>
    </form>
  `;
}

function buildWizardPlan() {
  const newPlan = createEmptyHouseholdPlan();
  newPlan.name = regWizard.step1.familyName + ' Wealth Plan';
  const income = regWizard.step1;
  newPlan.income = Number(income.p1Fixed) + Number(income.p2Fixed) + Number(income.otherIncome) + (income.includeVariable ? Number(income.p1Variable) + Number(income.p2Variable) : 0);
  const costs = regWizard.step2, liability = regWizard.step4;
  newPlan.essential = Math.max(0, Number(costs.essential) - (costs.emiIncludedInLiving ? Number(costs.existingEmi) : 0)) + Number(costs.insurancePremiums || 0);
  newPlan.discretionary = Number(costs.discretionary);
  newPlan.savings = Number(costs.savings); newPlan.emergency = Number(costs.emergencyAllocated);
  for (const key of ['epf', 'ppf', 'nps', 'regularCorpus', 'unrealisedGains', 'familyPool', 'ufpi', 'bonus', 'basic', 'extraIncome']) newPlan[key] = 0;
  newPlan.term = Number(liability.term || 0); newPlan.health = Number(liability.health || 0); newPlan.topup = 0;
  newPlan.goals = regWizard.step3.goals.map((g,i)=>({...g, weight: Number(g.weight) || i+1, inflation: Number(g.inflation), scope:1, minScope:.8, hard:!g.flexible}));
  newPlan.loans = Number(liability.loanPrincipal) > 0 ? [{id:'loan-'+Date.now(),name:liability.loanName || 'Loan',principal:Number(liability.loanPrincipal),apr:Number(liability.loanApr),months:Number(liability.loanMonths),emi:Number(costs.existingEmi),floating:true,offset:false,autopay:false,extraMonthly:0}] : [];
  newPlan.statutoryGoal = 'retire'; newPlan.locks = {lifestyle:true,dates:true};
  newPlan.startDate = new Date().toISOString().slice(0,10);
  return newPlan;
}

function captureWizardInputs() {
  const fields = {
    'reg-id': ['step1','familyId'], 'reg-pwd': ['step1','password'], 'reg-name': ['step1','familyName'],
    'reg-salary-type': ['step1','salaryType'], 'reg-p1-fixed': ['step1','p1Fixed'], 'reg-p1-var': ['step1','p1Variable'],
    'reg-p2-fixed': ['step1','p2Fixed'], 'reg-p2-var': ['step1','p2Variable'], 'reg-other-income': ['step1','otherIncome'],
    'reg-essential': ['step2','essential'], 'reg-disc': ['step2','discretionary'], 'reg-emi': ['step2','existingEmi'],
    'reg-savings': ['step2','savings'], 'reg-emergency': ['step2','emergencyAllocated'], 'reg-insurance': ['step2','insurancePremiums'],
    'reg-loan-name': ['step4','loanName'], 'reg-loan-principal': ['step4','loanPrincipal'], 'reg-loan-apr': ['step4','loanApr'], 'reg-loan-months': ['step4','loanMonths'], 'reg-term': ['step4','term'], 'reg-health': ['step4','health']
  };
  for (const [id, [step, key]] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) regWizard[step][key] = el.type === 'number' ? Number(el.value) : el.value;
  }
  if ($('#reg-include-var')) regWizard.step1.includeVariable = $('#reg-include-var').value === 'yes';
  if ($('#reg-emi-included')) regWizard.step2.emiIncludedInLiving = $('#reg-emi-included').checked;
  regWizard.step3.goals.forEach((g, i) => {
    for (const key of ['cost','months','earmarked','inflation','tier']) {
      const el = document.getElementById(`reg-goal-${key}-${i}`);
      if (el) g[key] = el.type === 'number' ? Number(el.value) : el.value;
    }
    const flex = document.getElementById(`reg-goal-flex-${i}`);
    if (flex) g.flexible = flex.value === 'flexible';
  });
}

function capitalPanel(goals = plan.goals, editable = false) {
  const c = capitalSummary(plan, goals), base = Math.max(1, c.savings);
  return `<section class="panel capital-panel"><div class="panelhead"><div><h2>Your savings, split clearly</h2><p>Emergency + earmarks + available = total savings.</p></div><strong class="mono">${money(c.savings)} total</strong></div>
    <div class="capital-track" role="img" aria-label="Savings: ${money(c.reserve)} emergency, ${money(c.earmarked)} earmarked, ${money(c.free)} available"><span style="width:${Math.min(100,c.reserve/base*100)}%;background:var(--amber)"></span><span style="width:${Math.min(100,c.earmarked/base*100)}%;background:${c.excess ? 'var(--red)' : 'var(--accent)'}"></span><span style="width:${c.free/base*100}%;background:var(--green)"></span></div>
    <div class="capital-labels"><span>Emergency <b>${money(c.reserve)}</b></span><span>Earmarked <b>${money(c.earmarked)}</b></span><span>Available <b>${money(c.free)}</b></span></div>
    ${c.excess ? `<p class="bad" role="alert">Overallocated by ${money(c.excess)}. Only ${money(c.available)} is available after the emergency reserve.</p>` : ''}
    ${editable ? `<div class="actions"><button data-act="fit-earmarks" ${!c.excess ? 'disabled' : ''}>Fit draft earmarks to available savings</button><button data-act="clear-earmarks">Clear draft earmarks</button></div>` : ''}</section>`;
}

function renderRegistrationWizardHTML() {
  const stepTitles = [
    'HOUSEHOLD MEMBERS & INCOME',
    'EXPENSES & EXISTING COMMITMENTS',
    'FINANCIAL GOALS & PRIORITIES',
    'PLAN ASSUMPTIONS & LIABILITIES',
    'REVIEW & CALCULATE INITIAL PLAN'
  ];

  // Helper calculation for multi-earner income
  const p1Tot = (Number(regWizard.step1.p1Fixed) || 0) + (regWizard.step1.includeVariable ? (Number(regWizard.step1.p1Variable) || 0) : 0);
  const p2Tot = (Number(regWizard.step1.p2Fixed) || 0) + (regWizard.step1.includeVariable ? (Number(regWizard.step1.p2Variable) || 0) : 0);
  const otherTot = Number(regWizard.step1.otherIncome) || 0;
  const totInflow = p1Tot + p2Tot + otherTot;

  const essentialVal = Number(regWizard.step2.essential) || 0;
  const discVal = Number(regWizard.step2.discretionary) || 0;
  const emiVal = Number(regWizard.step2.existingEmi) || 0;
  const totOutflow = regWizard.step2.emiIncludedInLiving ? (essentialVal + discVal) : (essentialVal + discVal + emiVal);
  const monthlySurplus = totInflow - totOutflow - Number(regWizard.step2.insurancePremiums || 0);
  const reviewPlan = buildWizardPlan();
  const reviewErrors = validate(reviewPlan);
  const reviewResult = reviewErrors.length ? null : evaluate(reviewPlan);

  return `
    <div class="wizard-nav">
      <div class="wizard-step-bullet ${registerStep >= 1 ? 'active' : ''} ${registerStep > 1 ? 'done' : ''}"></div>
      <div class="wizard-step-bullet ${registerStep >= 2 ? 'active' : ''} ${registerStep > 2 ? 'done' : ''}"></div>
      <div class="wizard-step-bullet ${registerStep >= 3 ? 'active' : ''} ${registerStep > 3 ? 'done' : ''}"></div>
      <div class="wizard-step-bullet ${registerStep >= 4 ? 'active' : ''} ${registerStep > 4 ? 'done' : ''}"></div>
      <div class="wizard-step-bullet ${registerStep >= 5 ? 'active' : ''}"></div>
    </div>
    <p class="eyebrow">STEP ${registerStep} OF 5: ${stepTitles[registerStep - 1]}</p>

    <form id="wizard-form" novalidate>
      ${
        registerStep === 1 ? `
          <div style="background:var(--soft);padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid var(--accent)">
            <strong>Multi-Earner Household Inflow Model</strong>
            <p class="quiet" style="font-size:12px;margin:2px 0 0 0">Capture fixed take-home earnings, variable/seasonal amounts, and secondary household incomes.</p>
          </div>
          <div class="formgrid two">
            <label class="field">Unique Family ID<input type="text" id="reg-id" required value="${esc(regWizard.step1.familyId)}"></label>
            <label class="field">Vault Password<input type="password" id="reg-pwd" required value="${esc(regWizard.step1.password)}"></label>
            <label class="field">Household / Family Name<input type="text" id="reg-name" required value="${esc(regWizard.step1.familyName)}"></label>
            <label class="field">Income Reporting Mode
              <select id="reg-salary-type">
                <option value="take_home" ${regWizard.step1.salaryType === 'take_home' ? 'selected' : ''}>Take-Home Pay (Net after taxes &amp; PF)</option>
                <option disabled value="gross" ${regWizard.step1.salaryType === 'gross' ? 'selected' : ''}>Gross CTC (Before statutory deductions)</option>
              </select>
            </label>
            <label class="field">Person 1 — Monthly Take-Home (₹)<input type="number" id="reg-p1-fixed" required value="${regWizard.step1.p1Fixed}"></label>
            <label class="field">Person 1 — Average Variable / Bonus (₹)<input type="number" id="reg-p1-var" value="${regWizard.step1.p1Variable}"></label>
            <label class="field">Person 2 — Monthly Take-Home (₹)<input type="number" id="reg-p2-fixed" value="${regWizard.step1.p2Fixed}"></label>
            <label class="field">Person 2 — Average Variable / Bonus (₹)<input type="number" id="reg-p2-var" value="${regWizard.step1.p2Variable}"></label>
            <label class="field">Other Recurring Household Income (₹)<input type="number" id="reg-other-income" value="${regWizard.step1.otherIncome}"></label>
            <label class="field">Variable Income Treatment
              <select id="reg-include-var">
                <option value="yes" ${regWizard.step1.includeVariable ? 'selected' : ''}>Include Variable Income (Standard Estimate)</option>
                <option value="no" ${!regWizard.step1.includeVariable ? 'selected' : ''}>Exclude Variable Income (Conservative Plan)</option>
              </select>
            </label>
          </div>
          <div style="background:var(--tint);padding:10px 14px;border-radius:6px;margin-top:12px;font-size:13px;display:flex;justify-content:space-between;align-items:center">
            <span>Aggregated Household Inflow:</span>
            <strong style="color:var(--accent);font-size:15px">${money(totInflow)} / Month</strong>
          </div>
        ` : registerStep === 2 ? `
          <div style="background:var(--soft);padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid var(--accent)">
            <strong>Living Expenses &amp; Debt Commitments</strong>
            <p class="quiet" style="font-size:12px;margin:2px 0 0 0">Establish actual cash flow before committing to goals. EMIs are isolated to avoid double counting.</p>
          </div>
          <div class="formgrid two">
            <label class="field">Monthly Essential Living Expenses (₹)<input type="number" id="reg-essential" required value="${regWizard.step2.essential}"></label>
            <label class="field">Monthly Discretionary Lifestyle Expenses (₹)<input type="number" id="reg-disc" required value="${regWizard.step2.discretionary}"></label>
            <label class="field">Existing EMIs &amp; Required Debt Payments (₹)<input type="number" id="reg-emi" required value="${regWizard.step2.existingEmi}"></label>
            <label class="field">Total Liquid Savings / Bank Deposits (₹)<input type="number" id="reg-savings" required value="${regWizard.step2.savings}"></label>
            <label class="field">Emergency Reserve Earmarked from Savings (₹)<input type="number" id="reg-emergency" required value="${regWizard.step2.emergencyAllocated}"></label>
            <label class="field">Insurance Premiums &amp; Other Commitments (₹/mo)<input type="number" id="reg-insurance" value="${regWizard.step2.insurancePremiums || 0}"></label>
          </div>
          <div style="margin-top:12px">
            <label class="checkfield" style="font-size:13px">
              <input type="checkbox" id="reg-emi-included" ${regWizard.step2.emiIncludedInLiving ? 'checked' : ''}>
              Required EMI is ALREADY included in the Essential Living Expenses reported above (Do not deduct twice)
            </label>
          </div>
          <div style="background:var(--tint);padding:12px 14px;border-radius:6px;margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:13px">
            <div>
              <span>Available Monthly Cash Surplus:</span>
              <div class="quiet" style="font-size:11px">Formula: Inflow (${money(totInflow)}) − Living (${money(essentialVal + discVal)}) − EMIs (${regWizard.step2.emiIncludedInLiving ? 'Included in Living' : money(emiVal)})</div>
            </div>
            <strong style="font-size:16px;color:${monthlySurplus >= 0 ? 'var(--green)' : 'var(--red)'}">
              ${money(monthlySurplus)} / Month ${monthlySurplus < 0 ? '(Deficit)' : ''}
            </strong>
          </div>
        ` : registerStep === 3 ? `
          <div style="background:var(--soft);padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid var(--accent)">
            <strong>Financial Goals &amp; Horizons</strong>
            <p class="quiet" style="font-size:12px;margin:2px 0 0 0">Configure each goal's today cost (PV), deadline in months, priority tier, and dedicated savings.</p>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${regWizard.step3.goals.map((g, i) => `
              <div style="background:var(--soft);padding:12px;border-radius:6px;border:1px solid var(--border)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <strong>${esc(g.name)}</strong>
                  <span class="pill" style="font-size:11px">${g.tier} Priority</span>
                </div>
                <div class="formgrid three">
                  <label class="field">Today's Target Cost (PV ₹)<input type="number" id="reg-goal-cost-${i}" value="${g.cost}"></label>
                  <label class="field">Target Horizon (Months)<input type="number" id="reg-goal-months-${i}" value="${g.months}"></label>
                  <label class="field">Priority Tier
                    <select id="reg-goal-tier-${i}">
                      <option value="Need" ${g.tier === 'Need' ? 'selected' : ''}>Need (Non-negotiable)</option>
                      <option value="Want" ${g.tier === 'Want' ? 'selected' : ''}>Want (Flexible)</option>
                      <option value="Wish" ${g.tier === 'Wish' ? 'selected' : ''}>Wish (Aspirational)</option>
                    </select>
                  </label>
                  <label class="field">Existing Allocated Savings (₹)<input type="number" id="reg-goal-earmarked-${i}" ${g.category === 'emergency' ? 'disabled title="Reserve is already entered in Step 2"' : ''} value="${g.earmarked || 0}"></label>
                  <label class="field">Assumed Inflation (decimal)<input type="number" step="0.01" id="reg-goal-inflation-${i}" value="${g.inflation ?? 0.06}"></label>
                  <label class="field">Deadline Flexibility
                    <select id="reg-goal-flex-${i}">
                      <option value="flexible" ${g.flexible ? 'selected' : ''}>Flexible (Can extend if shock occurs)</option>
                      <option value="fixed" ${!g.flexible ? 'selected' : ''}>Fixed (Hard non-negotiable date)</option>
                    </select>
                  </label>
                </div>
              </div>
            `).join('')}
          </div>
        ` : registerStep === 4 ? `
          <div style="background:var(--soft);padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid var(--accent)">
            <strong>Planning Assumptions &amp; Balance Sheet Protections</strong>
            <p class="quiet" style="font-size:12px;margin:2px 0 0 0">Establish explicit inflation, expected investment returns, and debt parameters.</p>
          </div>
          <div class="formgrid two">
            <label class="field">Annual Baseline Inflation Rate (decimal)<input disabled title="Category inflation is set for each goal in Step 3" type="number" step="0.005" id="reg-assump-infl" value="${regWizard.step4.generalInflation}"></label>
            <label class="field">Assumed Investment Portfolio Return (decimal)<input disabled title="Returns use the configured asset basket and glide path" type="number" step="0.005" id="reg-assump-return" value="${regWizard.step4.expectedReturn}"></label>
            <label class="field">Active Loan Name<input type="text" id="reg-loan-name" value="${regWizard.step4.loanName}"></label>
            <label class="field">Outstanding Principal Balance (₹)<input type="number" id="reg-loan-principal" value="${regWizard.step4.loanPrincipal}"></label>
            <label class="field">Loan Interest Rate (APR decimal)<input type="number" step="0.001" id="reg-loan-apr" value="${regWizard.step4.loanApr}"></label>
            <label class="field">Remaining Loan Tenure (Months)<input type="number" id="reg-loan-months" value="${regWizard.step4.loanMonths}"></label><label class="field">Term life cover (₹)<input id="reg-term" type="number" min="0" value="${regWizard.step4.term}"></label><label class="field">Health cover (₹)<input id="reg-health" type="number" min="0" value="${regWizard.step4.health}"></label>
          </div>
          <div style="margin-top:14px">
            <label class="checkfield" style="font-size:13px">
              <input type="checkbox" disabled id="reg-lock-emergency" ${regWizard.step4.lockEmergencySavings ? 'checked' : ''}>
              Emergency refill is prioritised before goals. Income deficits and medical shocks can draw the reserve.
            </label>
          </div>
        ` : `
          <div style="background:var(--soft);padding:12px 16px;border-radius:6px;margin-bottom:16px;border-left:3px solid var(--accent)">
            <strong>Review your financial plan</strong>
            <p class="quiet" style="font-size:12px;margin:4px 0 0 0">Review your household cash flow and projections before continuing.</p>
          </div>

          <div class="metrics" style="grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));margin-bottom:18px">
            <div class="metric"><label>Monthly Inflow</label><strong>${money(totInflow)}</strong><small>Aggregated Inflow</small></div>
            <div class="metric"><label>Living Costs &amp; EMIs</label><strong>${money(totOutflow)}</strong><small>Living + Debt Service</small></div>
            <div class="metric"><label>Available Monthly surplus</label><strong class="${monthlySurplus >= 0 ? 'good' : 'bad'}">${money(monthlySurplus)}</strong><small>Investable for Goals</small></div>
            <div class="metric"><label>Liquid Savings</label><strong>${money(regWizard.step2.savings)}</strong><small>${money(regWizard.step2.emergencyAllocated)} Emergency</small></div>
          </div>

          <div class="tablewrap" style="margin-bottom:16px">
            <table class="compacttable">
              <thead>
                <tr>
                  <th>Goal Name</th>
                  <th>Current PV</th>
                  <th>Target Date</th>
                  <th>Future Cost (FV)</th>
                  <th>Earmarked</th>
                  <th>Required / Month</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${regWizard.step3.goals.map((g, idx) => {
                  const tYears = g.months / 12;
                  const fv = Math.round(g.cost * Math.pow(1 + (g.inflation || 0.06), tYears));
                  const remaining = Math.max(0, fv - (g.earmarked || 0));
                  const outcome = reviewResult?.goal_outcomes.find(x => x.id === g.id);
                  const reqMonthly = Math.round(outcome?.required || 0);
                  
                  const outcomeReady = outcome && outcome.shortfall <= 1 && reviewResult.unfunded <= 1;
                  let statusHtml = `<span class="status ${outcomeReady ? 'good' : 'warn'}">${!reviewResult ? 'Fix input errors' : outcomeReady ? 'Deterministic target funded' : 'Needs adjustment'}</span>`;

                  return `
                    <tr>
                      <td><strong>${esc(g.name)}</strong></td>
                      <td>${money(g.cost)}</td>
                      <td>${g.months} Mo</td>
                      <td style="font-weight:600">${money(fv)}</td>
                      <td>${money(g.earmarked || 0)}</td>
                      <td><strong>${money(reqMonthly)}/mo</strong></td>
                      <td>${statusHtml}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          <p class="quiet" style="font-size:11px;margin-bottom:12px">
            ${reviewErrors.length ? esc(reviewErrors.join(' ')) : 'Probabilities are calculated after launch.'} Future values computed deterministically via FV = PV(1 + i)ᵗ. All goals read from the single authoritative calculation engine.
          </p>
        `
      }

      <div class="actions" style="justify-content:space-between;margin-top:24px">
        ${registerStep > 1 ? `<button type="button" id="btn-wiz-prev">← Previous</button>` : `<button type="button" id="btn-close-auth-wiz">Cancel</button>`}
        ${registerStep < 5 ? `<button type="submit" class="primary" id="btn-wiz-next">Next Step →</button>` : `<button type="submit" class="primary" id="btn-wiz-complete">Calculate Initial Financial Plan &amp; Launch Cockpit →</button>`}
      </div>
    </form>
  `;
}

function bindEvents() {
  // Sidebar Collapse Button (Works on Desktop & Mobile)
  $('#sidebar-toggle')?.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 800px)').matches) {
      menu = !menu; sidebarCollapsed = false;
    } else {
      sidebarCollapsed = !sidebarCollapsed; menu = false;
    }
    $('.layout')?.classList.toggle('collapsed', sidebarCollapsed);
    $('.sidebar')?.classList.toggle('collapsed', sidebarCollapsed);
    $('.sidebar')?.classList.toggle('open', menu);
    updateHeaderSize();
  });


  // Auth Modal Buttons
  $('#tab-login-btn')?.addEventListener('click', () => { authTab = 'login'; render(); });
  $('#tab-reg-btn')?.addEventListener('click', () => { authTab = 'register'; render(); });
  $('#btn-close-auth')?.addEventListener('click', () => { authModalOpen = false; render(); });
  $('#btn-close-auth-wiz')?.addEventListener('click', () => { authModalOpen = false; render(); });
  $('#btn-open-login')?.addEventListener('click', () => { authModalOpen = true; authTab = 'login'; render(); });

  // Login submission
  $('#family-login-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const familyId = $('#login-family-id').value.trim();
    const password = $('#login-password').value;
    if (!familyId || !password) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({familyId, password})
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Login failed');

      aiMessages = []; aiDrawerOpen = false; recoveryBackup = null;
      session = {familyId: data.familyId, familyName: data.familyName, token: data.token};
      localStorage.setItem('goalpulse_family_session', JSON.stringify(session));
      plan = data.plan && validate(data.plan).length === 0 ? data.plan : createEmptyHouseholdPlan();
      if (data.plan && validate(data.plan).length) { recoveryBackup = {plan:data.plan}; try { localStorage.setItem(recoveryKey(), JSON.stringify(recoveryBackup)); } catch {} }
      snapshots = Array.isArray(data.snapshots) ? data.snapshots.filter(x => x?.plan && x?.result && !validate(x.plan).length).slice(0, 3) : [];
      scenarioBaseline = null;
      authModalOpen = false;
      compute();
      toast(`Signed in to ${data.familyName} Vault.`);
      navigate('overview');
    } catch (err) {
      // Never treat a device-only plan as proof of identity or a server-backed login.
      toast('Login failed: ' + err.message + ' Your local plan was not used to bypass authentication.');
    }
  });

  // Wizard navigation & P0 submission
  $('#wizard-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (registerStep < 5) {
      // Validate wizard steps explicitly so browser-native validation cannot silently
      // block the Next button without showing a useful message.
      const rejectStep = (message, selector) => {
        toast(message);
        const field = selector ? $(selector) : null;
        if (field) { field.focus(); if (typeof field.reportValidity === 'function') field.reportValidity(); }
      };
      // Collect step data
      if (registerStep === 1) {
        regWizard.step1.familyId = $('#reg-id').value.trim();
        regWizard.step1.password = $('#reg-pwd').value;
        regWizard.step1.familyName = $('#reg-name').value.trim();
        if (!/^[A-Za-z0-9_-]{4,48}$/.test(regWizard.step1.familyId)) { rejectStep('Use a Family ID of 4–48 letters, numbers, underscores or hyphens.', '#reg-id'); return; }
        if (regWizard.step1.password.length < 8) { rejectStep('Choose a password with at least 8 characters.', '#reg-pwd'); return; }
        if (!regWizard.step1.familyName) { rejectStep('Enter a household name.', '#reg-name'); return; }
        const incomeFields = ['#reg-p1-fixed', '#reg-p1-var', '#reg-p2-fixed', '#reg-p2-var', '#reg-other-income'];
        for (const selector of incomeFields) {
          const field = $(selector);
          const value = field.value.trim() === '' ? 0 : Number(field.value);
          if (!Number.isFinite(value) || value < 0) { rejectStep('Income values must be zero or a positive monthly amount.', selector); return; }
        }
        regWizard.step1.salaryType = $('#reg-salary-type').value;
        regWizard.step1.p1Fixed = Number($('#reg-p1-fixed').value) || 0;
        regWizard.step1.p1Variable = Number($('#reg-p1-var').value) || 0;
        regWizard.step1.p2Fixed = Number($('#reg-p2-fixed').value) || 0;
        regWizard.step1.p2Variable = Number($('#reg-p2-var').value) || 0;
        regWizard.step1.otherIncome = Number($('#reg-other-income').value) || 0;
        regWizard.step1.includeVariable = $('#reg-include-var').value === 'yes';
      } else if (registerStep === 2) {
        const expenseFields = ['#reg-essential', '#reg-disc', '#reg-emi', '#reg-savings', '#reg-emergency', '#reg-insurance'];
        for (const selector of expenseFields) {
          const field = $(selector);
          const value = field.value.trim() === '' ? 0 : Number(field.value);
          if (!Number.isFinite(value) || value < 0) { rejectStep('Expense, EMI, savings and reserve values must be zero or positive.', selector); return; }
        }
        regWizard.step2.essential = Number($('#reg-essential').value) || 0;
        regWizard.step2.discretionary = Number($('#reg-disc').value) || 0;
        regWizard.step2.existingEmi = Number($('#reg-emi').value) || 0;
        regWizard.step2.savings = Number($('#reg-savings').value) || 0;
        regWizard.step2.emergencyAllocated = Number($('#reg-emergency').value) || 0;
        regWizard.step2.insurancePremiums = Number($('#reg-insurance').value) || 0;
        regWizard.step2.emiIncludedInLiving = $('#reg-emi-included').checked;
      } else if (registerStep === 3) {
        regWizard.step3.goals.forEach((g, i) => {
          const costEl = $(`#reg-goal-cost-${i}`);
          const monthsEl = $(`#reg-goal-months-${i}`);
          const tierEl = $(`#reg-goal-tier-${i}`);
          const earEl = $(`#reg-goal-earmarked-${i}`);
          const inflEl = $(`#reg-goal-inflation-${i}`);
          const flexEl = $(`#reg-goal-flex-${i}`);
          if (costEl) g.cost = Number(costEl.value);
          if (monthsEl) g.months = Number(monthsEl.value) || g.months;
          if (tierEl) g.tier = tierEl.value || g.tier;
          if (earEl) g.earmarked = Number(earEl.value) || 0;
          if (inflEl) g.inflation = Number(inflEl.value);
          if (flexEl) g.flexible = flexEl.value === 'flexible';
        });
      } else if (registerStep === 4) {
        regWizard.step4.generalInflation = Number($('#reg-assump-infl').value) || 0.06;
        regWizard.step4.expectedReturn = Number($('#reg-assump-return').value) || 0.105;
        regWizard.step4.loanName = $('#reg-loan-name').value.trim() || 'Home Loan';
        regWizard.step4.loanPrincipal = Number($('#reg-loan-principal').value) || 0;
        regWizard.step4.loanApr = Number($('#reg-loan-apr').value) || 0.088;
        regWizard.step4.loanMonths = Number($('#reg-loan-months').value) || 180;
        regWizard.step4.lockEmergencySavings = $('#reg-lock-emergency').checked;
      }
      registerStep++;
      render();
    } else {
      const newPlan = buildWizardPlan();
      if (newPlan.goals.some(g => !Number.isFinite(g.cost) || g.cost <= 0 || !Number.isFinite(g.months) || g.months <= 0)) { toast('Enter a positive amount and deadline for every goal.'); return; }
      if (newPlan.income <= 0) { toast('Enter your household income before creating your plan.'); return; }
      if (regWizard.step2.existingEmi > 0 && !newPlan.loans.length) { toast('Enter the outstanding loan principal to model your EMI.'); registerStep = 4; render(); return; }
      const planErrors = validate(newPlan);
      if (planErrors.length) { toast(planErrors.join(' ')); return; }
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            familyId: regWizard.step1.familyId,
            password: regWizard.step1.password,
            familyName: regWizard.step1.familyName,
            plan: newPlan
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Registration failed');

        aiMessages = []; aiDrawerOpen = false; recoveryBackup = null;
      session = {familyId: data.familyId, familyName: data.familyName, token: data.token};
        localStorage.setItem('goalpulse_family_session', JSON.stringify(session));
        plan = newPlan;
        snapshots = [];
        scenarioBaseline = null;
        authModalOpen = false;
        compute();
        toast(`Registered and calculated initial plan for ${session.familyName}.`);
        navigate('overview');
      } catch (err) {
        // Keep the user on the registration flow; do not report local-only data as a registered account.
        toast('Registration was not completed on the server: ' + err.message + '. Check the backend and try again.');
      }
    }
  });

  $('#wizard-form')?.addEventListener('input', captureWizardInputs);
  $('#wizard-form')?.addEventListener('change', captureWizardInputs);

  $('#btn-wiz-prev')?.addEventListener('click', () => {
    if (registerStep > 1) {
      registerStep--;
      render();
    }
  });

  $('#plan-import')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw Error('Use a plan export smaller than 2 MB.');
      const data = JSON.parse(await file.text());
      const imported = data?.plan || data;
      const errors = validate(imported);
      if (errors.length) throw Error(errors.join(' '));
      const previous = clone(plan);
      localStorage.setItem(importBackupKey(), JSON.stringify({plan:previous}));
      plan = clone(imported);
      plan.assets = plan.assets || createEmptyHouseholdPlan().assets;
      scenarioBaseline = null; goalDraft = null;
      changed(); render();
      toast('Plan imported and recalculated. A copy of the previous plan is kept on this device.');
    } catch (error) { toast('Import was not applied: ' + error.message); }
  });

  // Vault Save and Logout
  $('#btn-save-vault')?.addEventListener('click', async () => {
    const status = await persist();
    if (status.serverSaved) toast('Plan changes saved to your Family Vault.');
    else if (status.localSaved && status.hasSession) toast('Saved on this device, but server sync was not confirmed. Export a backup or retry when connected.');
    else if (status.localSaved) toast('Saved on this device. Sign in to sync this plan to your Family Vault.');
  });

  $('#btn-logout-vault')?.addEventListener('click', async () => {
    await saveQueue;
    const previous = session;
    if (previous?.token) { try { await fetch('/api/auth/logout', {method: 'POST', headers: {Authorization: `Bearer ${previous.token}`}, signal: AbortSignal.timeout(5000)}); } catch {} }
    session = null; aiMessages = []; aiDrawerOpen = false; recoveryBackup = null;
    plan = createEmptyHouseholdPlan(); snapshots = []; scenarioBaseline = null;
    changed();
    localStorage.removeItem('goalpulse_family_session');
    toast('Logged out from Family Vault.');
    authModalOpen = true;
    authTab = 'login';
    render();
  });

  // Navigation Links
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.onclick = e => {
      e.preventDefault();
      navigate(el.dataset.nav);
    };
  });

  // Calculations Popover
  document.querySelectorAll('[data-calc]').forEach(el => {
    el.onclick = () => openCalculation(calcStore[+el.dataset.calc]);
  });

  for (const [id, set, max] of [
    ['debt-extra', v => debtExtra = v, 1e9], ['debt-rate', v => debtRate = v, .6], ['debt-fee', v => debtFee = v, 1e9]
  ]) document.getElementById(id)?.addEventListener('change', event => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value < 0 || value > max) { toast('Enter a value within the displayed limits.'); render(); return; }
    set(value); render();
  });
  for (const [id, set] of [['debt-extra',v=>debtExtra=v],['debt-rate',v=>debtRate=v],['debt-fee',v=>debtFee=v]]) document.getElementById(id)?.addEventListener('input', event => { const v=Number(event.target.value); if (event.target.checkValidity() && Number.isFinite(v)) set(v); });
  $('#debt-preview')?.addEventListener('click', () => render());
  $('#debt-loan')?.addEventListener('change', event => { selectedLoan = Number(event.target.value); render(); });

  $('#projection-goal')?.addEventListener('change', event => { selectedGoal = event.target.value; render(); });

  // Live Market Sync Button
  $('#btn-sync-market')?.addEventListener('click', syncLiveMarket);
  $('#btn-sync-market-2')?.addEventListener('click', syncLiveMarket);

  // Theme, Units, Real Toggles
  $('#theme-toggle').onclick = () => {
    theme = theme === 'light' ? 'dark' : 'light';
    persist();
    render();
  };
  $('#unit-toggle').onclick = () => {
    units = units === 'compact' ? 'full' : 'compact';
    persist();
    render();
  };
  $('#real-toggle').onclick = () => {
    real = !real;
    persist();
    render();
  };

  // AI Buttons
  $('#open-ai-copilot')?.addEventListener('click', () => openAIDrawer());
  $('#btn-open-drawer-pg')?.addEventListener('click', () => openAIDrawer());
  document.querySelectorAll('[data-act="explain"]').forEach(el => {
    // Use a direct, explicit action for every Explain button.
    el.type = 'button';
    el.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      openAIDrawer();
    };
  });
  document.querySelectorAll('.ai-chip').forEach(btn => {
    btn.onclick = () => {
      const q = btn.dataset.aiPrompt;
      openAIDrawer(q);
    };
  });
  $('#open-ai-settings')?.addEventListener('click', () => $('#ai-settings-dialog')?.showModal());
  $('#close-ai-settings')?.addEventListener('click', () => $('#ai-settings-dialog')?.close());
  $('#ai-provider-select')?.addEventListener('change', event => {
    $('#ai-model-input').value = normalizeAIModel(event.target.value, '');
    $('#ai-test-status').textContent = '';
  });
  $('#test-ai-settings')?.addEventListener('click', async () => {
    const button = $('#test-ai-settings'), status = $('#ai-test-status');
    button.disabled = true;
    status.textContent = 'Testing the selected model…';
    try {
      status.textContent = await requestAI({provider:$('#ai-provider-select').value, model:normalizeAIModel($('#ai-provider-select').value, $('#ai-model-input').value), apiKey:$('#ai-key-input').value.trim() || undefined}, '/api/ai-test');
      status.className = 'good';
    } catch (error) { status.textContent = error.message; status.className = 'bad'; }
    finally { button.disabled = false; }
  });
  $('#save-ai-settings')?.addEventListener('click', () => {
    aiConfig.provider = $('#ai-provider-select').value;
    aiConfig.model = normalizeAIModel(aiConfig.provider, $('#ai-model-input').value);
    aiConnectionState = 'untested';
    aiConfig.apiKey = $('#ai-key-input').value.trim();
    try {
    localStorage.setItem('goalpulse-ai-provider', aiConfig.provider);
    localStorage.setItem('goalpulse-ai-model', aiConfig.model);
    localStorage.setItem('goalpulse-ai-key', aiConfig.apiKey);
    localStorage.setItem('goalpulse_ai_key', aiConfig.apiKey);
    } catch { toast('AI settings are active for this session; browser storage is unavailable.'); }
    $('#ai-settings-dialog')?.close();
    toast('AI Co-Pilot configuration saved.');
    renderAIDrawer();
    if (route === 'copilot') render();
  });

  // Dedicated Copilot Route Page Chat Form
  $('#copilot-page-chat-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#copilot-page-chat-input');
    const q = input?.value?.trim();
    if (!q) return;
    input.value = '';
    handleChatSubmit(q);
  });

  // Form Field Inputs
  document.querySelectorAll('[data-field]').forEach(el => {
    // Lock switches are controls, never AI-launch triggers. Stop click bubbling so
    // parent containers or delegated listeners cannot interpret the toggle as an action.
    if (el.dataset.field === 'locks.lifestyle' || el.dataset.field === 'locks.dates') {
      el.addEventListener('click', event => event.stopPropagation());
    }
    el.onchange = event => {
      if (el.dataset.field === 'locks.lifestyle' || el.dataset.field === 'locks.dates') {
        event?.stopPropagation();
      }
      if (!el.checkValidity()) { el.reportValidity(); return; }
      const old = clone(plan), path = el.dataset.field;
      const value = el.type === 'checkbox' ? Boolean(el.checked) : el.type === 'number' ? Number(el.value) : el.value;
      try {
        setValue(path, value);
        if (path.match(/^goals\.\d+\.category$/)) {
          const i = +path.split('.')[1];
          plan.goals[i].inflation = C.inflation[value] ?? 0.06;
        }
        const errors = validate(plan);
        if (errors.length) { plan = old; toast(errors.join(' ')); render(); return; }
        // Commit the exact checked/selected value before recomputing. compute() persists the full plan.
        persist();
        editingCommit = true;
        try { changed(); } finally { editingCommit = false; }
      } catch (e) { plan = old; toast(e.message); render(); }
    };
  });

  document.querySelectorAll('[data-field]').forEach(el => {
    if (el.type === 'checkbox' || el.tagName === 'SELECT') return;
    const commit = el.onchange;
    el.onchange = event => { pendingInput = null; clearTimeout(inputTimer); commit?.(event); };
    el.oninput = () => { if (pendingInput && pendingField !== el) flushInput(); pendingField = el; pendingInput = () => commit?.({stopPropagation() {}}); clearTimeout(inputTimer); inputTimer = setTimeout(flushInput, 500); };
  });

  // Destructive/list actions must be explicitly bound after every render.
  document.querySelectorAll('[data-remove-loan]').forEach(btn => {
    btn.type = 'button';
    btn.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      const index = Number(btn.dataset.removeLoan);
      if (!Number.isInteger(index) || index < 0 || index >= plan.loans.length) return;
      const removed = plan.loans[index];
      plan.loans.splice(index, 1);
      selectedLoan = Math.max(0, Math.min(selectedLoan, plan.loans.length - 1));
      changed();
      toast(`Removed loan “${removed.name}” from this plan. The plan has been recalculated. Check the vault sync indicator.`);
    };
  });
  document.querySelectorAll('[data-remove-goal]').forEach(btn => {
    btn.type = 'button';
    btn.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (!goalDraft) goalDraft = clone(plan.goals);
      const index = Number(btn.dataset.removeGoal);
      if (!Number.isInteger(index) || index < 0 || index >= goalDraft.length) return;
      const removed = goalDraft.splice(index, 1)[0];
      goalDraftResult = null;
      render();
      toast(`Removed “${removed.name}” from the draft. Recalculate and apply to update the active plan.`);
    };
  });
  document.querySelectorAll('[data-delete-snapshot]').forEach(btn => {
    btn.type = 'button';
    btn.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      const index = Number(btn.dataset.deleteSnapshot);
      if (!Number.isInteger(index) || index < 0 || index >= snapshots.length) return;
      snapshots.splice(index, 1);
      persist(); render();
      toast('Plan snapshot deleted.');
    };
  });
  document.querySelectorAll('[data-load-snapshot]').forEach(btn => {
    btn.type = 'button';
    btn.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      const index = Number(btn.dataset.loadSnapshot);
      const snapshot = snapshots[index];
      if (!snapshot?.plan || validate(snapshot.plan).length) { toast('This snapshot is invalid and cannot be loaded.'); return; }
      plan = clone(snapshot.plan);
      plan.assets = plan.assets || {goldGrams: 0, goldPricePerGram: 0, jewelleryGrams: 0, jewelleryPricePerGram: 0, silverGrams: 0, silverPricePerGram: 0, landValue: 0, otherPreciousValue: 0};
      changed();
      toast(`Loaded copy of ${snapshot.label}. Save the plan to persist this as your active plan.`);
    };
  });

  // Optimization Switch Toggles
  document.querySelectorAll('[data-opt-toggle]').forEach(toggle => {
    toggle.onchange = e => {
      const key = toggle.dataset.optToggle;
      plan.optimizations = plan.optimizations || {};
      plan.optimizations[key] = toggle.checked;
      plan.opt = plan.opt || {};
      if (key === 'cashUpgrade') plan.opt.cashUpgrade = plan.cashUpgrade = toggle.checked;
      if (key === 'directFeeRecapture') plan.opt.direct = plan.direct = toggle.checked;
      if (key === 'ltcgTaxHarvest') plan.harvest = toggle.checked;
      persist();
      changed();
      const optMeta = getDynamicOptimizationLevers(plan, result).find(l => l.key === key);
      toast(`${optMeta?.title || key} ${toggle.checked ? 'activated' : 'deactivated'}. Plan recalculated.`);
    };
  });

  $('#btn-open-shock-demo')?.addEventListener('click', () => navigate('stress'));

  // Priority Presets (Feature 1)
  document.querySelectorAll('[data-priority-preset]').forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.priorityPreset;
      const edu = plan.goals.find(g => g.category === 'education' || g.id === 'education');
      const ret = plan.goals.find(g => g.category === 'retirement' || g.id === 'retire');
      const em = plan.goals.find(g => g.category === 'emergency' || g.id === 'emergency');
      if (mode === 'edu') {
        if (em) em.weight = 1;
        if (edu) edu.weight = 3;
        if (ret) ret.weight = 1;
        changed();
        toast('Education priority updated. Recalculate and review the impact across all goals.');
      } else if (mode === 'retire') {
        if (em) em.weight = 1;
        if (ret) ret.weight = 3;
        if (edu) edu.weight = 1;
        changed();
        toast('Retirement priority updated. Recalculate and review the impact across all goals.');
      } else if (mode === 'equal') {
        plan.goals.forEach(g => (g.weight = 2));
        changed();
        toast('Goal weights reset to equal priority. Review the recalculated allocation; equal priority does not guarantee equal funding.')
      }
    };
  });

  // Goal Draft Inputs & Actions (Goals Page)
  document.querySelectorAll('[data-draft-field]').forEach(el => {
    el.onchange = () => {
      if (!goalDraft) goalDraft = clone(plan.goals);
      let path = el.dataset.draftField;
      let val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : (el.value === 'true' ? true : (el.value === 'false' ? false : el.value));
      let parts = path.split('.');
      let idx = Number(parts[1]);
      let key = parts[2];
      if (goalDraft[idx]) {
        goalDraft[idx][key] = val;
        goalDraftResult = null;
        if (key === 'category') {
          goalDraft[idx].inflation = C.inflation[val] ?? 0.06;
        }
      }
    };
  });

  document.querySelectorAll('[data-draft-field]').forEach(el => { el.oninput = el.onchange; });

  $('#btn-recalc-goals')?.addEventListener('click', () => {
    flushInput();
    if (!goalDraft) goalDraft = clone(plan.goals);
    const draftPlan = { ...plan, goals: clone(goalDraft) };
    const errors = validate(draftPlan);
    if (errors.length) {
      render();
      toast('Draft not calculated: ' + errors.join(' '));
      return;
    }
    goalDraftResult = evaluate(draftPlan);
    render();
    toast('Draft recalculated with the planning engine. Review the trade-off table before applying.');
  });

  $('#btn-apply-goals')?.addEventListener('click', () => {
    flushInput();
    if (!goalDraft) return;
    const candidate = { ...plan, goals: clone(goalDraft) };
    const errors = validate(candidate);
    if (errors.length) {
      render();
      toast('Cannot apply invalid goal draft: ' + errors.join(' '));
      return;
    }
    plan.goals = clone(goalDraft);
    goalDraft = null;
    goalDraftResult = null;
    changed();
    toast(plan.goals.length ? 'Applied revised goals to the active plan.' : 'All goals removed. Add a goal when you are ready to model one.');
  });

  // Scenario walkthrough step handlers
  document.querySelectorAll('[data-demo-step]').forEach(btn => {
    btn.onclick = () => {
      const step = btn.dataset.demoStep;
      if (!scenarioBaseline) scenarioBaseline = clone(plan);
      if (step === 'reset') {
        shockDemoStep = 1;
        plan = clone(scenarioBaseline);
        changed();
        toast('Scenario reset to your captured baseline. Review values before applying.');
        return;
      }
      shockDemoStep = Number(step);
      if (shockDemoStep === 1) {
        plan = clone(scenarioBaseline);
        changed();
        toast('Step 1: Your captured baseline restored.');
      } else if (shockDemoStep === 2) {
        plan = clone(scenarioBaseline);
        plan.savings = Math.max(0, (plan.savings || 0) - 20000);
        plan.emergency = Math.min(plan.savings, Math.max(0, (plan.emergency || 0) - 20000));
        const errors = validate(plan);
        if (errors.length) { plan = clone(scenarioBaseline); toast('Expense scenario cannot use earmarked savings. Reduce earmarks first.'); return; }
        changed();
        toast('Step 2: Unexpected ₹20,000 expense absorbed from liquid savings.');
      } else if (shockDemoStep === 3) {
        plan = clone(scenarioBaseline);
        plan.savings = Math.max(0, (plan.savings || 0) - 20000);
        plan.emergency = Math.min(plan.savings, Math.max(0, (plan.emergency || 0) - 20000));
        plan.income = Math.max(0, (plan.income || 0) - 10000);
        const errors = validate(plan);
        if (errors.length) { plan = clone(scenarioBaseline); toast('Scenario exceeds available unreserved savings. Review earmarks first.'); return; }
        changed();
        toast('Step 3: Monthly income reduced by ₹10,000. Monthly surplus recalculated from the active demo inputs.');
      } else if (shockDemoStep === 4) {
        render();
        toast('Step 4: Select Alternative A or Alternative B to compare trade-offs.');
      }
    };
  });

  // Shock Demo Alternatives Selection
  document.querySelectorAll('[data-apply-alt]').forEach(btn => {
    btn.onclick = () => {
      const alt = btn.dataset.applyAlt;
      shockDemoAlt = alt;
      if (alt === 'A') {
        const ret = plan.goals.find(g => g.category === 'retirement' || g.id === 'retire');
        if (plan.locks.dates || ret?.hard) { toast('Unlock goal dates and use a flexible retirement goal to apply this option.'); return; }
        if (ret) ret.months = Math.min(600, ret.months + 36);
        changed();
        toast('Alternative A applied to the current plan. Review the recalculated goal dates, reserve, and shortfalls.');
      } else {
        if (plan.locks.lifestyle) { toast('Unlock lifestyle to apply a spending reduction.'); return; }
        plan.discretionary = Math.max(0, (Number(plan.discretionary) || 0) - 5000);
        // Alternative B preserves the current goal deadlines and reduces current spending by up to ₹5,000.

        changed();
        toast('Alternative B applied to the current plan. Review the recalculated surplus, goal dates, and shortfalls.');
      }
    };
  });

  // Remove an individual shock from the active plan and recalculate.
  document.querySelectorAll('[data-remove-shock]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      const index = Number(btn.dataset.removeShock);
      if (!Number.isInteger(index) || index < 0 || index >= (plan.shocks || []).length) return;
      plan.shocks.splice(index, 1);
      changed();
      toast('Shock removed from the active plan and results recalculated.');
    });
  });

  // Cash-flow ledger pagination.
  document.querySelectorAll('[data-ledger]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      ledgerPage = Math.max(0, ledgerPage + Number(btn.dataset.ledger));
      render();
    });
  });

  // Apply a specific Pareto recovery candidate.
  document.querySelectorAll('[data-apply-option]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      const idx = Number(btn.dataset.applyOption);
      const candidate = recovery?.options?.[idx];
      if (!candidate?.plan) { toast('That recovery candidate is no longer available. Run the recovery search again.'); return; }
      plan = clone(candidate.plan);
      changed();
      toast(`Applied recovery option: ${candidate.label}. Review the recalculated plan before saving.`);
    });
  });

  // Horizon & Crisis Toggles
  document.querySelectorAll('[data-horizon]').forEach(el => {
    el.onclick = () => {
      investmentMonths = +el.dataset.horizon;
      render();
    };
  });

  document.querySelectorAll('[data-crisis]').forEach(el => {
    el.onclick = () => {
      crisis = el.dataset.crisis;
      render();
    };
  });

  // Shock buttons get one binding here (not a second binding at bootstrap).
  document.querySelectorAll('[data-shock]').forEach(el => {
    el.onclick = event => { event.preventDefault(); addShock(el.dataset.shock); };
  });

  // Actions: use one handler per control. Explain buttons already have a dedicated
  // listener above; binding them a second time caused the drawer to open twice.
  document.querySelectorAll('[data-act]:not([data-act="explain"])').forEach(el => {
    el.type = 'button';
    el.onclick = event => { event.preventDefault(); handleAction(el.dataset.act); };
  });
}

function handleAction(name) {
  flushInput();
  switch (name) {
    case 'export-recovery':
      download('goalpulse-recovery.json', JSON.stringify(recoveryBackup, null, 2)); break;
    case 'dismiss-recovery':
      recoveryBackup = null; try { localStorage.removeItem(recoveryKey()); } catch {} render(); break;
    case 'restore-recovery': {
      if (!recoveryBackup?.plan) break;
      const restored = clone(recoveryBackup.plan);
      if (!Array.isArray(restored.goals)) { toast('This file needs manual schema repair. Export the recovery copy first.'); break; }
      restored.goals = fitEarmarks(restored);
      const errors = validate(restored);
      if (errors.length) { toast('Saved inputs need further review: ' + errors.join(' ')); break; }
      plan = restored; recoveryBackup = null; try { localStorage.removeItem(recoveryKey()); } catch {} changed(); render(); break;
    }
    case 'explain':
      openAIDrawer();
      break;
    case 'snapshot':
      saveSnapshot();
      break;
    case 'apply-debt-acceleration':
    case 'apply-debt-strategy': {
      const idx = name === 'apply-debt-acceleration' ? 0 : selectedLoan;
      const loan = plan.loans[idx];
      if (!loan) { toast('Add a loan before applying a repayment scenario.'); break; }
      const first = evaluate(plan).monthly_ledger[0];
      const available = Math.max(0, first.surplus + (loan.extraMonthly || 0));
      if (debtExtra > available) { toast(`Only ${money(available)}/mo is available before goal allocations. Lower the extra payment.`); break; }
      loan.extraMonthly = debtExtra;
      changed();
      toast(`Applied ${money(debtExtra)}/mo extra principal to ${loan.name}. It is deducted before goal contributions. Review the ledger.`);
      break;
    }
    case 'cancel-recovery':
      recoveryWorker?.terminate(); recovering = false; render(); toast('Recovery search cancelled. Your active plan is unchanged.'); break;
    case 'recover':
      if (busy) return;
      recovering = true;
      recoveryWorker?.terminate();
      recoveryWorker = new Worker('/engine/worker.js', {type: 'module'});
      let id = requestId;
      recoveryWorker.onmessage = ({data}) => {
        if (id !== requestId) return;
        recovering = false;
        if (data.error) lastError = data.error;
        else recovery = data.result;
        render();
        toast(data.error ? 'Recovery search error: ' + data.error : 'Verified recovery options ready.');
      };
      recoveryWorker.onerror = e => {
        recovering = false;
        lastError = 'Recovery worker error: ' + e.message;
        render();
      };
      recoveryWorker.postMessage({id, type: 'recover', plan, targets: C.targets});
      render();
      break;
    case 'apply-rescue':
      if (!recovery?.plan) { toast('Run the recovery search before applying a plan.'); break; }
      plan = clone(recovery.plan);
      changed();
      toast('Applied the recovery candidate returned by the solver. Review the revised plan and its assumptions.');
      break;
    case 'import':
      $('#plan-import')?.click(); break;
    case 'undo-import': {
      try { const backup = JSON.parse(localStorage.getItem(importBackupKey()) || 'null'); if (!backup?.plan || validate(backup.plan).length) throw Error('No valid previous plan is stored.'); plan = backup.plan; goalDraft = null; scenarioBaseline = null; changed(); render(); toast('Previous plan restored.'); } catch (error) { toast(error.message); }
      break;
    }
    case 'export':
      download('goalpulse-plan.json', JSON.stringify({version: 2, configVersion: C.version, plan}, null, 2));
      break;
    case 'csv':
      download('goalpulse-monthly-ledger.csv', csv(result.monthly_ledger), 'text/csv');
      break;
    case 'debt-csv':
      download('goalpulse-debt-schedule.csv', csv(debtAnalysis(plan, plan.loans[selectedLoan] || plan.loans[0], debtExtra, debtRate, debtFee).optimized.rows), 'text/csv');
      break;
    case 'mandate-json':
      download('goalpulse-monthly-mandate.json', JSON.stringify({asOf: plan.startDate, configVersion: C.version, plan: plan.name, month: result.monthly_ledger[0]}, null, 2));
      break;
    case 'print':
      window.print();
      break;
    case 'fit-earmarks':
      goalDraft = fitEarmarks(plan, goalDraft || plan.goals); goalDraftResult = null; render(); toast('Draft earmarks adjusted proportionally. Review and apply the draft.'); break;
    case 'clear-earmarks':
      goalDraft = (goalDraft || clone(plan.goals)).map(g => ({...g, earmarked: 0})); goalDraftResult = null; render(); toast('Draft earmarks cleared. Review and apply the draft.'); break;
    case 'add-goal': {
      const targetGoals = route === 'goals' ? (goalDraft || (goalDraft = clone(plan.goals))) : plan.goals;
      if (targetGoals.length >= 30) { toast('A plan can contain at most 30 goals.'); break; }
      targetGoals.push({
        id: 'goal-' + Date.now() + '-' + targetGoals.length,
        name: 'New Goal',
        cost: 0,
        months: 60,
        tier: 'Want',
        category: 'home',
        hard: false,
        minScope: 0.8,
        scope: 1,
        weight: 2,
        inflation: C.inflation.home ?? 0.07,
        earmarked: 0
      });
      if (route === 'goals') { goalDraftResult = null; render(); toast('Blank goal added to the draft. Enter its target amount and horizon, then recalculate and apply.'); }
      else changed();
      break;
    }
    case 'add-loan':
      if (plan.loans.length >= 20) { toast('Use at most 20 loans in one plan.'); break; }
      plan.loans.push({
        id: 'loan-' + Date.now(),
        name: 'New Loan',
        principal: 100000,
        apr: 0.09,
        months: 36,
        emi: 0,
        floating: true,
        penalty: 0,
        deductible: false,
        deductibleShare: 0,
        offset: false,
        autopay: false,
        cardSpend: 0,
        floatDays: 0
      });
      changed();
      break;
    case 'clear-shocks':
      plan.shocks = [];
      changed();
      break;
  }
}

// --- ROUTE VIEWS (12 FULL MODULES) ---

// MODULE 01: OVERVIEW & COCKPIT
// MODULE 01: OVERVIEW & COCKPIT (MY FINANCIAL PLAN)
function projectionPanel() {
  const outcomes = result.goal_outcomes.filter(g=>g.category !== 'emergency' && g.cost > 0);
  if (!outcomes.length) return '';
  const g = outcomes.find(g=>g.id === selectedGoal) || outcomes[0];
  selectedGoal = g.id;
  const bands = g.bands || [];
  const middle = bands.length ? bands.map(b=>b.p50) : g.series || [];
  const lo = bands.length ? bands.map(b=>b.p10) : middle;
  const hi = bands.length ? bands.map(b=>b.p90) : middle;
  const max = Math.max(1, g.target, ...hi), n = Math.max(1,middle.length-1);
  const x = i=>50+i/n*660, y = v=>210-v/max*175;
  const points = series=>series.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const band = [...hi.map((v,i)=>`${x(i)},${y(v)}`), ...lo.map((v,i)=>`${x(i)},${y(v)}`).reverse()].join(' ');
  return panel('Your possible paths', 'Shaded band: middle 80% of outcomes. Dashed line: target.',
    `<svg class="chart" viewBox="0 0 740 250" role="img" aria-label="${esc(g.name)} projection with 10th to 90th percentile band"><line class="target" x1="50" x2="710" y1="${y(g.target)}" y2="${y(g.target)}"/><text x="710" y="${Math.max(15,y(g.target)-8)}" text-anchor="end">Target ${money(g.target,g.months)}</text><polygon class="band" points="${band}"/><polyline class="line" points="${points(middle)}"/><text x="50" y="235">Start</text><text x="710" y="235" text-anchor="end">${date(g.months)}</text></svg><div class="capital-labels"><span>Downside (P10) <b>${money(g.p10 ?? g.corpus,g.months)}</b></span><span>Median <b>${money(g.corpus,g.months)}</b></span><span>Upside (P90) <b>${money(g.p90 ?? g.corpus,g.months)}</b></span></div>`,
    `<label class="field">Goal<select id="projection-goal">${outcomes.map(o=>`<option value="${esc(o.id)}" ${o.id===g.id?'selected':''}>${esc(o.name)}</option>`).join('')}</select></label>`);
}

function overviewPage() {
  const m = result.monthly_ledger[0] || {};
  const goals = result.goal_outcomes || [];
  const monthlySurplus = Number(m.surplus || 0);
  const onTrack = goals.filter(g=>g.cost > 0 && g.probability != null && g.probability >= C.targets[g.tier]).length;
  const runway = plan.emergency / Math.max(1,plan.essential);
  const activeGoals = goals.filter(g=>g.cost > 0);
  const totalAllocation = Math.max(1,m.allocation || 0);
  const colors = ['#1f6b63','#b98344','#6885a8','#8c7ba7','#8ba47c'];
  const allocation = activeGoals.map((g,i)=>{const index=plan.goals.findIndex(x=>x.id===g.id);const amount=g.category==='emergency' ? m.refill || 0 : m.contributions?.[index] || 0;return {g,amount,color:colors[i%colors.length]};});
  const priority = panel('Set your priorities','',`<div class="priority-picks"><button data-priority-preset="edu">Education first</button><button data-priority-preset="retire">Retirement first</button><button data-priority-preset="equal">Balance priorities</button></div><div class="allocation-visual" role="img" aria-label="Current monthly goal allocations">${allocation.filter(x=>x.amount>0).map(x=>`<span style="flex:${x.amount};background:${x.color}" title="${esc(x.g.name)}: ${money(x.amount)}"></span>`).join('')}</div><div class="allocation-key">${allocation.map(x=>`<div><i style="background:${x.color}"></i><span>${esc(x.g.name)}</span><b>${money(x.amount)}/mo</b></div>`).join('') || '<p class="quiet">Add a goal to allocate your savings.</p>'}</div>`);
  const loan = plan.loans[0];
  let debt = '';
  if (loan) {
    const d = debtAnalysis(plan,loan,debtExtra,debtRate,debtFee);
    const saved = Math.max(0,d.baseline.months-d.optimized.months);
    debt = panel('A faster path out of debt','',`<div class="payoff-hero"><div><span>Estimated interest saved</span><strong>${money(d.interestSaved)}</strong></div><span class="payoff-badge">${saved} months earlier</span></div><div class="payoff-lanes"><div><span>Current</span><i style="width:100%;background:var(--muted)"></i><b>${date(d.baseline.months)}</b></div><div><span>+${money(debtExtra)}/mo</span><i style="width:${Math.max(3,d.optimized.months/Math.max(1,d.baseline.months)*100)}%;background:var(--accent)"></i><b>${date(d.optimized.months)}</b></div></div><div class="actions"><button data-act="apply-debt-acceleration" class="primary">Apply extra payment</button>${link('debt','Explore repayment')}</div><small class="quiet">Scenario estimate. Lender fees excluded.</small>`);
  }
  return heading('YOUR PLAN','More clarity. Less guesswork.',`${esc(session ? session.familyName : plan.name)} · Estimates from your current inputs.`,`<button data-act="snapshot" ${busy?'disabled':''}>Save Plan Snapshot</button>`) +
    ((plan.income===0 && plan.savings===0 && goals.every(g=>!g.cost)) ? `<div class="callout"><div><strong>Set up your household to see personalized calculations.</strong><p>These zero values are an empty starting point, not a forecast.</p></div>${link('profile','Enter financial details',true)}</div>` : '') +
    `<div class="radial-grid">${svgRadialGauge(clamp(monthlySurplus/50000),compactMoney(monthlySurplus),monthlySurplus<0?'Monthly deficit':'Monthly surplus','After living costs',monthlySurplus>0?'var(--green)':'var(--red)')}${svgRadialGauge(result.healthScore/100,Math.round(result.healthScore),'Plan health','Out of 100')}${svgRadialGauge(onTrack/Math.max(1,activeGoals.length),`${onTrack}/${activeGoals.length}`,'Goals on track','At target probability')}${svgRadialGauge(clamp(runway/plan.reserveMonths),runway.toFixed(1)+'m','Emergency buffer',`${plan.reserveMonths}-month target`)}</div>` +
    panel('Your goals at a glance','',svgGoalInfographicCards(),link('goals','Edit goals')) +
    `<div class="overview-visual-grid">${svgMoneyFlowSankey(m)}${capitalPanel()}</div>` +
    projectionPanel() + `<div class="overview-visual-grid">${priority}${debt}</div>` +
    ((result.termGap>0 || result.healthGap>0) && plan.income>0 ? `<div class="callout warning compact-protection"><div><strong>Protection gaps</strong><p>Life ${money(result.termGap)} · Health ${money(result.healthGap)} <span class="quiet">(model assumptions)</span></p></div>${link('profile','Review cover')}</div>` : '') +
    `<details class="panel optional-models"><summary>More planning options</summary>${svgOptimizationToggleGrid(plan,result)}</details>`;
}

// MODULE 02: 360° FAMILY PROFILE
function profilePage() {
  let loanFields = plan.loans
    .map(
      (l, i) => `
    <div class="goaleditor">
      <div class="editorhead">
        <h3>${esc(l.name)}</h3>
        <button data-remove-loan="${i}">Remove Loan</button>
      </div>
      <div class="formgrid">
        ${field('Loan Name', `loans.${i}.name`, l.name, {type: 'text'})}
        ${field('Outstanding Principal (₹)', `loans.${i}.principal`, l.principal)}
        ${field('Annual Rate (APR, decimal)', `loans.${i}.apr`, l.apr, {step: 0.001, max: 0.6})}
        ${field('Remaining Tenure (Months)', `loans.${i}.months`, l.months, {min: 1, max: 600})}
        ${field('Monthly EMI (0 = Auto-calculate)', `loans.${i}.emi`, l.emi)}
        ${field('Eligible Monthly Card Spend', `loans.${i}.cardSpend`, l.cardSpend || 0)}
        ${field('Card Float Days (max 45)', `loans.${i}.floatDays`, l.floatDays || 0, {max: 45})}${field('Deductible share for debt comparison (0–1)', `loans.${i}.deductibleShare`, l.deductibleShare || 0, {max:1,step:.05})}
      </div>
      <div class="actions">
        ${check('Floating Interest Rate', `loans.${i}.floating`, l.floating)}
        ${check('Tax-Deductible Loan (Sec 24b / 80E)', `loans.${i}.deductible`, l.deductible)}
        ${check('Offset / Overdraft Facility Available', `loans.${i}.offset`, l.offset)}
        ${check('Full Credit Card Autopay Active', `loans.${i}.autopay`, l.autopay)}
      </div><p class="quiet">Offset/card-float details are recorded for review; they do not change the current projection.</p>
    </div>
  `
    )
    .join('');

  return (
    heading(
      '02 360° FAMILY PROFILE & CFP DISCOVERY',
      'Your financial profile',
      'Your numbers. Your plan.',
      link('overview', 'Back to Cockpit →')
    ) +
    capitalPanel() +
    `<details open>
      <summary>Income &amp; tax</summary>
      <div class="detailbody">
        <div class="formgrid">
          ${field('Plan Name', 'name', plan.name, {type: 'text'})}
          ${field('Primary Age', 'age', plan.age, {max: 100})}
          ${field('Monthly Take-Home (₹)', 'income', plan.income)}
          ${field('Annual Salary Growth (decimal)', 'growth', plan.growth, {min: -0.05, max: 0.6, step: 0.01})}
          ${field('Expected Annual Bonus (₹)', 'bonus', plan.bonus)}
          ${field('Monthly Basic + DA (EPF base)', 'basic', plan.basic, {help: 'Used for 24% mandatory EPF compounding.'})}
          ${select('Tax Regime', 'taxRegime', plan.taxRegime, [
            ['new', 'New Tax Regime (Section 115BAC)'],
            ['old', 'Old Tax Regime (With 80C/24b deductions)']
          ])}
          ${field('Marginal Tax Slab (decimal)', 'slab', plan.slab, {step: 0.05, max: 0.6})}
        </div>
      </div>
    </details>
    <details open>
      <summary>Spending &amp; buffer</summary>
      <div class="detailbody">
        <div class="formgrid">
          ${field('Essential Living Costs / Month (₹)', 'essential', plan.essential)}
          ${field('Discretionary Lifestyle / Month (₹)', 'discretionary', plan.discretionary)}
          ${field('Emergency Target (Months of Essentials)', 'reserveMonths', plan.reserveMonths, {min: 3, max: 24})}
        </div>
      </div>
    </details>
    <details>
      <summary>Savings &amp; assets</summary>
      <div class="detailbody">
        <div class="formgrid">
          ${field('Liquid / Spendable Savings (₹)', 'savings', plan.savings)}
          ${field('Emergency Fund Allocated (₹)', 'emergency', plan.emergency)}
          ${field('Regular Mutual Fund Corpus (₹)', 'regularCorpus', plan.regularCorpus)}
          ${field('EPF Accumulated Balance (₹)', 'epf', plan.epf)}
          ${field('PPF Accumulated Balance (₹)', 'ppf', plan.ppf)}
          ${field('NPS Accumulated Balance (₹)', 'nps', plan.nps)}
        </div>
        <h3 style="margin-top:18px">Physical &amp; Tangible Assets</h3>
        <p class="quiet">Enter quantities and your own price estimates. Values below are not live market quotes, and jewellery value may differ from its metal value.</p>
        <div class="formgrid three">
          ${field('Gold held (grams)', 'assets.goldGrams', plan.assets.goldGrams, {step: 0.01})}
          ${field('Gold estimate (₹/gram)', 'assets.goldPricePerGram', plan.assets.goldPricePerGram, {step: 1})}
          ${field('Gold jewellery (grams)', 'assets.jewelleryGrams', plan.assets.jewelleryGrams, {step: 0.01})}
          ${field('Jewellery estimate (₹/gram)', 'assets.jewelleryPricePerGram', plan.assets.jewelleryPricePerGram, {step: 1})}
          ${field('Silver held (grams)', 'assets.silverGrams', plan.assets.silverGrams, {step: 0.01})}
          ${field('Silver estimate (₹/gram)', 'assets.silverPricePerGram', plan.assets.silverPricePerGram, {step: 1})}
          ${field('Land / property estimated value (₹)', 'assets.landValue', plan.assets.landValue)}
          ${field('Other precious assets estimated value (₹)', 'assets.otherPreciousValue', plan.assets.otherPreciousValue)}
        </div>
        <p><strong>Estimated tangible assets:</strong> ${money((plan.assets.goldGrams || 0) * (plan.assets.goldPricePerGram || 0) + (plan.assets.jewelleryGrams || 0) * (plan.assets.jewelleryPricePerGram || 0) + (plan.assets.silverGrams || 0) * (plan.assets.silverPricePerGram || 0) + (plan.assets.landValue || 0) + (plan.assets.otherPreciousValue || 0))}</p>
        <p class="quiet">These estimates are recorded in your profile; they are not treated as liquid savings or automatically used to fund goals.</p>
      </div>
    </details>
    <details>
      <summary>Loans (${plan.loans.length} Accounts)</summary>
      <div class="detailbody">
        ${loanFields || '<p class="quiet">No active loans in this profile.</p>'}
        <button data-act="add-loan">Add Loan Account</button>
      </div>
    </details>
    <details>
      <summary>Insurance</summary>
      <div class="detailbody">
        <div class="formgrid">
          ${field('Term Life Insurance Cover (₹)', 'term', plan.term)}
          ${field('Base Health Insurance Cover (₹)', 'health', plan.health)}
          ${field('Super Top-Up Health Cover (₹)', 'topup', plan.topup)}
        </div>
      </div>
    </details>
    <div class="actions" style="margin-top:20px">
      <button data-act="export">Export Plan JSON</button><button data-act="import">Import Plan JSON</button><button data-act="undo-import">Restore plan from before import</button><input id="plan-import" type="file" accept=".json,application/json" hidden>
    </div>`
  );
}

// MODULE 02: MY GOALS & PRIORITY
function goalsPage() {
  if (!goalDraft) {
    goalDraft = clone(plan.goals);
    goalDraftBase = JSON.stringify(plan.goals);
  }

  const activeOutcomes = result.goal_outcomes || [];
  const draftOutcomes = goalDraftResult ? goalDraftResult.goal_outcomes : null;

  let diffTableHTML = '';
  if (draftOutcomes) {
    diffTableHTML = `
      <div style="background:var(--soft);padding:14px;border-radius:6px;margin-bottom:20px;border-left:3px solid var(--accent)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong style="color:var(--accent);font-size:14px">Draft Impact &amp; Trade-off Diff Analysis</strong>
          <span class="pill" style="background:var(--accent);color:#fff">Draft Evaluated ✓</span>
        </div>
        <div class="tablewrap">
          <table class="compacttable">
            <thead>
              <tr>
                <th>Goal</th>
                <th>Previous Engine-Estimated Saving/mo</th>
                <th>Revised Engine-Estimated Saving/mo</th>
                <th>Previous Status</th>
                <th>Revised Status</th>
                <th>Shortfall Impact</th>
              </tr>
            </thead>
            <tbody>
              ${draftOutcomes.map(dg => {
                const ag = activeOutcomes.find(o => o.id === dg.id) || {};
                // Use the engine's required-saving calculation, not target ÷ months.
                // Target ÷ months ignores growth, inflation-adjusted target cost and earmarked capital.
                const prevReq = ag.required ?? 0;
                const newReq = dg.required ?? 0;
                const prevShortfall = ag.shortfall || 0;
                const newShortfall = dg.shortfall || 0;
                const deltaShortfall = newShortfall - prevShortfall;

                return `
                  <tr>
                    <td><strong>${esc(dg.name)}</strong></td>
                    <td>${money(prevReq)}/mo</td>
                    <td><strong style="color:var(--accent)">${money(newReq)}/mo</strong></td>
                    <td><span class="status ${prevShortfall <= 1000 ? 'good' : 'warn'}">${prevShortfall <= 1000 ? 'Feasible' : 'Needs Adj'}</span></td>
                    <td><span class="status ${newShortfall <= 1000 ? 'good' : 'warn'}">${newShortfall <= 1000 ? 'Feasible' : 'Needs Adj'}</span></td>
                    <td class="${deltaShortfall <= 0 ? 'good' : 'bad'}">${deltaShortfall === 0 ? 'No change' : (deltaShortfall < 0 ? 'Saved ' + money(Math.abs(deltaShortfall)) : '+ ' + money(deltaShortfall) + ' gap')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  return (
    heading(
      '02 MY GOALS & PRIORITY',
      'Your goals',
      'Edit → Recalculate → Apply. Your active plan changes only when you apply.',
      `<button id="btn-recalc-goals" class="primary" style="margin-right:8px">Recalculate draft ↻</button>
       <button id="btn-apply-goals" style="background:var(--green);color:#fff;border-color:var(--green);margin-right:8px">Apply changes ✓</button>
       <button data-act="add-goal">Add goal +</button>`
    ) +
    capitalPanel(goalDraft, true) +
    diffTableHTML +
    `<details class="panel"><summary>Current goal outlook</summary>${svgGoalInfographicCards(result.goal_outcomes)}</details>` +
    panel(
      'Goal details',
      '',
      goalDraft.map((g, i) => `
        <div class="goaleditor" style="margin-bottom:16px">
          <div class="editorhead">
            <div style="flex:1;max-width:320px">
              <label class="field">Goal Name
                <input type="text" data-draft-field="goals.${i}.name" value="${esc(g.name)}">
              </label>
            </div>
            <div class="actions">
              <button data-remove-goal="${i}">Remove Goal</button>
            </div>
          </div>

          <div style="margin-bottom:10px">
            <p class="eyebrow" style="margin-bottom:6px">BASIC GOAL DETAILS</p>
            <div class="formgrid four">
              <label class="field">Today's Cost (PV ₹)<input type="number" data-draft-field="goals.${i}.cost" value="${g.cost}"></label>
              <label class="field">Target Horizon (Months)<input type="number" min="1" max="600" data-draft-field="goals.${i}.months" value="${g.months}"></label>
              <label class="field">Priority Tier
                <select data-draft-field="goals.${i}.tier">
                  <option value="Need" ${g.tier === 'Need' ? 'selected' : ''}>Need (Non-negotiable)</option>
                  <option value="Want" ${g.tier === 'Want' ? 'selected' : ''}>Want (Flexible)</option>
                  <option value="Wish" ${g.tier === 'Wish' ? 'selected' : ''}>Wish (Aspirational)</option>
                </select>
              </label>
              <label class="field">Earmarked Savings (₹)<input type="number" data-draft-field="goals.${i}.earmarked" ${g.category === 'emergency' ? 'disabled title="Edit the emergency reserve in your profile"' : ''} value="${g.earmarked || 0}"></label>
            </div>
          </div>

          <details style="margin-top:10px">
            <summary class="quiet" style="font-size:12px;cursor:pointer;user-select:none">Inflation, growth &amp; limits</summary>
            <div class="formgrid three" style="margin-top:10px">
              <label class="field">Category Inflation
                <select data-draft-field="goals.${i}.category">
                  ${Object.keys(C.inflation).map(cat => `<option value="${cat}" ${g.category === cat ? 'selected' : ''}>${cat} (${pct(C.inflation[cat])})</option>`).join('')}
                </select>
              </label>
              <label class="field">Annual Inflation (decimal)<input type="number" step="0.01" data-draft-field="goals.${i}.inflation" value="${g.inflation ?? 0.06}"></label>
              <label class="field">Deadline Flexibility
                <select data-draft-field="goals.${i}.hard">
                  <option value="false" ${!g.hard ? 'selected' : ''}>Flexible (Can extend if life shock occurs)</option>
                  <option value="true" ${g.hard ? 'selected' : ''}>Fixed (Hard non-negotiable deadline)</option>
                </select>
              </label>
            </div>
          </details>
        </div>
      `).join('')
    )
  );
}

// MODULE 04: CASH-FLOW SANKEY & LEDGER
function monthlyCashflowVisual(rows) {
  const categories = [
    ['Living', '#6885a8', m => m.essential + m.discretionary],
    ['Debt', '#ae766b', m => m.emi], ['Events', '#a17cb0', m => m.shock],
    ['Reserve', '#bd944e', m => m.refill], ['Goals', '#1f6b63', m => m.allocation],
    ['Available', '#78a39b', m => m.unallocated]
  ];
  const spending = m => categories.reduce((total, c) => total + (Number(c[2](m)) || 0), 0);
  const scale = Math.max(1, ...rows.map(m => Math.max(m.income || 0, spending(m))));
  const total = key => rows.reduce((n, m) => n + (Number(m[key]) || 0), 0);
  if (!rows.some(m => spending(m) > 0 || m.income > 0)) return `<div class="cash-empty"><span aria-hidden="true">↗</span><h3>Your cash-flow picture starts here</h3><p class="quiet">Add income and expenses to see where your money goes.</p>${link('profile','Add financial details',true)}</div>`;
  return `<div class="cash-summary"><div><span>Income · this period</span><strong>${money(total('income'))}</strong></div><div><span>Saved toward goals</span><strong>${money(total('allocation'))}</strong></div><div><span>Unfunded gap</span><strong class="${total('unfunded') > .01 ? 'bad' : 'good'}">${money(total('unfunded'))}</strong></div></div>
    <div class="cash-legend">${categories.map(([name,color]) => `<span><i style="background:${color}"></i>${name}</span>`).join('')}</div>
    <p class="quiet">Bars share one scale. Expand a month for amounts. The marker shows income.</p>
    <div class="cash-months">${rows.map(m => {
      const parts = categories.map(([name,color,value]) => ({name,color,value:Number(value(m)) || 0}));
      const description = parts.filter(p => p.value > 0).map(p => `${p.name}: ${money(p.value,m.month)}`).join(', ');
      return `<details class="cash-month"><summary><span class="cash-date">${date(m.month)}</span><span class="cash-lane" role="img" aria-label="${esc(description || 'No spending')}">${parts.filter(p => p.value > 0).map(p => `<i style="width:${p.value/scale*100}%;background:${p.color}" title="${p.name}: ${money(p.value,m.month)}"></i>`).join('')}<b class="cash-income-marker" style="left:${Math.min(100,(m.income || 0)/scale*100)}%" title="Income: ${money(m.income,m.month)}"></b></span><span class="cash-month-total">${money(m.income,m.month)}</span><span class="cash-gap ${m.unfunded > .01 ? 'bad' : ''}">${m.unfunded > .01 ? 'Gap '+money(m.unfunded,m.month) : m.reserveDraw > .01 ? 'Reserve used' : '⌄'}</span></summary><div class="cash-month-detail">${parts.map(p => `<div><span>${p.name}</span><b>${money(p.value,m.month)}</b></div>`).join('')}<div><span>Reserve drawn</span><b>${money(m.reserveDraw || 0,m.month)}</b></div><div><span>Unfunded gap</span><b class="${m.unfunded > .01 ? 'bad' : ''}">${money(m.unfunded || 0,m.month)}</b></div></div></details>`;
    }).join('')}</div>`;
}

function cashflowPage() {
  let rows = result.monthly_ledger,
    shown = rows.slice(ledgerPage * 24, ledgerPage * 24 + 24),
    m = rows[0];

  return (
    heading('04 CASH-FLOW SANKEY & LEDGER', 'Your monthly cash flow', 'Income, spending and savings, month by month.', `<button data-act="csv">Export Ledger CSV</button>`) +
    
    panel(
      `Where your money goes`,
      `${shown.length ? date(shown[0].month) : ""} – ${shown.length ? date(shown[shown.length - 1].month) : ""}`,
      `${monthlyCashflowVisual(shown)}<details class="cash-exact"><summary>View exact figures &amp; audit</summary><div class="tablewrap">
        <table class="compacttable">
          <thead><tr><th>Month</th><th>Total Inflow</th><th>Living Costs</th><th>EMIs</th><th>Shocks</th><th>Reserve ±</th><th>Goal SIP</th><th>Residual</th><th>Unfunded gap</th><th>Conservation Audit</th></tr></thead>
          <tbody>
            ${shown
              .map(
                m => `
              <tr>
                <td>${date(m.month)}</td>
                <td class="numcell">${money(m.income, m.month)}</td>
                <td class="numcell">${money(m.essential + m.discretionary, m.month)}</td>
                <td class="numcell">${money(m.emi, m.month)}</td>
                <td class="numcell">${money(m.shock, m.month)}</td>
                <td class="numcell">${money(m.refill - m.reserveDraw, m.month)}</td>
                <td class="numcell"><strong>${money(m.allocation, m.month)}</strong></td>
                <td class="numcell">${money(m.unallocated, m.month)}</td>
                <td class="numcell ${m.unfunded > .01 ? 'bad' : ''}">${money(m.unfunded, m.month)}</td><td><span class="status ${m.unfunded > .01 ? 'bad' : 'good'}">${m.unfunded > .01 ? 'Needs funding' : 'Conserved ✓'}</span></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div></details>
      <div class="actions" style="margin-top:16px">
        <button data-ledger="-1" ${ledgerPage === 0 ? 'disabled' : ''}>Previous 24 Months</button>
        <button data-ledger="1" ${(ledgerPage + 1) * 24 >= rows.length ? 'disabled' : ''}>Next 24 Months</button>
      </div>`
    )
  );
}

// MODULE 05: DEBT ESCAPE LAB
function debtPage() {
  let l = plan.loans[selectedLoan] || plan.loans[0];
  if (!l) {
    return (
      heading('05 DEBT ESCAPE LAB', 'Zero Debt Freedom Accelerators', 'No outstanding loans in this profile.', link('profile', 'Add a Loan Account')) +
      panel('No Loans Recorded', 'No retail debt is entered in this plan.', '<p class="good" style="font-weight:600">The planner estimates surplus from the inputs provided; it cannot verify actual cash flow.</p>')
    );
  }

  return (
    heading(
      '05 DEBT ESCAPE LAB',
      'Debt repayment scenarios',
      'Compare the contractual schedule with affordable recurring extra principal. All projections use the same amortization engine.',
      `<button data-act="apply-debt-strategy" class="primary">Apply Debt Strategy to Plan</button>`
    ) +
    panel('Choose a repayment scenario', 'Change the loan or monthly extra principal, then apply the result to your active plan.',
      `<div class="formgrid"><label class="field">Loan<select id="debt-loan">${plan.loans.map((loan,i)=>`<option value="${i}" ${i === selectedLoan ? 'selected' : ''}>${esc(loan.name)}</option>`).join('')}</select></label>
      <label class="field">Extra principal / month (₹)<input id="debt-extra" type="number" min="0" step="100" value="${debtExtra}"></label>
      <label class="field">Proposed refinance APR<input id="debt-rate" type="number" min="0" max="0.6" step="0.001" value="${debtRate}"></label>
      <label class="field">Refinance switching fee (₹)<input id="debt-fee" type="number" min="0" value="${debtFee}"></label></div><p class="quiet">Current applied extra payment: ${money(l.extraMonthly || 0)}/mo. Set zero and apply to remove it.</p><button id="debt-preview">Preview repayment scenario</button>`) +
    svgDebtCompressionVisual(l) +
    advancedDebt()
  );
}

function advancedDebt() {
  let l = plan.loans[selectedLoan] || plan.loans[0];
  if (!l) return '';
  let a = debtAnalysis(plan, l, debtExtra, debtRate, debtFee);

  return panel(
    'Repayment assumptions & refinance comparison',
    'Extra payments use actual monthly surplus. Refinancing is a separate estimate and is not applied automatically. Prepayment fees are excluded; verify with your lender.',
    `<div class="metrics">
      ${metric('Prepayment Multiplier', a.multiplier.toFixed(2) + '×', 'Rupees of interest saved per rupee prepaid', 'Interest saved ÷ cumulative extra principal paid', {interestSaved: a.interestSaved, totalExtraPrincipal: a.extraPaid, extraPerMonth: debtExtra})}
      ${metric('Effective Cost of Debt', pct(a.effective, 2), plan.taxRegime === 'old' ? 'Net of eligible Sec 24b tax relief' : 'Gross APR (New Regime)', 'APR × (1 − Tax relief)', {apr: l.apr, regime: plan.taxRegime})}
      ${metric('Refinance Benefit PV', money(a.pv), a.refinance ? 'Passes 2.5× switching cost test' : 'Below cost threshold', 'Discounted monthly savings vs fee', {pv: a.pv, fee: debtFee}, a.refinance ? 'good' : 'warn')}
    </div>`
  );
}

// MODULE 06: INVESTMENT & LIVE MARKET LAB
function investPage() {
  const w = basket(investmentMonths, plan.investmentStrategy);
  const rows = marketData?.rows || [];
  let r = backtest(rows, w, investmentMonths, 0.06);

  return (
    heading(
      '06 INVESTMENT & LIVE MARKET LAB',
      'Illustrative Investment Risk & Scenario Lab',
      'The bundled series is illustrative/synthetic, not verified historical market data. Outputs are model scenarios, not evidence of actual 2008, 2020, or 2022 performance.',
      `<button id="btn-sync-market-2" class="primary">↻ Sync Live NAVs</button>`
    ) +
    (liveMarketData?.navs && Object.keys(liveMarketData.navs).length
      ? panel('Live Market NAVs', 'Values are shown with the source status returned by the market endpoint; assumed values are not live quotes.', `<div class="tablewrap"><table class="compacttable"><thead><tr><th>Instrument</th><th>NAV</th><th>Monthly return</th><th>Quote date</th><th>Source status</th></tr></thead><tbody>${Object.values(liveMarketData.navs).filter(n => n && 'nav' in n).map(n => `<tr><td>${esc(n.name || 'Unnamed instrument')}</td><td>${n.nav == null ? 'Unavailable' : '₹' + Number(n.nav).toLocaleString('en-IN', {maximumFractionDigits:4})}</td><td>${n.monthlyRet == null ? 'Unavailable' : pct(Number(n.monthlyRet), 2)}</td><td>${esc(n.date || 'Illustrative')}</td><td><span class="pill ${n.status === 'live' ? 'good' : 'warn'}">${n.status === 'live' ? 'LIVE' : 'ASSUMED'}</span></td></tr>`).join('')}</tbody></table></div>`)
      : panel('Live Market NAVs', 'No NAV response is available yet. Use the Sync Live NAVs control above to request current data; do not treat assumed values as live quotes.', '<p class="quiet">No NAV rows returned yet.</p>')) +
    panel('Explore an allocation', 'The inspection horizon changes this comparison; goal deadlines stay as entered.',
      `<div class="chipset">${[12,36,60,120].map(months=>`<button data-horizon="${months}" class="${investmentMonths === months ? 'selected' : ''}">${months} months</button>`).join('')}</div>` +
      select('Allocation model', 'investmentStrategy', plan.investmentStrategy, [['horizon_default','Horizon-based allocation'],['all_weather_erc','Equal risk contribution (configured covariance)']])) +
    svgAssetDonutAndCrisisReplay() +
    panel(
      'Illustrative Modelled Return Scenarios',
      'Synthetic monthly observations. Do not interpret these results as a historical backtest of the named real-world instruments.',
      `<div class="metrics">
        ${metric('Rolling Windows Analyzed', String(r.windows), `${investmentMonths}-Month Overlapping Horizons`, 'Overlapping synthetic periods evaluated', {records: rows.length, horizon: investmentMonths, windows: r.windows})}
        ${metric('Median Rolling CAGR', pct(r.median, 1), 'Median annualized return in synthetic windows', 'Median of overlapping annualized compound returns', r)}
        ${metric('Worst modelled drawdown', pct(r.maxDrawdown, 1), 'Peak-to-trough decline in synthetic observations', 'Max peak-to-trough loss across 20 years', {drawdown: r.maxDrawdown})}
        ${metric('Sortino Ratio', Number.isFinite(r.sortino) ? r.sortino.toFixed(2) : 'N/A', 'Downside risk-adjusted performance', 'Mean excess return ÷ downside deviation', r)}
      </div>`
    )
  );
}

// MODULE 07: ZERO-SACRIFICE RECOVERY
function fixPage() {
  let r = recovery;

  return (
    heading('12 PLANNING OPTIONS', 'Find a more feasible plan', 'Compare supported assumption changes, then search for scope and saving adjustments within your locks.', `<button data-act="recover" class="primary" ${recovering || busy ? 'disabled' : ''}>${recovering ? 'Evaluating Candidates…' : r ? 'Re-run Recovery Search' : 'Run Recovery Search'}</button>${recovering ? '<button data-act="cancel-recovery">Cancel search</button>' : ''}`) +
    svgOptimizationToggleGrid(plan, result) +
    (r
      ? panel(
          'Recovery Search Results',
          `Modelled shortfall before: ${money(r.before.totalShortfall)}; after applying the efficiency waterfall: ${money(r.after.totalShortfall)}. Results depend on the model assumptions and are not guaranteed.`,
          `<h3>Efficiency waterfall</h3>
          <div class="tablewrap"><table class="compacttable"><thead><tr><th>Step</th><th>Before</th><th>After</th><th>Shortfall recovered</th></tr></thead><tbody>${(r.steps || []).map(step => `<tr><td>${esc(step.name)}</td><td>${money(step.before)}</td><td>${money(step.after)}</td><td>${money(step.recovered)}</td></tr>`).join('')}</tbody></table></div>
          <h3 style="margin-top:20px">Pareto trade-off options</h3>${!(r.options || []).length ? '<p class="warn">No tested adjustment improved the current plan within these locks. Review the additional-income estimate or change an eligible constraint.</p>' : ''}
          <div class="metrics">${(r.options || []).map((o, idx) => `<article class="card"><h4>${esc(o.label)}</h4><p>Lifestyle reduction: <strong>${pct(o.trim || 0)}</strong></p><p>Annual SIP step-up: <strong>${pct(o.stepUp || 0)}</strong></p><p>Goal delay: <strong>${Number(o.delay || 0)} months</strong></p><p>Goal scope: <strong>${pct(o.scope ?? 1)}</strong></p><p>Modelled shortfall: <strong>${money(o.result?.totalShortfall || 0)}</strong></p><p class="${o.feasible ? 'good' : 'warn'}">${o.feasible ? 'Meets model probability targets' : 'Still below one or more targets'}</p><button data-apply-option="${idx}" class="primary">Apply this option</button></article>`).join('')}</div>
          <details style="margin-top:16px"><summary>Additional income estimate & search audit</summary><p>${r.additionalIncome == null ? 'No additional-income amount was found within the model search bound.' : `Estimated additional monthly income lower bound: ${money(r.additionalIncome)}.`}</p><p>${esc(r.ceilingReason || '')}</p><p>Candidates searched: <strong>${Number(r.searched || 0).toLocaleString('en-IN')}</strong>; candidates verified: <strong>${Number(r.verified || 0).toLocaleString('en-IN')}</strong>.</p><p class="quiet">${esc(r.limitation || 'Finite candidate search; modelled results are estimates.')}</p></details>
          <div class="actions" style="margin-top:16px"><button data-act="apply-rescue" class="primary">Apply Efficiency Waterfall</button></div>`
        )
      : '')
  );
}

// MODULE 03: WHAT IF? SCENARIO SANDBOX
function stressPage() {
  const m1 = result.monthly_ledger[0] || {};
  const monthlyInflow = (m1.income || 0) + (m1.extraIncome || 0);
  const livingCosts = (m1.essential || 0) + (m1.discretionary || 0);
  const debtPayment = m1.emi || 0;
  const currentSurplus = Number(m1.surplus || 0);
  const runwayMonths = plan.emergency / Math.max(1, plan.essential);

  // Compare alternatives against the same current plan. These are engine outputs,
  // not fixed demo promises. Applying an option still requires an explicit click.
  const alternativeA = clone(plan);
  const retirementA = alternativeA.goals.find(g => g.category === 'retirement' || g.id === 'retire');
  if (retirementA && !retirementA.hard && !plan.locks.dates) retirementA.months = Math.min(600, retirementA.months + 36);
  const alternativeB = clone(plan);
  alternativeB.discretionary = plan.locks.lifestyle ? plan.discretionary : Math.max(0, (Number(alternativeB.discretionary) || 0) - 5000);
  const safeEvaluate = candidate => {
    try { return validate(candidate).length ? null : evaluate(candidate); }
    catch { return null; }
  };
  const resultA = safeEvaluate(alternativeA);
  const resultB = safeEvaluate(alternativeB);
  const outcomeFor = (r, terms) => r?.goal_outcomes?.find(g => terms.some(t => (g.category || '').toLowerCase() === t || (g.id || '').toLowerCase() === t)) || null;
  const eduA = outcomeFor(resultA, ['education']);
  const retA = outcomeFor(resultA, ['retirement', 'retire']);
  const eduB = outcomeFor(resultB, ['education']);
  const retB = outcomeFor(resultB, ['retirement', 'retire']);
  const surplusFor = r => {
    const row = r?.monthly_ledger?.[0] || {};
    return Number(row.surplus || 0);
  };

  let demoStepHTML = '';
  if (shockDemoStep === 1) {
    demoStepHTML = `
      <div style="background:var(--soft);padding:14px;border-radius:6px;border:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong style="color:var(--accent);font-size:14px">Step 1 State: Baseline Household Cash Flow</strong>
          <span class="pill" style="background:var(--accent);color:#fff">Baseline Active</span>
        </div>
        <div class="metrics" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-bottom:12px">
          <div><span class="quiet">Monthly Inflow:</span><br><strong>${money(monthlyInflow)}</strong></div>
          <div><span class="quiet">Living + Debt:</span><br><strong>${money(livingCosts + debtPayment)}</strong></div>
          <div><span class="quiet">Available Surplus:</span><br><strong class="good">${money(currentSurplus)}/mo</strong></div>
          <div><span class="quiet">Liquid Savings:</span><br><strong>${money(plan.savings)}</strong></div>
          <div><span class="quiet">Emergency Buffer:</span><br><strong>${runwayMonths.toFixed(1)} Months</strong></div>
        </div>
        <p class="quiet" style="font-size:12px;margin:0">
          Baseline estimate: monthly surplus of <strong>${money(currentSurplus)}</strong>. Review the calculated allocations and goal probabilities; funding is not guaranteed.
        </p>
      </div>
    `;
  } else if (shockDemoStep === 2) {
    demoStepHTML = `
      <div style="background:var(--soft);padding:14px;border-radius:6px;border-left:3px solid var(--amber)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong style="color:var(--amber);font-size:14px">Step 2 State: ₹20,000 Unexpected Expense Shock Incurred</strong>
          <span class="pill" style="background:var(--amber);color:#fff">Expense Absorbed</span>
        </div>
        <div class="metrics" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-bottom:12px">
          <div><span class="quiet">Monthly Inflow:</span><br><strong>${money(monthlyInflow)}</strong></div>
          <div><span class="quiet">Available Surplus:</span><br><strong>${money(currentSurplus)}/mo</strong></div>
          <div><span class="quiet">Revised Liquid Savings:</span><br><strong class="bad">${money(plan.savings)}</strong> (-₹20,000)</div>
          <div><span class="quiet">Emergency Reserve:</span><br><strong class="bad">${money(plan.emergency)}</strong></div>
          <div><span class="quiet">Emergency Runway:</span><br><strong>${runwayMonths.toFixed(1)} Months</strong></div>
        </div>
        <p class="quiet" style="font-size:12px;margin:0">
          The ₹20,000 expense is paid directly from liquid savings without borrowing. Emergency runway is calculated from the current emergency reserve and essential spending entered in the plan. Review the recalculated ledger for the impact on cash flow.
        </p>
      </div>
    `;
  } else if (shockDemoStep === 3) {
    demoStepHTML = `
      <div style="background:var(--soft);padding:14px;border-radius:6px;border-left:3px solid var(--red)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong style="color:var(--red);font-size:14px">Step 3 State: Household Income Reduced by -₹10,000/Month</strong>
          <span class="pill" style="background:var(--red);color:#fff">Income Shock Active</span>
        </div>
        <div class="metrics" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-bottom:12px">
          <div><span class="quiet">Reduced Inflow:</span><br><strong class="bad">${money(monthlyInflow)}</strong> (-₹10k/mo)</div>
          <div><span class="quiet">Living + Debt:</span><br><strong>${money(livingCosts + debtPayment)}</strong></div>
          <div><span class="quiet">Available Surplus:</span><br><strong class="bad">${money(currentSurplus)}/mo</strong> (Dropped by ₹10,000)</div>
          <div><span class="quiet">Education Saving Estimate:</span><br><strong>${money(outcomeFor(result, ['education'])?.required || 0)}/mo</strong></div>
          <div><span class="quiet">Retirement Saving Estimate:</span><br><strong>${money(outcomeFor(result, ['retirement', 'retire'])?.required || 0)}/mo</strong></div>
        </div>
        <p class="quiet" style="font-size:12px;margin:0">
          Income falls by ₹10,000/month. Cash flow and goal estimates recalculate above.
        </p>
      </div>
    `;
  } else if (shockDemoStep === 4) {
    demoStepHTML = `
      <div style="background:var(--soft);padding:14px;border-radius:6px;border-left:3px solid var(--accent)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong style="color:var(--accent);font-size:14px">Step 4 &amp; 5: Decision Alternatives &amp; Trade-off Resolution</strong>
          <span class="pill" style="background:var(--accent);color:#fff">Resolution Engine</span>
        </div>
        <div class="metrics" style="grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div style="background:var(--bg);padding:12px;border-radius:6px;border:${shockDemoAlt === 'A' ? '2px solid var(--accent)' : '1px solid var(--border)'}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <strong>Alternative A: Extend Flexible Retirement Horizon</strong>
              <button data-apply-alt="A" ${plan.locks.dates || retirementA?.hard ? 'disabled' : ''} style="font-size:11px;padding:3px 8px" class="${shockDemoAlt === 'A' ? 'primary' : ''}">Select A</button>
            </div>
            <p class="quiet" style="font-size:12px;margin:0 0 8px 0">Extend the currently configured retirement deadline by 36 months (capped at 600 months).</p>
            <div style="font-size:11px">
              <div>Emergency Buffer: <strong>${(alternativeA.emergency / Math.max(1, alternativeA.essential)).toFixed(1)} months</strong></div>
              <div>Education Saving Estimate: <strong>${eduA ? money(eduA.required) + '/mo' : 'Not available'}</strong></div>
              <div>Retirement Deadline: <strong>${retirementA ? retirementA.months + ' months' : 'No retirement goal configured'}</strong></div>
              <div>Retirement Saving Estimate: <strong>${retA ? money(retA.required) + '/mo' : 'Not available'}</strong></div>
            </div>
          </div>

          <div style="background:var(--bg);padding:12px;border-radius:6px;border:${shockDemoAlt === 'B' ? '2px solid var(--accent)' : '1px solid var(--border)'}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <strong>Alternative B: Preserve Deadlines &amp; Trim Discretionary</strong>
              <button data-apply-alt="B" ${plan.locks.lifestyle ? 'disabled' : ''} style="font-size:11px;padding:3px 8px" class="${shockDemoAlt === 'B' ? 'primary' : ''}">Select B</button>
            </div>
            <p class="quiet" style="font-size:12px;margin:0 0 8px 0">Reduce discretionary spending by up to ₹5,000/mo, without going below zero; current goal deadlines are preserved.</p>
            <div style="font-size:11px">
              <div>Monthly surplus Estimate: <strong class="good">${money(surplusFor(resultB))}/mo</strong></div>
              <div>Education Saving Estimate: <strong>${eduB ? money(eduB.required) + '/mo' : 'Not available'}</strong></div>
              <div>Retirement Saving Estimate: <strong>${retB ? money(retB.required) + '/mo' : 'Not available'}</strong></div>
              <div>Discretionary Budget: <strong>${money(alternativeB.discretionary)}/mo</strong></div>
            </div>
          </div>
        </div>
        <p class="quiet" style="font-size:12px;margin:0">
          Required-saving estimates, not guaranteed outcomes or success probabilities. Select an option to apply and review.
        </p>
      </div>
    `;
  }

  return (
    heading(
      '03 WHAT IF? SCENARIO SANDBOX',
      'What if life changes?',
      'Test a shock. See the impact. Compare your options.',
      `<button data-act="clear-shocks">Clear All Events</button><button data-act="snapshot" class="primary">Save Snapshot</button>`
    ) +
    panel(
      'Scenario walkthrough',
      'Choose an event to preview its impact. Review before applying.',
      `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <button data-demo-step="1" class="${shockDemoStep === 1 ? 'primary' : ''}" style="font-size:12px">Current plan</button>
        <button data-demo-step="2" class="${shockDemoStep === 2 ? 'primary' : ''}" style="font-size:12px">Unexpected expense</button>
        <button data-demo-step="3" class="${shockDemoStep === 3 ? 'primary' : ''}" style="font-size:12px">Income reduction</button>
        <button data-demo-step="4" class="${shockDemoStep === 4 ? 'primary' : ''}" style="font-size:12px">Compare alternatives</button>
        <button data-demo-step="reset" style="font-size:12px;margin-left:auto">Reset scenario</button>
      </div>
      ${demoStepHTML}`
    ) +
    panel(
      'Choose a life event',
      "Scenario comparisons use the planner's simulation settings; treat differences as model estimates, not causal guarantees.",
      `<div class="chipset">
        <button data-shock="job">6-Month Career Break / Job Loss</button>
        <button data-shock="medical">₹12 Lakh Medical Emergency</button>
        <button data-shock="recession">Severe Recession (Income + Market Crash)</button>
        <button data-shock="rate">+1.50% Floating Loan Rate Hike</button>
        <button data-shock="dependent">New Dependent (₹15,000/mo)</button>
        <button data-shock="inflation">+3.00% Persistent Inflation Shock</button>
      </div>
      ${
        plan.shocks
          .map(
            (s, i) => `
        <div class="goaleditor">
          <div class="editorhead">
            <h3>Event ${i + 1}: ${esc({job: 'Career Break', medical: 'Medical Emergency', crash: 'Market Crash', rate: 'Rate Hike', dependent: 'Dependent Cost', bonus: 'Windfall', inflation: 'Inflation Surge'}[s.type])}</h3>
            <button data-remove-shock="${i}">Remove</button>
          </div>
          <div class="formgrid">
            ${field('Start Month', `shocks.${i}.month`, s.month, {min: 1, max: 600})}
            ${field('Duration (Months)', `shocks.${i}.duration`, s.duration, {min: 1, max: 600})}
          </div>
        </div>
      `
          )
          .join('') || '<p class="quiet">No additional macro events active.</p>'
      }`
    )
  );
}

// MODULE 09: SIDE-BY-SIDE PLAN COMPARATOR
function comparePage() {
  const allGoals = [...new Map(snapshots.flatMap(s => (s.result.goal_outcomes || []).map(g=>[g.id,g]))).values()];
  return heading('07 Plan Comparator', 'Your choices, side by side', 'Freeze up to three plans. Compare funding, timelines and probability before loading a working copy.', `<button data-act="snapshot" class="primary" ${busy ? 'disabled' : ''}>Save Current Plan as Snapshot</button>`) +
    (snapshots.length ? `<div class="comparegrid">${snapshots.map((s,i)=>`<section class="compareplan"><p class="eyebrow">PLAN ${String.fromCharCode(65+i)}</p><h2>${esc(s.label)}</h2><p class="quiet">${esc(new Date(s.savedAt).toLocaleString('en-IN'))}</p><div class="large-number">${money(s.result.totalShortfall)}</div><p>Expected goal shortfall</p><p>Health score <strong>${Math.round(s.result.healthScore)}/100</strong></p><div class="actions"><button data-load-snapshot="${i}">Load Copy</button><button data-delete-snapshot="${i}">Delete</button></div></section>`).join('')}</div>` +
      panel('Goal outcomes across plans', 'Probabilities come from each frozen simulation. Different goals and deadlines are shown explicitly.', `<div class="tablewrap"><table><thead><tr><th>Goal</th>${snapshots.map((s,i)=>`<th>Plan ${String.fromCharCode(65+i)}</th>`).join('')}</tr></thead><tbody>${allGoals.map(g=>`<tr><td>${esc(g.name)}</td>${snapshots.map(s=>{const o=s.result.goal_outcomes.find(x=>x.id===g.id);return `<td>${o ? `<div class="comparison-bar"><i style="width:${Math.max(0,Math.min(100,(o.probability||0)*100))}%"></i></div><b>${o.probability == null ? 'Not simulated' : pct(o.probability)}</b><small>${o.months} months · required ${money(o.required)}/mo · gap ${money(o.shortfall)}</small>` : 'Not in this plan'}</td>`}).join('')}</tr>`).join('')}</tbody></table></div>`) : panel('No saved plans yet', '', '<p>Save a snapshot, change your inputs, then save another to see the trade-off.</p>'));
}

// MODULE 10: MONTHLY EXECUTION MANDATE
function actionPage() {
  let m = result.monthly_ledger[0];

  return (
    heading(
      '10 MONTHLY ALLOCATION PLAN',
      'Suggested Monthly Allocation Schedule',
      'Modelled allocations based on current inputs. GoalPulse does not initiate transfers, SIPs, or loan auto-debits.',
      `<button data-act="print" class="primary">Print Allocation Plan</button><button data-act="mandate-json">Export Allocation JSON</button>`
    ) +
    panel(
      'Suggested Monthly Allocation Schedule',
      `Illustrative schedule for ${date(1)} • ${esc(session ? session.familyName : plan.name)}. No transactions are executed by this app.`,
      `<div class="tablewrap">
        <table>
          <thead><tr><th>Execution Date</th><th>Commitment / Purpose</th><th>Exact Amount (₹)</th><th>Suggested destination (not executed)</th></tr></thead>
          <tbody>
            <tr><td><strong>Salary Day (1st)</strong></td><td>Living Essentials &amp; Discretionary</td><td class="numcell">${money(m.essential + m.discretionary)}</td><td>Suggested: retain for living costs</td></tr>
            ${plan.loans.map(l => `<tr><td><strong>Loan Due Date</strong></td><td>${esc(l.name)} EMI</td><td class="numcell">${money(Math.min(l.principal * (1 + l.apr/12), (l.emi || emi(l.principal, l.apr, l.months)) + (l.extraMonthly || 0)))}</td><td>User-managed loan payment; no debit initiated</td></tr>`).join('')}
            <tr><td><strong>Post-Bill Sweep</strong></td><td>Emergency Reserve Refill</td><td class="numcell">${money(m.refill)}</td><td>Suggested reserve account (user-selected)</td></tr>
            ${plan.goals.map((g, i) => `
              <tr>
                <td><strong>10th of Month</strong></td>
                <td>${esc(g.name)} (${g.tier})</td>
                <td class="numcell"><strong>${money(m.contributions[i])}</strong></td>
                <td>${g.category === 'emergency' ? 'Suggested liquid reserve' : weights(g, g.months, plan.investmentStrategy).map((w, j) => (w > 0.001 ? `${pct(w)} ${C.assets[j].name}` : null)).filter(Boolean).join(' + ')}</td>
              </tr>
            `).join('')}
            <tr><td><strong>Residual</strong></td><td>Liquid Surplus Sweep</td><td class="numcell">${money(m.unallocated)}</td><td>User-selected destination; no sweep initiated</td></tr>
          </tbody>
        </table>
      </div>`
    )
  );
}

// MODULE 11: AI FINANCIAL CO-PILOT
function copilotPage() {
  const isLive = Boolean(aiConfig.apiKey || window.hasServerAIKey);
  const providerLabel = isLive ? `${aiConfig.provider} / ${aiConfig.model}` : 'Local plan summary';

  return (
    heading('11 AI FINANCIAL CO-PILOT', 'Ask about your plan', 'Plain-language explanations of your current results.', `<button id="btn-open-drawer-pg" class="primary">Open Co-Pilot Drawer ✨</button>`) +
    panel(
      'Interactive Advisory Conversation',
      `Advisory Engine: ${isLive ? '<strong class="good">AI provider configured (' + esc(providerLabel) + ')</strong>' : '<strong class="neutral">🟡 Local plan summary</strong>'}`,
      `<div class="ai-chips" style="margin-bottom:16px">
        <p>Suggested Inquiries</p>
        <button class="ai-chip" data-ai-prompt="What if I increase monthly savings by ₹15,000?">🔮 What if I increase monthly savings by ₹15,000?</button>
        <button class="ai-chip" data-ai-prompt="Explain how the Debt Escape strategies save me interest and time.">⚡ Debt Escape strategies</button>
        <button class="ai-chip" data-ai-prompt="Which investment basket is safest if a 2008-style crash happens?">🛡️ Safest basket in crash</button>
        <button class="ai-chip" data-ai-prompt="Give me my exact step-by-step action checklist for this month.">📋 This month's checklist</button>
      </div>
      <div id="copilot-main-thread" style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px;max-height:550px;overflow-y:auto;padding-right:6px">
        ${aiMessages.map(m => `<div class="ai-msg ${m.role}">${esc(m.text).replace(/### (.*?)\n/g, '<h3>$1</h3>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n\n/g, '<p></p>')}</div>`).join('') || '<p class="quiet">Click any prompt chip above or type a question below to begin your consultation.</p>'}
        ${aiThinking ? '<div class="ai-msg ai"><span class="spinner"></span>Preparing an explanation of the current plan…</div>' : ''}
      </div>
      <form id="copilot-page-chat-form" style="display:flex;gap:10px">
        <input type="text" id="copilot-page-chat-input" placeholder="Ask about loans, taxes, SIP changes, or 'What if I add ₹15,000'..." style="flex:1" required autocomplete="off">
        <button type="submit" class="primary" style="white-space:nowrap">Send Message →</button>
      </form>`
    )
  );
}

// Planning methodology and model coverage
function methodPage() {
  return heading('10 Methodology & Assumptions', 'What goes into your forecast', 'Inputs, assumptions and model limits in one place.') +
    panel('Model settings', `Configuration ${esc(C.version)} · as of ${esc(C.asOf)}`,
      `<div class="metrics">${metric('Simulation paths', String(C.paths), 'Reproducible seed ' + C.seed, 'Independent paths using common random draws across plans', {seed:C.seed,paths:C.paths})}
      ${metric('General inflation', pct(C.inflation.general), 'Configured annual assumption', 'Monthly inflation indexing', C.inflation)}
      ${metric('Emergency floor', C.circuitMonths + ' months', 'Want and Wish contributions pause below this floor', 'Reserve ÷ essential spending', {months:C.circuitMonths})}</div>
      <div class="tablewrap"><table><thead><tr><th>Asset proxy</th><th>Expected annual return</th><th>Annual volatility</th></tr></thead><tbody>${C.assets.map(a=>`<tr><td>${esc(a.name)}</td><td>${pct(a.mean,1)}</td><td>${pct(a.vol,1)}</td></tr>`).join('')}</tbody></table></div>`) +
    panel('How the model works', 'Planning estimates, with no transaction execution.', `<ul><li>Goal cost = today’s cost × (1 + category inflation) raised to years remaining.</li><li>Income funds essentials, contractual debt, affordable extra principal, emergency refill, then Need, Want and Wish goals. Higher weights receive more within a tier.</li><li>Equity exposure tapers during the last 36 months. Tax uses expected-return approximations rather than individual tax lots.</li><li>Unallocated monthly surplus is kept as cash; it is not automatically invested in goals or treated as another income source.</li><li>Existing savings are split once between the emergency reserve, goal earmarks and unassigned capital.</li><li>Recovery uses a bounded grid and verifies candidates with the same simulation seed. Infeasible candidates stay labelled infeasible.</li><li>Bundled 2006–2025 data is synthetic. It cannot verify real historical performance. Live NAVs are separate observations and do not replace model assumptions.</li><li>Statutory returns, payroll contributions, insurance and tax treatment are simplified. Validate actual product terms and current rules before acting.</li><li>Server accounts use a private SQLite database. Browser backups are stored on this device; export a plan to keep a portable copy.</li></ul>`) +
    panel('Calculation audit', 'Open 𝑓(x) beside a metric to inspect its inputs and formula.', `<p class="quiet">The engine computes financial results. The optional AI service explains the current snapshot and does not execute a new simulation from a chat request.</p>`);
}

function simpleLine(lines, labels, range = ['Start','End']) {
  let W = 680,
    H = 210,
    max = Math.max(1, ...lines.flat()),
    min = Math.min(1, ...lines.flat()) * 0.9,
    n = Math.max(...lines.map(l => l.length)),
    y = v => 180 - ((v - min) / (max - min || 1)) * 155,
    x = i => 50 + (i / Math.max(1, n - 1)) * 610;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Investment growth comparison">
    ${[0, 0.25, 0.5, 0.75, 1].map(f => `<line class="grid" x1="50" x2="660" y1="${180 - f * 155}" y2="${180 - f * 155}"/><text x="40" y="${184 - f * 155}" text-anchor="end">${(min + f * (max - min)).toFixed(1)}×</text>`).join('')}
    ${lines
      .map(
        (l, j) =>
          `<polyline points="${l.map((v, i) => `${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${['var(--accent)', 'var(--amber)', 'var(--muted)'][j]}" stroke-width="${j === 0 ? 2 : 1.5}" ${
            j ? 'stroke-dasharray="4 3"' : ''
          }/>`
      )
      .join('')}
    <text x="50" y="202">${esc(range[0])}</text><text x="660" y="202" text-anchor="end">${esc(range[1])}</text>
  </svg>
  <div class="actions quiet" style="margin-top:6px">
    ${labels.map((l, j) => `<span style="color:${['var(--accent)', 'var(--amber)', 'var(--muted)'][j]}">${l}</span>`).join(' • ')}
  </div>`;
}

// Main View Dispatcher
function renderAsync() {
  const active = document.activeElement;
  if (pointerActive || editAwaitingClick || authModalOpen || active?.matches('input,select,textarea')) { pendingAsyncRender = true; return; }
  render();
}

function render() {
  pendingAsyncRender = false;
  const active = document.activeElement;
  let focusSelector = active?.id ? '#' + CSS.escape(active.id) : null;
  if (!focusSelector && active?.dataset) {
    for (const key of ['act','nav','removeLoan','removeGoal','deleteSnapshot','loadSnapshot']) {
      if (active.dataset[key] !== undefined) {
        const attr = key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        focusSelector = `[data-${attr}="${CSS.escape(active.dataset[key])}"]`;
        break;
      }
    }
  }
  calcStore = [];
  let views = {
    overview: overviewPage,
    profile: profilePage,
    goals: goalsPage,
    cashflow: cashflowPage,
    debt: debtPage,
    invest: investPage,
    fix: fixPage,
    stress: stressPage,
    compare: comparePage,
    action: actionPage,
    copilot: copilotPage,
    method: methodPage
  };
  try {
    shell(views[route] ? views[route]() : overviewPage());
    if (focusSelector) document.querySelector(focusSelector)?.focus({preventScroll:true});
  } catch (e) {
    console.error(e);
    shell(`<div class="error">Unable to render view: ${esc(e.message)}</div>${link('overview', 'Return to Overview & Cockpit')}`);
  }
}

// Critical control routing: handle these controls at document capture so nested labels,
// cards, or stale delegated handlers cannot redirect a lock click to the AI drawer.
// This listener is installed once and survives the app shell being re-rendered.
if (!window.__goalPulseCriticalControlsBound) {
  window.__goalPulseCriticalControlsBound = true;
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const features = document.getElementById('feature-menu');
    if (features?.open && (!features.contains(target) || target.closest('.feature-popover button'))) features.open = false;

    const directLock = target.closest('input[data-field="locks.lifestyle"], input[data-field="locks.dates"]');
    const enclosingLabel = target.closest('label');
    const labelForLock = Boolean(enclosingLabel?.querySelector('input[data-field="locks.lifestyle"], input[data-field="locks.dates"]'));
    if (directLock || labelForLock) {
      // Let the checkbox's native default action and change event run, but prevent
      // parent/card click handlers from interpreting this as an unrelated action.
      event.stopPropagation();
      return;
    }

    const explainControl = target.closest('#open-ai-copilot, [data-act="explain"]');
    if (explainControl) {
      event.preventDefault();
      event.stopPropagation();
      openAIDrawer();
    }
  }, true);
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const features = document.getElementById('feature-menu');
  if (features?.open) {
    features.open = false;
    document.getElementById('features-toggle')?.focus();
    event.preventDefault();
  }
});

// A field's blur/change may occur between pointer-down and click. Keep the
// target DOM alive until that click has been dispatched.
document.addEventListener('pointerdown', () => { pointerActive = true; }, true);
for (const type of ['input','change']) document.addEventListener(type, event => {
  if (event.target instanceof Element && event.target.matches('[data-field],[data-draft-field]')) editAwaitingClick = true;
}, true);
const releasePointer = () => { pointerActive = false; };
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
document.addEventListener('click', () => {
  setTimeout(() => { editAwaitingClick = false; if (pendingAsyncRender && !pointerActive) renderAsync(); }, 0);
}, true);

// --- BOOTSTRAP ---
queueMicrotask(async () => {
  $('#close-explain')?.addEventListener('click', () => $('#explain')?.close());
  window.onpopstate = () => {
    route = location.pathname.slice(1) || 'overview';
    if (!routes.some(([r]) => r === route) && route !== 'login' && route !== 'register') route = 'overview';
    render();
  };

  fetch('/data/illustrative-monthly.json')
    .then(r => r.json())
    .then(d => {
      marketData = d;
      if (route === 'invest') renderAsync();
    })
    .catch(() => {});

  // A session without its device cache must read the vault before any automatic save.
  if (session?.token && !sessionPlan) {
    try {
      const response = await fetch('/api/auth/me', {headers:{Authorization:`Bearer ${session.token}`},signal:AbortSignal.timeout(8000)});
      const data = await response.json();
      if (!response.ok || !data.ok) throw Error('Vault could not be restored.');
      if (data.plan && !validate(data.plan).length) plan = data.plan;
      else if (data.plan && Object.keys(data.plan).length) { recoveryBackup = {plan:data.plan}; try { localStorage.setItem(recoveryKey(),JSON.stringify(recoveryBackup)); } catch {} }
      snapshots = arrayOrEmpty(data.snapshots).filter(s=>s?.plan && s?.result && !validate(s.plan).length);
    } catch {
      session = null;
      try { localStorage.removeItem('goalpulse_family_session'); } catch {}
      lastError = 'The saved vault could not be loaded. Sign in again when connected; no server plan was overwritten.';
    }
  }
  // Fetch live AMFI market data on boot
  syncLiveMarket();

  compute();
});
