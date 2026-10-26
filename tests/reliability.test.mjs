import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, validate, amortize, debtAnalysis, netMeans, simulate} from '../dist/engine/core.js';
import {capitalSummary, fitEarmarks, compactSnapshotResult} from '../dist/engine/planning.js';
import {loadPersona} from '../dist/data/personas.js';

test('earmarks fit the exact available budget without mutating the source', () => {
  const p = loadPersona('priya'); p.savings = 1000.03; p.emergency = 500;
  p.goals = p.goals.slice(1, 4).map((g,i)=>({...g, earmarked: (i+1)*200}));
  const original = structuredClone(p);
  const fitted = fitEarmarks(p);
  assert.equal(Math.round(fitted.reduce((n,g)=>n+g.earmarked,0)*100),50003);
  assert.deepEqual(p,original);
  assert.equal(capitalSummary(p,fitted).excess,0);
  assert.deepEqual(validate({...p,goals:fitted}),[]);
});

test('recurring debt prepayment matches independent amortization and actual cash flow', () => {
  const p = loadPersona('priya'); p.bonus=0; p.loans=[{...p.loans[0],extraMonthly:5000}];
  const r=evaluate(p), loan=p.loans[0];
  const expected=amortize(loan);
  assert.ok(Math.abs(r.monthly_ledger[0].emi-(loan.emi+5000))<.01);
  assert.ok(Math.abs(r.monthly_ledger[0].debt-expected.rows[0].balance)<.01);
  assert.equal(r.monthly_ledger.findIndex(m=>m.debt<.001)+1,expected.months);
  assert.equal(debtAnalysis(p,loan,5000).optimized.months,expected.months);
  assert.ok(r.monthly_ledger.every(m=>Math.abs(m.invariant)<.01));
});

test('unaffordable extra principal cannot deplete the reserve', () => {
  const p=loadPersona('priya');p.income=0;p.bonus=0;p.loans[0].extraMonthly=1e9;
  const withExtra=evaluate(p);p.loans[0].extraMonthly=0;const base=evaluate(p);
  assert.equal(withExtra.monthly_ledger[0].reserveDraw,base.monthly_ledger[0].reserveDraw);
  assert.equal(withExtra.monthly_ledger[0].debt,base.monthly_ledger[0].debt);
});

test('unsupported strategy flags cannot fabricate income, reduce inflation or refinance loans', () => {
  const p=loadPersona('vikram');const base=evaluate(p);
  for(const key of ['reitCashflowShield','ltcgTaxHarvest','familyLoanSwap','globalSovereignSleeve','velocityOffsetRefi','sovereignCouponCore']) p.optimizations[key]=true;
  assert.deepEqual(evaluate(p),{...base,inputs:p});
});

test('supported toggle overrides inherited legacy flags', () => {
  const p=loadPersona('priya');p.opt.direct=true;p.optimizations.directFeeRecapture=false;
  const regular=netMeans(p)[0];p.optimizations.directFeeRecapture=true;
  assert.ok(netMeans(p)[0]>regular);
  p.optimizations.cashUpgrade=false; const before=evaluate(p).monthly_ledger[0].reserve;
  p.optimizations.cashUpgrade=true;assert.ok(evaluate(p).monthly_ledger[0].reserve>=before);
});

test('profile expense total remains authoritative and bonus appears in the specified month', () => {
  const p=loadPersona('priya');p.essential=12345;p.expenses=[{amount:999999,inflation:.1}];p.bonusMonth=11;p.bonus=50000;
  const r=evaluate(p); assert.ok(r.monthly_ledger[0].essential<13000);
  assert.equal(r.monthly_ledger[0].income,p.income+p.bonus);
  assert.equal(r.monthly_ledger[1].income,p.income);
});

test('malformed imports and nonfinite loan and shock values return validation errors', () => {
  for(const mutate of [p=>p.goals=[null],p=>p.goals[0].name=7,p=>p.loans[0].emi=NaN,p=>p.loans[0].months=1.5,p=>p.shocks=[{type:'job',value:1,month:NaN,duration:1}]]) {
    const p=loadPersona('priya');mutate(p);assert.ok(validate(p).length);
  }
  assert.throws(()=>simulate(loadPersona('priya'),0),/paths/);
});

test('refinancing compares the actual payoff horizon and multiplier counts every extra payment', () => {
  const p=loadPersona('priya');const l={...p.loans[0],principal:500000,apr:.088,months:180,emi:10000};
  const a=debtAnalysis(p,l,5000,.085,5000);
  assert.equal(a.baseline.months,63);
  assert.equal(a.refi.months,a.baseline.months);
  assert.ok(a.pv<10000);
  assert.ok(a.extraPaid>150000);
  assert.ok(Math.abs(a.multiplier-a.interestSaved/a.extraPaid)<1e-10);
});

test('an inflation-indexed emergency goal refills to the indexed target', () => {
  const p=loadPersona('priya');p.goals=[{...p.goals[0],cost:650000,months:12,inflation:.10}];
  const r=evaluate(p);assert.ok(r.goal_outcomes[0].shortfall<1);
});

test('snapshot compaction preserves comparison values while keeping three long plans below the API limit', () => {
  const result = {totalShortfall:123,healthScore:72,paths:1000,monthly_ledger:Array.from({length:600},()=>({contributions:Array(30).fill(1000)})),goal_outcomes:Array.from({length:30},(_,i)=>({id:'g'+i,probability:.8,shortfall:123,target:10000,months:600,series:Array(600).fill(1),bands:Array.from({length:600},()=>({p10:12345.12345,p50:123456.12345,p90:1234567.12345}))}))};
  const compact=compactSnapshotResult(result);
  assert.equal(compact.goal_outcomes[5].probability,.8);
  assert.equal(compact.totalShortfall,result.totalShortfall);
  assert.ok(JSON.stringify([compact,compact,compact]).length<50000);
  assert.ok(JSON.stringify(result).length>1000000);
  assert.equal(result.goal_outcomes[0].bands.length,600);
});
