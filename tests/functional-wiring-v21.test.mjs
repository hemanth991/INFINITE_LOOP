import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const generator = await readFile(new URL('../generate-data.mjs', import.meta.url), 'utf8');

test('AI drawer deterministic memo is defined and uses current plan/result values', () => {
  assert.match(app, /function generateDeterministicAdvisoryMemo\(plan, result\)/);
  assert.match(app, /result\?\.monthly_ledger\?\.\[0\]/);
  assert.match(app, /result\?\.healthScore/);
  assert.match(app, /result\?\.totalShortfall/);
  assert.match(app, /result\?\.goal_outcomes/);
});

test('goal infographic uses indexed engine contributions and required saving', () => {
  assert.match(app, /goals\.map\(\(g, i\) =>/);
  assert.match(app, /Math\.round\(g\.required \?\? \(remainingToFund \/ Math\.max\(1, months\)\)\)/);
  assert.match(app, /m1\.contributions\?\.\[i\]/);
});

test('secondary market sync, shock removal and ledger pagination are wired', () => {
  assert.match(app, /#btn-sync-market-2.*addEventListener\('click', syncLiveMarket\)/s);
  assert.match(app, /querySelectorAll\('\[data-remove-shock\]'\)/);
  assert.match(app, /plan\.shocks\.splice\(index, 1\)/);
  assert.match(app, /querySelectorAll\('\[data-ledger\]'\)/);
  assert.match(app, /ledgerPage = Math\.max\(0, ledgerPage \+ Number\(btn\.dataset\.ledger\)\)/);
});

test('Alternative B applies the same discretionary reduction shown in the preview', () => {
  assert.match(app, /plan\.discretionary = Math\.max\(0, \(Number\(plan\.discretionary\) \|\| 0\) - 5000\)/);
});

test('recovery page renders waterfall, Pareto candidates and audit disclosure', () => {
  assert.match(app, /r\.steps \|\| \[\]/);
  assert.match(app, /r\.options \|\| \[\]/);
  assert.match(app, /data-apply-option=/);
  assert.match(app, /r\.additionalIncome/);
  assert.match(app, /r\.ceilingReason/);
  assert.match(app, /r\.searched/);
  assert.match(app, /r\.verified/);
});

test('generated market metadata explicitly identifies synthetic calibrated data', () => {
  assert.match(generator, /Synthetic Regime-Calibrated Benchmark Dataset \(2006–2025\)/);
  assert.match(generator, /kind: "synthetic_calibrated_benchmark"/);
  assert.match(generator, /not verified historical market observations/);
});
