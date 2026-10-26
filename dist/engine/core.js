import {CONFIG as C} from '../data/config.js';
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const sum = a => a.reduce((s, x) => s + x, 0);
export const quantile = (a, p) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor((b.length - 1) * p)];
};

export function emi(p, r, n) {
  if (p <= 0 || n <= 0) return 0;
  let m = r / 12;
  return Math.abs(m) < 1e-10 ? p / n : (p * m) / (-Math.expm1(-n * Math.log1p(m)));
}

export function futureValue(w, c, r, n) {
  let m = Math.expm1(Math.log1p(r) / 12);
  return w * (1 + m) ** n + c * (Math.abs(m) < 1e-10 ? n : Math.expm1(n * Math.log1p(m)) / m);
}

export function requiredSaving(fv, w, r, n) {
  if (n <= 0) return Math.max(0, fv - w);
  let m = Math.expm1(Math.log1p(r) / 12);
  return Math.max(0, (fv - w * (1 + m) ** n) / (Math.abs(m) < 1e-10 ? n : Math.expm1(n * Math.log1p(m)) / m));
}

const stepFactors = new Map();
export function stepUpSaving(target, current, annualRate, months, stepUp = 0, startMonth = 1) {
  let m = Math.expm1(Math.log1p(annualRate) / 12),
    key = [annualRate, months, stepUp, startMonth % 12].join('|'),
    factor = stepFactors.get(key);
  if (factor === undefined) {
    factor = 0;
    let year = Math.floor((startMonth - 1) / 12);
    for (let k = 0; k < months; k++)
      factor += (1 + stepUp) ** (Math.floor((startMonth + k - 1) / 12) - year) * (1 + m) ** (months - 1 - k);
    if (stepFactors.size > 10000) stepFactors.clear();
    stepFactors.set(key, factor);
  }
  return Math.max(0, (target - current * (1 + m) ** (months - 1)) / factor);
}

export function amortize(l, {extra = 0, at = 1, offset = 0, newRate = null, monthlyExtra = l.extraMonthly || 0} = {}) {
  let balance = l.principal,
    interest = 0,
    totalPaid = 0,
    rows = [],
    rate = newRate ?? l.apr,
    payment = l.emi || emi(balance, l.apr, l.months);
  for (let t = 1; t <= 1200 && balance > 0.001; t++) {
    let i = Math.max(0, balance - Math.max(0, offset)) * rate / 12;
    let x = monthlyExtra + (t === at ? Math.min(extra, balance) : 0);
    let paid = Math.min(balance + i, payment + x);
    balance = Math.max(0, balance + i - paid);
    interest += i;
    totalPaid += paid;
    rows.push({month: t, payment: paid, interest: i, principal: paid - i, balance});
    if (paid <= i && x === 0) break;
  }
  return {rows, interest, totalPaid, balance, months: rows.length, payment, closed: balance < 1};
}

export function validate(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.goals) || !Array.isArray(p.loans) || !Array.isArray(p.shocks) || !Array.isArray(p.expenses) || !p.locks)
    return ['The plan structure is incomplete. Import a GoalPulse export.'];
  let e = [];
  if ([...p.goals, ...p.loans, ...p.shocks, ...p.expenses].some(x => !x || typeof x !== 'object' || Array.isArray(x)))
    return ['Plan entries must be objects.'];
  if (typeof p.name !== 'string' || p.name.length > 200 || p.goals.some(g => typeof g.name !== 'string' || g.name.length > 200)) e.push('Plan and goal names must be text of at most 200 characters.');
  if (typeof p.locks.lifestyle !== 'boolean' || typeof p.locks.dates !== 'boolean') e.push('Plan locks must be boolean values.');
  for (const k of ['age', 'income', 'essential', 'discretionary', 'savings', 'emergency', 'term', 'health', 'bonus', 'extraIncome', 'topup', 'deductible', 'basic', 'epf', 'ppf', 'nps', 'regularCorpus', 'unrealisedGains', 'transactionCost'])
    if (!Number.isFinite(p[k] ?? 0) || (p[k] ?? 0) < 0) e.push(`${k} must be a non-negative finite number.`);
  if (p.goals.length > 30) e.push('Use at most 30 goals in one plan.');
  if (p.loans.length > 20) e.push('Use at most 20 loans.');
  if (new Set(p.goals.map(g => g.id)).size !== p.goals.length) e.push('Goal IDs must be unique.');
  for (const k of ['age', 'income', 'essential', 'discretionary', 'savings', 'emergency', 'term', 'health', 'bonus', 'bonusMonth', 'topup', 'growth', 'slab', 'copay'])
    if (!Number.isFinite(p[k])) e.push(`${k} is required and must be numeric.`);
  for (const g of p.goals)
    if (!Number.isFinite(g.weight) || g.weight < 1 || g.weight > 10 || !Number.isFinite(g.scope) || !Number.isFinite(g.minScope))
      e.push('Goal weights and scope must be finite and within their stated limits.');
  if (!Number.isFinite(p.reserveMonths) || p.reserveMonths < 3 || p.reserveMonths > 24) e.push('Reserve target must be 3–24 months.');
  for (const [k, max] of [['trim', 0.35], ['volatility', 1], ['savingsStepUp', 0.15]])
    if (!Number.isFinite(p[k] ?? 0) || (p[k] ?? 0) < 0 || (p[k] ?? 0) > max) e.push(`${k} is outside its allowed range.`);
  for (const x of p.expenses)
    if (!Number.isFinite(x.amount) || x.amount < 0 || !Number.isFinite(x.inflation) || x.inflation < -0.05 || x.inflation > 0.6)
      e.push('Expense categories need non-negative amounts and inflation from −5% to 60%.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate) || !Number.isFinite(Date.parse(p.startDate))) e.push('Plan start date is invalid.');
  if (p.emergency > p.savings) e.push('Emergency reserve cannot exceed total liquid savings.');
  for (const g of p.goals || []) {
    if (typeof g.name !== 'string' || !g.name.trim()) e.push('Every goal needs a name.');
    if (typeof g.id !== 'string' || !g.id || ['__proto__', 'constructor', 'prototype'].includes(g.id)) e.push('Every goal needs a valid ID.');
    if (!Number.isFinite(g.cost) || g.cost < 0) e.push('Goal costs must be non-negative.');
    if (!Number.isInteger(g.months) || g.months < 1 || g.months > 600) e.push('Goal horizons must be 1–600 months.');
    if (!Number.isFinite(g.inflation) || g.inflation < -0.05 || g.inflation > 0.6) e.push('Inflation must be between −5% and 60%.');
    if (!['Need', 'Want', 'Wish'].includes(g.tier)) e.push('Goal tier must be Need, Want or Wish.');
    if (g.earmarked < 0 || !Number.isFinite(g.earmarked)) e.push('Earmarked savings must be non-negative.');
    if (g.category === 'emergency' && g.earmarked > 0) e.push('Emergency money is already allocated in the profile reserve. Set this goal earmark to zero to avoid counting it twice.');
    if (g.scope < g.minScope || g.scope > 1 || g.minScope < 0.1) e.push('Goal scope must respect its minimum.');
  }
  if (sum((p.goals || []).map(g => g.earmarked || 0)) > p.savings - p.emergency + 0.01)
    e.push('Earmarked capital exceeds savings after the emergency reserve.');
  for (const l of p.loans || []) {
    if (!Number.isInteger(l.months) || !Number.isFinite(l.emi) || !Number.isFinite(l.extraMonthly ?? 0) || (l.extraMonthly ?? 0) < 0 || typeof l.name !== 'string') e.push('Loan payment, name and tenure must be valid.');
    if (l.principal < 0 || !Number.isFinite(l.principal) || l.apr < 0 || l.apr > 0.6 || !Number.isFinite(l.apr) || l.months < 1 || l.months > 600 || l.emi < 0)
      e.push('Loan amount, APR or tenure is outside its allowed range.');
    if (l.emi && l.emi <= l.principal * l.apr / 12) e.push(`${l.name}: EMI does not cover first-month interest.`);
  }
  for (const k of ['growth', 'slab', 'copay'])
    if (!Number.isFinite(p[k]) || p[k] < (k === 'growth' ? -0.05 : 0) || p[k] > 0.6) e.push(`${k} is outside its allowed range.`);
  if ((p.shocks || []).length > 10) e.push('Use at most 10 simultaneous shocks.');
  for (const s of p.shocks || [])
    if (!['job', 'medical', 'crash', 'rate', 'dependent', 'bonus', 'inflation'].includes(s.type) || !Number.isFinite(s.value) || s.value < 0 || !Number.isInteger(s.month) || !Number.isInteger(s.duration) || s.month < 1 || s.month > 600 || s.duration < 1 || s.duration > 600 || (['job', 'crash'].includes(s.type) && s.value > 1) || (['rate', 'inflation'].includes(s.type) && s.value > .6))
      e.push('Invalid shock values.');
  return [...new Set(e)];
}

export function basket(months, strategy = 'horizon_default') {
  if (strategy === 'sovereign_gold_barbell') return [0, 0.35, 0.40, 0.25];
  if (strategy === 'all_weather_erc') return riskParity();
  if (strategy === 'global_sovereign_fx') return [0.35, 0.40, 0.10, 0.15];
  return months <= 18 ? [0, 0, 0, 1] : months <= 48 ? [0.15, 0.65, 0.2, 0] : months <= 96 ? [0.70, 0.20, 0.10, 0] : [0.85, 0.15, 0, 0];
}

export function weights(g, remaining, strategy = 'horizon_default') {
  let w = [...basket(g.months, strategy)],
    eq = w[0],
    shield = clamp((remaining - 6) / 30);
  w[0] *= shield;
  w[3] += eq - w[0];
  return w;
}

export function enabled(p, key, legacy) {
  return Boolean(p.optimizations?.[key] ?? p.opt?.[legacy] ?? p[legacy]);
}

export function netMeans(p) {
  const slab = p.slab ?? C.tax.slab;
  const isDirect = enabled(p, 'directFeeRecapture', 'direct');
  const fee = isDirect ? C.rates.directFee : C.rates.regularFee;
  return C.assets.map((a, i) => a.mean * (1 - (i === 0 ? C.tax.ltcg * (1 + C.tax.cess) : slab)) - (i === 0 ? fee : 0));
}

export function goalRate(p, g, remaining = g.months) {
  const strategy = p.investmentStrategy || 'horizon_default';
  return sum(weights(g, remaining, strategy).map((w, i) => w * netMeans(p)[i]));
}

export function cholesky(matrix) {
  let l = matrix.map(r => r.map(() => 0));
  for (let i = 0; i < matrix.length; i++)
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += l[i][k] * l[j][k];
      l[i][j] = i === j ? Math.sqrt(Math.max(1e-12, matrix[i][i] - s)) : (matrix[i][j] - s) / l[j][j];
    }
  return l;
}

export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

export function medicalOutOfPocket(p, bill) {
  let deductible = Math.min(bill, p.deductible || 0),
    eligible = bill - deductible,
    covered = Math.min(eligible, (p.health || 0) + (p.topup || 0));
  return deductible + Math.max(0, eligible - covered) + covered * (p.copay || 0);
}

function debtTarget(p, g) {
  let loans = g.name.toLowerCase().includes('personal') ? p.loans.filter(l => l.id === 'personal') : p.loans;
  return sum(loans.map(l => amortize(l).rows[Math.max(0, g.months - 1)]?.balance || 0));
}

function setup(p) {
  let goals = p.goals.map(g => ({...g, cost: g.category === 'debt' ? debtTarget(p, g) : g.cost}));
  let unassigned = Math.max(0, p.savings - p.emergency - sum(goals.map(g => g.earmarked || 0)));
  let sorted = goals.map((g, i) => ({g, i})).filter(({g}) => g.category !== 'emergency').sort((a, b) => ['Need', 'Want', 'Wish'].indexOf(a.g.tier) - ['Need', 'Want', 'Wish'].indexOf(b.g.tier) || a.g.months - b.g.months);
  let wealth = goals.map(g => g.earmarked || 0);
  for (const {g, i} of sorted) {
    let required = g.cost * (g.scope || 1) * (1 + g.inflation) ** (g.months / 12);
    let add = Math.min(unassigned, Math.max(0, required - wealth[i]));
    wealth[i] += add;
    unassigned -= add;
  }
  return {goals, wealth, unassigned};
}

function run(p, random = null, detail = false) {
  const {goals, wealth, unassigned} = setup(p);
  const initialWealth = [...wealth];
  const horizon = Math.max(12, ...goals.map(g => g.months));
  const means = netMeans(p);
  const L = cholesky(C.correlation);

  const cashUpgrade = enabled(p, 'cashUpgrade', 'cashUpgrade');
  const strategy = p.investmentStrategy || 'horizon_default';

  // Auto-link statutory retirement goal if not explicitly set
  let statutoryGoal = p.statutoryGoal;
  if (!statutoryGoal) {
    let retGoal = goals.find(g => g.category === 'retirement');
    if (retGoal && ((p.epf || 0) > 0 || (p.ppf || 0) > 0 || (p.nps || 0) > 0 || (p.basic || 0) > 0)) {
      statutoryGoal = retGoal.id;
    }
  }

  let reserve = p.emergency + unassigned,
    balances = p.loans.map(l => l.principal),
    payments = p.loans.map(l => l.emi || emi(l.principal, l.apr, l.months)),
    rates = p.loans.map(l => l.apr),
    targets = goals.map(g => g.cost * (g.scope ?? 1)),
    terminal = goals.map(() => 0),
    finalTargets = goals.map(() => 0),
    contributions = goals.map(() => 0),
    series = goals.map(() => []),
    ledger = [],
    firstDeficit = null,
    firstResource = null,
    unfundedTotal = 0,
    pi = C.inflation.general,
    expenseIndex = 1,
    cash = 0,
    netWorthCross = null;

  let statutory = (p.epf || 0) + (p.ppf || 0) + (p.nps || 0),
    epf = p.epf || 0,
    ppf = p.ppf || 0,
    nps = p.nps || 0;

  for (let t = 1; t <= horizon; t++) {
    let eps = Array.from({length: 7}, () => (random ? normal(random) : 0)),
      z = L.map(row => sum(row.map((v, j) => v * eps[j])));
    pi = C.inflation.general + C.inflationPhi * (pi - C.inflation.general) + C.inflationVol * eps[4];
    pi = clamp(pi, -0.05, 0.6);
    let inflationShock = sum((p.shocks || []).filter(s => s.type === 'inflation' && t >= s.month && t < s.month + s.duration).map(s => s.value));
    expenseIndex *= (1 + clamp(pi + inflationShock, -0.05, 0.6)) ** (1 / 12);

    let income = (p.income + (p.extraIncome || 0)) * (1 + p.growth) ** Math.floor((t - 1) / 12) * Math.exp((p.volatility || 0) * eps[5] - 0.5 * (p.volatility || 0) ** 2 * (random ? 1 : 0));
    let bonus = (new Date(p.startDate).getUTCMonth() + t) % 12 + 1 === p.bonusMonth ? p.bonus : 0;
    let essential = p.essential * expenseIndex;
    let disc = p.discretionary * (1 - (p.trim || 0)) * expenseIndex,
      shockCost = 0,
      crash = 0;

    for (const s of p.shocks || []) {
      let active = t >= s.month && t < s.month + s.duration;
      if (s.type === 'job' && active) income *= 1 - clamp(s.value);
      if (s.type === 'dependent' && active) shockCost += s.value * (1 + C.inflation.general) ** ((t - s.month) / 12);
      if (t === s.month) {
        if (s.type === 'medical') shockCost += medicalOutOfPocket(p, s.value);
        if (s.type === 'bonus') bonus += s.value;
        if (s.type === 'crash') crash = 1 - (1 - crash) * (1 - clamp(s.value));
        if (s.type === 'rate')
          p.loans.forEach((l, j) => {
            if (l.floating) {
              rates[j] += s.value;
              payments[j] = emi(balances[j], rates[j], Math.max(1, l.months - t + 1));
            }
          });
      }
    }

    income += bonus;

    // Contractual payments come first. Extra principal is limited to real surplus,
    // so a prepayment cannot consume the emergency fund or fabricate cash.
    let debtPayment = 0;
    balances = balances.map((b, j) => {
      if (b < 0.001) return 0;
      const interest = b * rates[j] / 12;
      const payment = Math.min(b + interest, payments[j]);
      debtPayment += payment;
      return Math.max(0, b + interest - payment);
    });
    let extraBudget = Math.max(0, income - essential - disc - debtPayment - shockCost);
    balances = balances.map((b, j) => {
      const extra = Math.min(b, p.loans[j].extraMonthly || 0, extraBudget);
      extraBudget -= extra;
      debtPayment += extra;
      return b - extra;
    });

    let totalMonthlyInflow = income;
    let surplus = totalMonthlyInflow - essential - disc - debtPayment - shockCost,
      draw = Math.min(reserve, Math.max(0, -surplus)),
      unfunded = Math.max(0, -surplus - draw);
    reserve -= draw;
    unfundedTotal += unfunded;
    if (surplus < 0 && firstDeficit === null) firstDeficit = t;

    // Toggle 1: Idle-Cash Tax-Efficient Yield Upgrade
    let reserveYieldMonthly = cashUpgrade
      ? Math.expm1(Math.log1p(C.assets[3].mean * (1 - p.slab)) / 12)
      : Math.expm1(Math.log1p(C.rates.savings * (1 - p.slab)) / 12);
    reserve *= 1 + reserveYieldMonthly;

    goals.forEach((g, i) => {
      if (t > g.months) return;
      const inflation = clamp(g.inflation + (random ? pi - C.inflation.general : 0) + inflationShock, -0.05, 0.6);
      targets[i] *= (1 + inflation) ** (1 / 12);
    });
    let available = Math.max(0, surplus),
      reserveGoal = Math.max(p.reserveMonths * essential, ...goals.map((g,i) => g.category === 'emergency' ? targets[i] : 0));
    let refill = Math.min(available, Math.max(0, reserveGoal - reserve));
    reserve += refill;
    available -= refill;

    epf = epf * (1 + C.rates.epf) ** (1 / 12) + (p.basic || 0) * 0.24;
    ppf *= (1 + C.rates.ppf) ** (1 / 12);
    nps *= (1 + C.rates.nps) ** (1 / 12);
    statutory = epf + ppf + nps;

    let cs = goals.map(() => 0),
      req = goals.map(() => 0);

    goals.forEach((g, i) => {
      if (t > g.months) return;

      if (g.category === 'emergency') return;

      let w = weights(g, g.months - t + 1, strategy);
      let annual = means.map((m, a) =>
        random
          ? Math.exp((Math.log1p(m) - 0.5 * C.assets[a].vol ** 2) / 12 + (C.assets[a].vol / Math.sqrt(12)) * z[a]) - 1
          : Math.expm1(Math.log1p(m) / 12)
      );

      annual[0] = (1 + annual[0]) * (1 - crash) - 1;
      wealth[i] *= 1 + sum(w.map((v, a) => v * annual[a]));

      let futureTarget = targets[i] * (1 + g.inflation) ** ((g.months - t) / 12),
        st = statutoryGoal === g.id && g.category === 'retirement' ? statutory * (1 + C.rates.ppf) ** ((g.months - t) / 12) : 0;
      let allocationRate = goalRate(p, g, g.months - t + 1),
        allocationMonthly = Math.expm1(Math.log1p(allocationRate) / 12);
      req[i] =
        (p.savingsStepUp || 0) > 0
          ? stepUpSaving(Math.max(0, futureTarget - st), wealth[i], allocationRate, g.months - t + 1, p.savingsStepUp, t)
          : requiredSaving(Math.max(0, futureTarget - st), wealth[i] / (1 + allocationMonthly), allocationRate, g.months - t + 1);
    });

    if (sum(req) > available + 0.01 && firstResource === null) firstResource = t;

    for (const tier of ['Need', 'Want', 'Wish']) {
      if (tier !== 'Need' && reserve < C.circuitMonths * essential) continue;
      let ids = goals
        .map((g, i) => ({g, i}))
        .filter(({g, i}) => g.tier === tier && g.category !== 'emergency' && t <= g.months && req[i] > 0);
      let total = sum(ids.map(({i}) => req[i])),
        budget = Math.min(available, total);
      let left = budget;
      for (let pass = 0; pass < ids.length + 1 && left > 0.0001; pass++) {
        let active = ids.filter(({i}) => req[i] - cs[i] > 0.00001);
        let denominator = sum(active.map(({g, i}) => g.weight * (req[i] - cs[i])));
        if (!denominator) break;
        let used = 0;
        for (const {g, i} of active) {
          let c = Math.min(req[i] - cs[i], left * g.weight * (req[i] - cs[i]) / denominator);
          cs[i] += c;
          used += c;
        }
        left -= used;
      }
      available = Math.max(0, available - (budget - left));
    }

    goals.forEach((g, i) => {
      if (t > g.months) return;
      wealth[i] += cs[i];
      contributions[i] += cs[i];
      let w = g.category === 'emergency' ? reserve : wealth[i] + (statutoryGoal === g.id && g.category === 'retirement' ? statutory : 0);
      if (t === g.months) {
        terminal[i] = w;
        finalTargets[i] = targets[i];
        if (g.category === 'debt') {
          let remaining = w;
          balances = balances.map((b, j) => {
            if (g.name.toLowerCase().includes('personal') && p.loans[j].id !== 'personal') return b;
            let pay = Math.min(b, remaining);
            remaining -= pay;
            return b - pay;
          });
        }
        if (g.category !== 'emergency') wealth[i] = 0;
      }
      if (detail || random) series[i].push(w);
    });

    cash += available;
    let allocations = sum(cs);
    // Strict Cash-Flow Conservation Invariant Check
    let invariant = totalMonthlyInflow + draw + unfunded - essential - disc - debtPayment - shockCost - refill - allocations - available;
    if (Math.abs(invariant) > 0.01) throw Error(`Cash-flow invariant failed in month ${t}: invariant=${invariant}`);

    if (netWorthCross === null && sum(wealth) + reserve + cash + statutory >= sum(balances)) netWorthCross = t;
    if (detail)
      ledger.push({
        month: t,
        income: totalMonthlyInflow,
        essential,
        discretionary: disc,
        emi: debtPayment,
        shock: shockCost,
        surplus,
        reserveDraw: draw,
        unfunded,
        reserve,
        refill,
        allocation: allocations,
        unallocated: available,
        cumulativeCash: cash,
        contributions: cs,
        invariant,
        resourceDeficit: Math.max(0, sum(req) - Math.max(0, surplus)),
        debt: sum(balances)
      });
  }
  return {goals, terminal, finalTargets, contributions, series, ledger, firstDeficit, firstResource, unfundedTotal, netWorthCross, initialWealth, initialReserve: p.emergency + unassigned};
}

export function evaluate(p) {
  let errors = validate(p);
  if (errors.length) throw Error(errors.join(' '));
  let a = run(p, null, true);
  let goal_outcomes = a.goals.map((g, i) => ({
    ...g,
    target: a.finalTargets[i],
    corpus: a.terminal[i],
    shortfall: Math.max(0, a.finalTargets[i] - a.terminal[i]),
    required: requiredSaving(a.finalTargets[i], g.category === 'emergency' ? a.initialReserve : a.initialWealth[i], g.category === 'emergency' ? (enabled(p, 'cashUpgrade', 'cashUpgrade') ? C.assets[3].mean : C.rates.savings) * (1 - p.slab) : goalRate(p, g), g.months),
    contributed: a.contributions[i],
    series: a.series[i],
    probability: null
  }));
  let debt = sum(p.loans.map(l => l.principal)),
    service = sum(p.loans.map(l => l.emi || emi(l.principal, l.apr, l.months))),
    termRequired = C.termIncomeMultiple * p.income * 12 + debt,
    netWorth = p.savings + (p.epf || 0) + (p.ppf || 0) + (p.nps || 0) - debt;
  let pillars = {
    Liquidity: clamp(p.emergency / Math.max(1, p.essential * C.reserveMonths)),
    Solvency: 1 - clamp(service / Math.max(1, 0.5 * p.income)),
    Protection: 0.5 * clamp(p.term / Math.max(1, termRequired)) + 0.5 * clamp((p.health + p.topup) / C.medicalShock),
    Growth: clamp(netWorth / Math.max(1, p.income * 12 * Math.max(1, (p.age - 20) / 10))),
    Readiness: goal_outcomes.length
      ? sum(goal_outcomes.map(g => clamp(g.corpus / Math.max(1, g.target)) * g.weight)) / sum(goal_outcomes.map(g => g.weight))
      : 1
  };
  return {
    inputs: p,
    goal_outcomes,
    monthly_ledger: a.ledger,
    firstDeficit: a.firstDeficit,
    firstResource: a.firstResource,
    unfunded: a.unfundedTotal,
    netWorth,
    netWorthCross: a.netWorthCross,
    termRequired,
    termGap: Math.max(0, termRequired - p.term),
    healthGap: Math.max(0, C.medicalShock - p.health - p.topup),
    pillars,
    healthScore: sum(Object.values(pillars)) * 20,
    totalShortfall: sum(goal_outcomes.map(g => g.shortfall)),
    rescue_steps: [],
    pareto_options: []
  };
}

export function simulate(p, paths = C.paths) {
  if (!Number.isInteger(paths) || paths < 1 || paths > 10000) throw Error('Simulation paths must be 1–10,000.');
  let result = evaluate(p),
    samples = p.goals.map(() => []),
    costs = p.goals.map(() => []),
    traces = p.goals.map(g => Array.from({length: g.months}, () => [])),
    combined = [];
  for (let n = 0; n < paths; n++) {
    let a = run(p, rng(C.seed + n * 7919));
    let deficit = 0;
    a.terminal.forEach((v, i) => {
      samples[i].push(v);
      costs[i].push(a.finalTargets[i]);
      if (!a.goals[i].hard) deficit += Math.max(0, a.finalTargets[i] - v);
      a.series[i].forEach((w, t) => traces[i][t].push(w));
    });
    combined.push(deficit);
  }
  result.goal_outcomes = result.goal_outcomes.map((g, i) => {
    let success = samples[i].filter((v, n) => v + 1 >= costs[i][n]).length;
    return {
      ...g,
      probability: success / paths,
      corpus: quantile(samples[i], 0.5),
      p10: quantile(samples[i], 0.1),
      p90: quantile(samples[i], 0.9),
      shortfall: sum(samples[i].map((v, n) => Math.max(0, costs[i][n] - v))) / paths,
      shortfall90: quantile(samples[i].map((v, n) => Math.max(0, costs[i][n] - v)), 0.9),
      bands: traces[i].map(v => ({p10: quantile(v, 0.1), p50: quantile(v, 0.5), p90: quantile(v, 0.9)}))
    };
  });
  result.paths = paths;
  result.totalShortfall = sum(result.goal_outcomes.map(g => g.shortfall));
  result.sharedBufferSaving = Math.max(0, sum(result.goal_outcomes.filter(g => !g.hard).map(g => g.shortfall90)) - quantile(combined, 0.9));
  result.pillars.Readiness = result.goal_outcomes.length
    ? sum(result.goal_outcomes.map(g => g.probability * g.weight)) / sum(result.goal_outcomes.map(g => g.weight))
    : 1;
  result.healthScore = sum(Object.values(result.pillars)) * 20;
  return result;
}

export function feasible(r) {
  return r.unfunded < 1 && r.goal_outcomes.every(g => g.probability !== null && g.probability >= C.targets[g.tier]);
}

export function ufpi(p, base) {
  let money = clamp((p.trim || 0) / 0.35 + 0.5 * p.goals.filter(g => (g.scope || 1) < 1).length / Math.max(1, p.goals.length)),
    patience = clamp(
      0.5 * sum(p.goals.map(g => g.weight * Math.max(0, g.months - (base.goals.find(b => b.id === g.id)?.months || g.months)))) /
        Math.max(1, C.maxDelay * sum(p.goals.map(g => g.weight)))
    ),
    effort = 1 / 24;
  return {money, patience, effort, score: 100 * (C.ufpiWeights[0] * money + C.ufpiWeights[1] * patience + C.ufpiWeights[2] * effort)};
}

export function canDelay(p, g, months) {
  if (g.hard || g.months + months > 600) return false;
  let rate = goalRate(p, g);
  return (
    requiredSaving(g.cost * (1 + g.inflation) ** ((g.months + months) / 12), g.earmarked, rate, g.months + months) <
    requiredSaving(g.cost * (1 + g.inflation) ** (g.months / 12), g.earmarked, rate, g.months)
  );
}

export function recover(p, paths = 1000) {
  let working = structuredClone(p);
  working.opt = working.opt || {};
  working.optimizations = working.optimizations || {};
  let before = simulate(working, paths),
    previous = before,
    steps = [];

  // The Core Zero-Sacrifice Efficiency Levers Waterfall
  const efficiencyLevers = [
    {name: 'Idle cash yield assumption', key: 'cashUpgrade', optKey: 'cashUpgrade', note: 'Compare configured post-tax savings and liquid-reserve rates; liquidity and product risks still apply.'},
    {name: 'Regular-to-direct fee comparison', key: 'direct', optKey: 'directFeeRecapture', note: 'Lower configured equity fees change portfolio growth, never monthly salary.'},
    {name: 'Shared flexible-goal buffer', key: null, note: 'Measured reserve statistic only; no extra cash is injected into the plan.'}
  ];

  for (const step of efficiencyLevers) {
    let current = previous;
    if (step.key) {
      working[step.key] = true;
      working.opt[step.key] = true;
      if (step.optKey) working.optimizations[step.optKey] = true;
      current = simulate(working, paths);
    }
    steps.push({
      ...step,
      before: previous.totalShortfall,
      after: current.totalShortfall,
      recovered: Math.max(0, previous.totalShortfall - current.totalShortfall),
      buffer: step.name.startsWith('Shared') ? current.sharedBufferSaving : 0
    });
    previous = current;
  }

  let candidates = [],
    seen = new Set();
  for (const delay of p.locks.dates ? [0] : [0, 6, 12, 24]) {
    for (const trim of p.locks.lifestyle ? [p.trim || 0] : [0, 0.1, 0.2, 0.35]) {
      for (const scope of [1, 0.9, 0.8]) {
        for (const stepUp of [0, 0.04, 0.08, 0.15]) {
          let q = structuredClone(working);
          q.trim = Math.max(p.trim || 0, trim);
          q.savingsStepUp = stepUp;
          q.goals = q.goals.map(g => ({
            ...g,
            months: g.months + (canDelay(q, g, delay) ? delay : 0),
            scope: g.hard ? g.scope : Math.min(g.scope, Math.max(g.minScope, scope))
          }));
          let key = JSON.stringify(q);
          if (seen.has(key)) continue;
          seen.add(key);
          let r = evaluate(q),
            burden = ufpi(q, p);
          candidates.push({plan: q, result: r, burden, delay, trim, scope, stepUp});
        }
      }
    }
  }

  candidates.sort((a, b) => a.result.totalShortfall - b.result.totalShortfall || a.burden.score - b.burden.score);
  let verified = [];
  let promising = candidates.filter(x => x.result.totalShortfall < 1);
  let shortlist = (promising.length ? promising : candidates).sort((a, b) => a.burden.score - b.burden.score).slice(0, 12);

  for (const c of shortlist) {
    c.result = simulate(c.plan, paths);
    c.feasible = feasible(c.result);
    verified.push(c);
  }

  let good = verified.filter(c => c.feasible);
  let pool = good.length ? good : verified
    .filter(c => c.result.totalShortfall + 1 < previous.totalShortfall || c.result.unfunded + 1 < previous.unfunded)
    .sort((a, b) => a.result.totalShortfall - b.result.totalShortfall).slice(0, 6);

  let pareto = pool.filter(
    a =>
      !pool.some(
        b =>
          b !== a &&
          b.burden.money <= a.burden.money &&
          b.burden.patience <= a.burden.patience &&
          b.burden.effort <= a.burden.effort &&
          (good.length || b.result.totalShortfall <= a.result.totalShortfall) &&
          (b.burden.money < a.burden.money || b.burden.patience < a.burden.patience || b.burden.effort < a.burden.effort || (!good.length && b.result.totalShortfall < a.result.totalShortfall))
      )
  );

  let opts = [],
    used = new Set();
  for (const [label, key] of [['Least spending change', 'money'], ['Least delay', 'patience'], ['Balanced burden', 'score']]) {
    let c = [...pareto].sort((a, b) => a.burden[key] - b.burden[key] || a.result.totalShortfall - b.result.totalShortfall).find(x => !used.has(x));
    if (c) {
      used.add(c);
      opts.push({...c, label});
    }
  }

  let lo = 0,
    hi = Math.max(10000, p.income);
  let enough = x => {
    let q = structuredClone(working);
    q.extraIncome = (p.extraIncome || 0) + x;
    let r = evaluate(q);
    return r.totalShortfall < 1 && r.unfunded < 1;
  };
  while (!enough(hi) && hi < 1e8) hi *= 2;
  let incomeFeasible = enough(hi);
  if (incomeFeasible) {
    for (let i = 0; i < 24; i++) {
      let mid = (lo + hi) / 2;
      if (enough(mid)) hi = mid;
      else lo = mid;
    }
  }

  return {
    before,
    after: previous,
    plan: working,
    steps,
    options: opts,
    feasible: good.length > 0,
    additionalIncome: incomeFeasible ? Math.ceil(hi) : null,
    ceilingReason: incomeFeasible
      ? 'Additional income estimate is a deterministic lower bound.'
      : 'Increasing salary alone cannot repair this scenario within the search bound. An income interruption can exhaust the reserve at a hard goal deadline regardless of normal salary. Change the reserve, shock exposure, or eligible goal constraints.',
    searched: candidates.length,
    verified: verified.length,
    limitation: 'Finite grid search; verified candidates receive full 1,000-path simulation. Extra income is a deterministic lower bound.'
  };
}

export function cppi(principal, months, paths = 1000) {
  let out = [];
  for (let n = 0; n < paths; n++) {
    let r = rng(C.seed + n * 7919),
      v = principal,
      floor = principal / (1 + C.rates.fd) ** (months / 12);
    for (let t = 1; t <= months; t++) {
      let risky = Math.min(v, 3 * Math.max(0, v - floor)),
        ret = Math.exp((Math.log1p(0.105) - 0.5 * 0.2 ** 2) / 12 + (0.2 / Math.sqrt(12)) * normal(r)) - 1;
      v = risky * (1 + ret) + (v - risky) * (1 + C.rates.fd) ** (1 / 12);
      floor *= (1 + C.rates.fd) ** (1 / 12);
    }
    out.push(v);
  }
  return {probability: out.filter(x => x >= principal).length / paths, p10: quantile(out, 0.1), median: quantile(out, 0.5), worst: Math.min(...out), principal, months, paths};
}

export function riskParity() {
  let cov = C.correlation.map((row, i) => row.map((v, j) => v * C.assets[i].vol * C.assets[j].vol)),
    x = [1, 1, 1, 1];
  for (let k = 0; k < 500; k++)
    for (let i = 0; i < 4; i++) {
      let b = sum(cov[i].map((v, j) => (j === i ? 0 : v * x[j]))),
        a = cov[i][i];
      x[i] = (-b + Math.sqrt(b * b + (4 * a) / 4)) / (2 * a);
    }
  return x.map(v => v / sum(x));
}

export function backtest(rows, w, months = 60, required = 0.06) {
  let returns = rows.map(row => sum(w.map((v, i) => v * row[C.assets[i].id]))),
    windows = [];
  for (let start = 0; start + months <= returns.length; start++) {
    let v = 1;
    for (let t = start; t < start + months; t++) v *= 1 + returns[t];
    windows.push(v ** (12 / months) - 1);
  }
  let v = 1,
    peak = 1,
    maxDrawdown = 0,
    dd = [],
    underwater = 0,
    runLen = 0,
    maxUnderwater = 0,
    line = [];
  for (const r of returns) {
    v *= 1 + r;
    peak = Math.max(peak, v);
    let d = v / peak - 1;
    maxDrawdown = Math.min(maxDrawdown, d);
    dd.push(d * d);
    if (d < -0.00001) {
      underwater++;
      runLen++;
      maxUnderwater = Math.max(maxUnderwater, runLen);
    } else runLen = 0;
    line.push(v);
  }
  let avg = returns.length ? sum(returns) / returns.length : 0,
    down = returns.length ? Math.sqrt(sum(returns.map(x => Math.min(0, x) ** 2)) / returns.length) : 0;
  return {
    windows: windows.length,
    win: windows.length ? windows.filter(x => x >= required).length / windows.length : 0,
    min: windows.length ? Math.min(...windows) : 0,
    median: quantile(windows, 0.5),
    max: windows.length ? Math.max(...windows) : 0,
    maxDrawdown,
    ulcer: dd.length ? Math.sqrt(sum(dd) / dd.length) : 0,
    sortino: down ? (avg / down) * Math.sqrt(12) : null,
    underwater,
    maxUnderwater,
    line
  };
}

export function debtAnalysis(p, l, extra = 50000, newRate = 0.08, fee = 5000) {
  let baseline = amortize({...l, extraMonthly: 0});
  let offset = l.offset && l.autopay ? Math.max(0, p.income - (p.essential + p.discretionary) / 2) + (l.cardSpend || 0) * Math.min(45, l.floatDays || 0) / 30 : 0;
  let optimized = amortize({...l, extraMonthly: 0}, {monthlyExtra: extra});
  // Compare the same payoff horizon. A lower payment over a much longer term is
  // not a refinancing saving, particularly when the entered EMI pays off early.
  let newEmi = emi(l.principal, newRate, baseline.months);
  let refi = amortize({...l, months: baseline.months, emi: newEmi, extraMonthly: 0}, {newRate});
  let discount = Math.expm1(Math.log1p(C.rates.fd * (1 - p.slab)) / 12);
  let pv = sum(baseline.rows.map((row, i) => (row.payment - (refi.rows[i]?.payment || 0)) / (1 + discount) ** (i + 1)));
  let effective = l.apr * (1 - (p.taxRegime === 'old' && l.deductible ? p.slab * (l.deductibleShare || 0) : 0));
  let ce = netMeans(p)[0] - 0.5 * 3 * C.assets[0].vol ** 2;
  let penalty = 0; // Prepayment fees require an explicit lender quote; not included in this scenario.
  let extraPaid = sum(optimized.rows.map(row => Math.max(0, row.payment - baseline.payment)));
  return {
    baseline,
    optimized,
    interestSaved: baseline.interest - optimized.interest - penalty,
    extraPaid,
    multiplier: extraPaid ? (baseline.interest - optimized.interest - penalty) / extraPaid : 0,
    offset,
    refi,
    newEmi,
    pv,
    fee,
    refinance: pv > 2.5 * fee,
    effective,
    ce,
    prepay: effective > ce && p.emergency >= p.essential * C.circuitMonths
  };
}
