import {CONFIG} from './config.js';

const goal = (id, name, cost, years, tier, category, hard = false) => ({
  id, name, cost, months: years * 12, tier, category, hard, minScope: 0.8, scope: 1,
  weight: tier === 'Need' ? 3 : tier === 'Want' ? 2 : 1,
  inflation: CONFIG.inflation[category] ?? 0.06, earmarked: 0
});

const loan = (id, name, principal, apr, months, emi = 0) => ({
  id, name, principal, apr, months, emi, floating: true, penalty: 0,
  deductible: false, deductibleShare: 0, offset: false, autopay: false, cardSpend: 0, floatDays: 0
});

const base = {
  version: 2,
  startDate: '2026-10-25',
  name: 'My financial plan',
  age: 32,
  income: 240000,
  growth: 0.07,
  volatility: 0,
  stability: 'stable',
  essential: 105000,
  discretionary: 20000,
  savings: 1800000,
  emergency: 650000,
  reserveMonths: 6,
  bonus: 0,
  bonusMonth: 3,
  basic: 80000,
  epf: 1400000,
  ppf: 500000,
  nps: 300000,
  statutoryGoal: 'retirement',
  taxRegime: 'new',
  slab: 0.30,
  term: 20000000,
  health: 1000000,
  topup: 1500000,
  deductible: 0,
  copay: 0,
  locks: { lifestyle: true, dates: true },
  trim: 0,
  savingsStepUp: 0,
  extraIncome: 0,
  shocks: [],
  loans: [],
  goals: [],
  direct: true,
  cashUpgrade: true,
  harvest: true,
  regularCorpus: 600000,
  unrealisedGains: 120000,
  transactionCost: 500,
  expenses: [],
  ufpi: 0,
  opt: {
    cashUpgrade: true,
    direct: true,
    ltcgHarvest: true,
    velocityOffset: false,
    familySwap: false,
    sovereignFloor: false,
    reitRelay: false
  },
  optimizations: {
    cashUpgrade: true,
    directFeeRecapture: true,
    ltcgTaxHarvest: true,
    velocityOffsetRefi: false,
    familyLoanSwap: false,
    sovereignCouponCore: false,
    reitCashflowShield: false,
    globalSovereignSleeve: false
  },
  investmentStrategy: 'horizon_default'
};

export const PERSONAS = [
  {
    ...base,
    id: 'hackathon',
    name: 'Sharma Household (Hackathon Benchmark)',
    label: 'Standard Hackathon Household (₹85k Income, ₹25k Surplus)',
    age: 34,
    income: 85000,
    growth: 0.06,
    essential: 40000,
    discretionary: 10000,
    savings: 300000,
    emergency: 150000,
    reserveMonths: 4,
    basic: 35000,
    epf: 450000,
    ppf: 150000,
    nps: 100000,
    statutoryGoal: 'retirement',
    term: 10000000,
    health: 1000000,
    topup: 1000000,
    regularCorpus: 0,
    unrealisedGains: 0,
    loans: [
      { ...loan('homeloan', 'Home Loan EMI', 950000, 0.088, 120, 10000), offset: true, autopay: true }
    ],
    goals: [
      goal('emergency', 'Emergency Reserve Shield', 150000, 0.5, 'Need', 'emergency', true),
      { ...goal('education', 'Children Higher Education', 1000000, 10, 'Need', 'education'), inflation: 0.06 },
      goal('retirement', 'Retirement Corpus', 5000000, 20, 'Need', 'retirement')
    ],
    note: 'Authoritative evaluation household with ₹85,000 income (₹45k+₹5k Person 1, ₹30k+₹3k Person 2, ₹2k Other), ₹40,000 essential, ₹10,000 lifestyle, ₹10,000 EMI, and ₹25,000 net monthly surplus.'
  },
  {
    ...base,
    id: 'aarav',
    name: 'Aarav',
    label: 'Early-career graduate',
    age: 24,
    income: 85000,
    growth: 0.10,
    essential: 35000,
    discretionary: 18000,
    savings: 150000,
    emergency: 60000,
    basic: 30000,
    epf: 80000,
    ppf: 50000,
    nps: 0,
    statutoryGoal: 'retirement',
    term: 5000000,
    health: 500000,
    topup: 500000,
    regularCorpus: 50000,
    unrealisedGains: 15000,
    loans: [{ ...loan('education', 'Education loan', 800000, 0.095, 84), deductible: true, deductibleShare: 1, offset: true, autopay: true, cardSpend: 15000, floatDays: 30 }],
    goals: [
      goal('buffer', 'Emergency fund', 250000, 1, 'Need', 'emergency', true),
      goal('closure', 'Clear education loan early', 0, 3, 'Need', 'debt'),
      goal('study', 'MS / MBA upskilling', 2200000, 4, 'Want', 'education'),
      goal('retirement', 'Seed retirement', 50000000, 35, 'Wish', 'retirement')
    ],
    note: 'Early-career graduate with education debt and international study ambition. Prepayment relay and direct fee recapture accelerate net corpus build.'
  },
  {
    ...base,
    id: 'priya',
    name: 'Priya & Rohan',
    label: 'Young dual-income family',
    age: 32,
    income: 240000,
    growth: 0.07,
    essential: 105000,
    discretionary: 20000,
    savings: 1800000,
    emergency: 650000,
    basic: 80000,
    epf: 1400000,
    ppf: 500000,
    nps: 300000,
    statutoryGoal: 'retirement',
    regularCorpus: 600000,
    unrealisedGains: 125000,
    term: 25000000,
    health: 1000000,
    topup: 1500000,
    loans: [
      { ...loan('car', 'Car loan', 472300, 0.09, 36, 14500), offset: true, autopay: true, cardSpend: 35000, floatDays: 35 }
    ],
    goals: [
      goal('buffer', '6-month family buffer', 650000, 1, 'Need', 'emergency', true),
      goal('home', 'Home down payment', 3500000, 4, 'Want', 'home'),
      goal('child', 'Child higher education', 4500000, 15, 'Need', 'education'),
      goal('retirement', 'Retirement corpus', 60000000, 26, 'Want', 'retirement')
    ],
    note: 'Dual-income household balancing a near-term home purchase, child education, and retirement. Activating the Zero-Sacrifice Efficiency Levers bridges the shortfall without cutting lifestyle.'
  },
  {
    ...base,
    id: 'meera',
    name: 'Meera',
    label: 'Variable-income freelancer',
    age: 29,
    income: 130000,
    growth: 0.05,
    volatility: 0.35,
    stability: 'variable',
    essential: 45000,
    discretionary: 15000,
    savings: 600000,
    emergency: 400000,
    reserveMonths: 12,
    basic: 0,
    epf: 0,
    ppf: 350000,
    nps: 150000,
    statutoryGoal: 'retirement',
    term: 10000000,
    health: 1000000,
    topup: 1000000,
    regularCorpus: 150000,
    unrealisedGains: 30000,
    loans: [],
    goals: [
      goal('buffer', '12-month income buffer', 600000, 1, 'Need', 'emergency', true),
      goal('studio', 'Studio equipment upgrade', 400000, 2, 'Want', 'equipment'),
      goal('home', 'Solo apartment purchase', 2500000, 7, 'Want', 'home'),
      goal('retirement', 'Financial independence', 40000000, 22, 'Wish', 'retirement')
    ],
    note: 'Freelance creator with variable receipts. A 12-month liquid reserve combined with Sovereign Core + Coupon Sweep shields against income volatility.'
  },
  {
    ...base,
    id: 'vikram',
    name: 'Vikram',
    label: 'Debt-stressed mid-career',
    age: 39,
    income: 180000,
    growth: 0.05,
    essential: 85000,
    discretionary: 15000,
    savings: 500000,
    emergency: 250000,
    basic: 55000,
    epf: 1100000,
    ppf: 250000,
    nps: 200000,
    statutoryGoal: 'retirement',
    term: 15000000,
    health: 1000000,
    topup: 1000000,
    regularCorpus: 200000,
    unrealisedGains: 40000,
    loans: [
      { ...loan('homeLoan', 'Home loan', 4300000, 0.088, 190, 42000), offset: true, autopay: true, cardSpend: 25000, floatDays: 30 },
      { ...loan('personal', 'Personal loan', 650000, 0.145, 48, 19000), penalty: 0.02 }
    ],
    goals: [
      goal('closure', 'Eliminate personal loan', 0, 2, 'Need', 'debt', true),
      goal('medical', 'Parent medical corpus', 1000000, 3, 'Need', 'medical', true),
      goal('child', 'Daughter college', 3000000, 8, 'Need', 'education'),
      goal('retirement', 'Retirement catch-up', 45000000, 19, 'Need', 'retirement')
    ],
    note: 'Stressed by high-interest personal debt and mortgage payments. Intra-family rate swap on the personal loan + Velocity Offset saves substantial interest and accelerates debt freedom.'
  },
  {
    ...base,
    id: 'kavitha',
    name: 'Kavitha',
    label: 'Sandwich-generation planner',
    age: 46,
    income: 280000,
    growth: 0.04,
    essential: 135000,
    discretionary: 20000,
    savings: 6800000,
    emergency: 1500000,
    basic: 90000,
    epf: 3200000,
    ppf: 1200000,
    nps: 800000,
    statutoryGoal: 'retirement',
    term: 25000000,
    health: 1500000,
    topup: 2000000,
    regularCorpus: 1500000,
    unrealisedGains: 350000,
    loans: [
      loan('homeLoan', 'Remaining home loan', 1800000, 0.085, 48)
    ],
    goals: [
      goal('medical', 'Elder healthcare buffer', 1500000, 1, 'Need', 'medical', true),
      goal('twin1', 'Twin college tuition · first', 2500000, 3, 'Need', 'education'),
      goal('twin2', 'Twin college tuition · second', 2500000, 5, 'Need', 'education'),
      goal('closure', 'Mortgage closure', 0, 4, 'Need', 'debt', true),
      goal('retirement', 'Retirement at age 58', 70000000, 12, 'Need', 'retirement', true)
    ],
    note: 'Peak earning years supporting aging parents and university-bound twins. Annual LTCG harvesting, Direct TER recapture, and Floor-Protected Gilts secure all commitments.'
  }
];

export const clone = x => JSON.parse(JSON.stringify(x));
export const loadPersona = id => clone(PERSONAS.find(p => p.id === id) || PERSONAS[1]);
