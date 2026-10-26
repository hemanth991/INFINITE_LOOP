import {writeFile} from 'node:fs/promises';

// Calibrated monthly returns for Indian Equity (Nifty 50 TRI proxy), Short/Medium Debt (CRISIL Bond proxy),
// Domestic Gold INR, Liquid (Overnight/MIBOR), USD/INR FX change, and US 3M Treasury Yield.
// 240 observations: 2006-01 to 2025-12 (20 full calendar years).

// Historical annual regimes:
// 2006: Strong bull run (Nifty ~+40%, Gilt ~+6%, Gold ~+30%, FX -2%)
// 2007: Climax bull run (Nifty ~+54%, Gilt ~+7%, Gold ~+16%, FX -9%)
// 2008: GFC crash (Nifty -52% peak-to-trough, Gilt +10% rally on rate cuts, Gold +29%, FX +22% rupee plunge)
// 2009: Historic V-recovery (Nifty +75%, Gilt +4%, Gold +24%, FX -4%)
// 2010: Continued expansion (Nifty +18%, Gilt +5%, Gold +22%, FX -3%)
// 2011: Inflation & Euro crisis (Nifty -24%, Gilt +7%, Gold +31%, FX +18%)
// 2012: Rebound (Nifty +27%, Gilt +9%, Gold +12%, FX +3%)
// 2013: Taper Tantrum (Nifty +7%, Gilt +3%, Gold -4%, FX +13% May-Aug shock)
// 2014: Macro turnaround (Nifty +31%, Gilt +14%, Gold -2%, FX +2%)
// 2015: Global commodity slump (Nifty -4%, Gilt +8%, Gold -6%, FX +5%)
// 2016: Demonetisation & recovery (Nifty +3%, Gilt +13%, Gold +11%, FX +3%)
// 2017: Broad-based liquidity rally (Nifty +29%, Gilt +5%, Gold +5%, FX -6%)
// 2018: IL&FS NBFC crisis (Nifty +3%, Gilt +6%, Gold +8%, FX +9%)
// 2019: Corporate tax cut rally (Nifty +12%, Gilt +10%, Gold +24%, FX +2%)
// 2020: COVID crash & V-shape (Feb-Mar -34%, Apr-Dec surge -> net +15%, Gilt +12%, Gold +28%, FX +2%)
// 2021: Post-COVID liquidity boom (Nifty +24%, Gilt +3%, Gold -4%, FX +2%)
// 2022: Global rate hike cycle (Nifty +4%, Gilt +2.5%, Gold +14%, FX +11% USD surge)
// 2023: Indian Capex / retail bull run (Nifty +20%, Gilt +7.2%, Gold +13%, FX +1%)
// 2024: Peak earnings rally (Nifty +18%, Gilt +7.5%, Gold +21%, FX +2.5%)
// 2025: Institutional consolidation (Nifty +11%, Gilt +7.0%, Gold +12%, FX +2.0%)

function seedRandom(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const prng = seedRandom(20261025);
const gaussian = () => {
  let u = 0, v = 0;
  while(u === 0) u = prng();
  while(v === 0) v = prng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

const rows = [];

// Monthly profiles per year [targetEquityAnnual, targetDebtAnnual, targetGoldAnnual, targetLiquidAnnual, targetFXAnnual, avgUsdYield]
const yearProfiles = {
  2006: [0.398, 0.062, 0.295, 0.058, -0.021, 0.048],
  2007: [0.548, 0.071, 0.165, 0.068, -0.088, 0.045],
  2008: [-0.518, 0.105, 0.292, 0.078, 0.224, 0.015],
  2009: [0.757, 0.042, 0.238, 0.042, -0.042, 0.003],
  2010: [0.179, 0.055, 0.218, 0.052, -0.034, 0.002],
  2011: [-0.246, 0.074, 0.312, 0.075, 0.182, 0.001],
  2012: [0.277, 0.092, 0.124, 0.081, 0.032, 0.001],
  2013: [0.068, 0.035, -0.045, 0.085, 0.128, 0.001],
  2014: [0.314, 0.142, -0.022, 0.082, 0.021, 0.001],
  2015: [-0.041, 0.084, -0.062, 0.074, 0.048, 0.002],
  2016: [0.030, 0.128, 0.114, 0.068, 0.026, 0.004],
  2017: [0.286, 0.052, 0.051, 0.062, -0.064, 0.010],
  2018: [0.032, 0.061, 0.079, 0.065, 0.092, 0.020],
  2019: [0.120, 0.098, 0.238, 0.058, 0.022, 0.021],
  2020: [0.149, 0.118, 0.278, 0.041, 0.024, 0.005],
  2021: [0.241, 0.032, -0.042, 0.036, 0.018, 0.001],
  2022: [0.043, 0.026, 0.138, 0.050, 0.108, 0.028],
  2023: [0.200, 0.072, 0.132, 0.066, 0.012, 0.051],
  2024: [0.182, 0.075, 0.212, 0.067, 0.026, 0.048],
  2025: [0.115, 0.070, 0.125, 0.065, 0.021, 0.042]
};

for (let y = 2006; y <= 2025; y++) {
  const [eqTarget, debtTarget, goldTarget, liqTarget, fxTarget, usdYield] = yearProfiles[y];
  
  // Base monthly drift
  const eqM = Math.pow(1 + eqTarget, 1/12) - 1;
  const dbM = Math.pow(1 + debtTarget, 1/12) - 1;
  const gdM = Math.pow(1 + goldTarget, 1/12) - 1;
  const lqM = Math.pow(1 + liqTarget, 1/12) - 1;
  const fxM = Math.pow(1 + fxTarget, 1/12) - 1;

  for (let m = 1; m <= 12; m++) {
    const date = `${y}-${String(m).padStart(2, '0')}`;
    let z1 = gaussian(), z2 = gaussian(), z3 = gaussian(), z4 = gaussian();

    let equity = eqM + 0.045 * z1;
    let debt = dbM + 0.008 * (0.15 * z1 + 0.98 * z2);
    let gold = gdM + 0.035 * (-0.1 * z1 + 0.99 * z3);
    let liquid = Math.max(0.002, lqM + 0.0008 * z4);
    let fx = fxM + 0.012 * (-0.45 * z1 + 0.89 * z4);

    // Exact historical shock calibrations:
    if (y === 2008) {
      if (m === 1) { equity = -0.130; fx = 0.012; gold = 0.082; debt = 0.011; }
      if (m === 6) { equity = -0.098; fx = 0.042; gold = 0.025; debt = -0.005; }
      if (m === 9) { equity = -0.104; fx = 0.052; gold = 0.061; debt = 0.014; }
      if (m === 10) { equity = -0.264; fx = 0.068; gold = -0.012; debt = 0.035; } // Lehman apex
      if (m === 11) { equity = -0.045; fx = 0.045; gold = 0.048; debt = 0.028; }
      if (m === 12) { equity = 0.062; fx = -0.021; gold = 0.055; debt = 0.042; } // RBI massive rate cuts
    }
    if (y === 2009) {
      if (m === 5) { equity = 0.281; fx = -0.035; gold = -0.015; debt = 0.008; } // Election upper circuit
    }
    if (y === 2013) {
      if (m >= 5 && m <= 8) { fx = 0.035 + 0.01 * z4; debt = -0.015 + 0.005 * z2; } // Taper tantrum
    }
    if (y === 2020) {
      if (m === 2) { equity = -0.064; gold = 0.038; debt = 0.012; fx = 0.015; }
      if (m === 3) { equity = -0.232; gold = -0.015; debt = 0.005; fx = 0.028; } // COVID crash
      if (m === 4) { equity = 0.147; gold = 0.085; debt = 0.018; fx = -0.008; } // Swift recovery
      if (m === 11) { equity = 0.114; gold = -0.032; debt = 0.004; fx = -0.004; }
      if (m === 12) { equity = 0.078; gold = 0.035; debt = 0.006; fx = -0.006; }
    }
    if (y === 2022) {
      if (m <= 6) { debt = Math.min(debt, 0.001); equity = eqM - 0.015; } // Rate hikes
      if (m === 2 || m === 3) { gold = 0.045; fx = 0.018; } // War outbreak safe-haven
    }

    rows.push({
      date,
      equity: Number(equity.toFixed(6)),
      debt: Number(debt.toFixed(6)),
      gold: Number(gold.toFixed(6)),
      liquid: Number(liquid.toFixed(6)),
      fx: Number(fx.toFixed(6)),
      usdYield: Number(usdYield.toFixed(4))
    });
  }
}

const payload = {
  name: "Synthetic Regime-Calibrated Benchmark Dataset (2006–2025)",
  kind: "synthetic_calibrated_benchmark",
  source: "Synthetic regime-calibrated benchmark observations generated from assumed annual profiles and stochastic monthly variation; not verified historical market observations.",
  generated: "2026-10-25",
  range: ["2006-01", "2025-12"],
  rows
};

await writeFile('dist/data/illustrative-monthly.json', JSON.stringify(payload));
console.log(`Successfully generated ${rows.length} synthetic regime-calibrated monthly benchmark observations (2006-01 to 2025-12).`);
