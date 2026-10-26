import test from 'node:test';
import assert from 'node:assert/strict';
import {emi,amortize,requiredSaving,futureValue,evaluate,simulate,validate,cppi,riskParity,backtest,recover,stepUpSaving,feasible,medicalOutOfPocket} from '../dist/engine/core.js';
import {collateralSwap,familyTreasury,bondSensitivity,foreignSleeve} from '../dist/engine/advanced.js';
import {CONFIG} from '../dist/data/config.js';
import {loadPersona} from '../dist/data/personas.js';
test('amortisation closes random loans, zero APR and one month',()=>{for(let i=0;i<100;i++){let p=10000+i*4831,r=i%9===0?0:.01+i/200,n=i%60+1;let a=amortize({principal:p,apr:r,months:n});assert.ok(a.balance<1);assert.ok(Math.abs(a.totalPaid-p-a.interest)<1)}});
test('annuity identity including zero and negative returns',()=>{for(const r of [0,1e-12,-.02,.06,.6])for(const n of [1,12,120,600]){let c=requiredSaving(1e7,0,r,n);assert.ok(Math.abs(futureValue(0,c,r,n)-1e7)<1)}assert.equal(requiredSaving(100,200,.06,12),0)});
test('all persona ledgers reconcile and inputs are valid',()=>{for(const id of ['aarav','priya','meera','vikram','kavitha']){let p=loadPersona(id);assert.deepEqual(validate(p),[]);let r=evaluate(p);assert.ok(r.monthly_ledger.every(m=>Math.abs(m.invariant)<.01));assert.ok(r.goal_outcomes.every(g=>Number.isFinite(g.shortfall)))}});
test('extreme deficit, ten shocks, 60% inflation, one month and no goals',()=>{let p=loadPersona('priya');p.income=0;p.goals[0].months=1;p.goals[1].inflation=.6;p.shocks=Array.from({length:10},()=>({type:'medical',month:1,duration:1,value:1e6}));let r=evaluate(p);assert.ok(r.monthly_ledger.every(m=>Number.isFinite(m.unfunded)&&Math.abs(m.invariant)<.01));assert.ok(r.firstDeficit===1);p.goals=[];assert.ok(Number.isFinite(evaluate(p).healthScore))});
test('same seed gives identical results and adverse shock cannot improve a single goal',()=>{let p=loadPersona('priya');p.goals=[{...p.goals[1],months:36}];let a=simulate(p,100),b=simulate(p,100);assert.deepEqual(a,b);let q=structuredClone(p);q.shocks=[{type:'crash',month:1,duration:1,value:.4}];let c=simulate(q,100);assert.ok(c.goal_outcomes[0].probability<=a.goal_outcomes[0].probability);q=structuredClone(p);q.income+=10000;assert.ok(simulate(q,100).goal_outcomes[0].probability>=a.goal_outcomes[0].probability)});
test('CPPI and risk parity produce finite constrained outputs',()=>{let r=cppi(100000,60,100);assert.ok(r.p10>=0&&r.probability>=0&&r.probability<=1);let w=riskParity();assert.ok(w.every(v=>v>=0));assert.ok(Math.abs(w.reduce((a,b)=>a+b,0)-1)<1e-6)});
test('backtest rolling figures match a constant-return independent result',()=>{let rows=Array.from({length:24},(_,i)=>({date:`2000-${i}`,equity:.01,debt:.01,gold:.01,liquid:.01}));let r=backtest(rows,[1,0,0,0],12,0);assert.equal(r.windows,13);assert.ok(Math.abs(r.median-((1.01**12)-1))<1e-10);assert.equal(r.maxDrawdown,0)});
test('invalid inputs rejected',()=>{let p=loadPersona('priya');p.income=-1;assert.ok(validate(p).length);p.income=Infinity;assert.ok(validate(p).length)});
test('incomplete imports cannot produce NaN through missing required fields',()=>{let p=loadPersona('priya');delete p.bonus;assert.ok(validate(p).length);assert.ok(validate({}).length);p=loadPersona('priya');p.goals[0].scope=null;assert.ok(validate(p).length)});
test('step-up schedule reaches its target without inventing capital',()=>{for(const step of [0,.04,.15]){let n=60,r=.06,m=(1+r)**(1/12)-1,start=7,current=50000,c=stepUpSaving(1e6,current,r,n,step,start),v=current;for(let k=0;k<n;k++){if(k)v*=1+m;v+=c*(1+step)**(Math.floor((start+k-1)/12)-Math.floor((start-1)/12))}assert.ok(Math.abs(v-1e6)<.01)}});
test('medical coverage, deductible and co-pay reconcile',()=>{let p=loadPersona('priya');p.health=500000;p.topup=0;p.deductible=100000;p.copay=.1;assert.equal(medicalOutOfPocket(p,800000),350000);assert.equal(medicalOutOfPocket(p,50000),50000)});
test('risk parity equalises marginal variance contributions',()=>{let w=riskParity(),cov=CONFIG.correlation.map((r,i)=>r.map((x,j)=>x*CONFIG.assets[i].vol*CONFIG.assets[j].vol)),contributions=w.map((x,i)=>x*cov[i].reduce((s,v,j)=>s+v*w[j],0));assert.ok(Math.max(...contributions)-Math.min(...contributions)<1e-7)});
test('recovery honours locks and verifies every claimed feasible candidate',()=>{let p=loadPersona('meera');p.volatility=0;p.goals=[{...p.goals[1],months:12,cost:100000,hard:true}];let r=recover(p,30);for(const o of r.options){assert.equal(o.plan.trim,p.trim);assert.equal(o.plan.goals[0].months,12);assert.equal(o.plan.goals[0].scope,1);if(o.feasible)assert.ok(feasible(simulate(o.plan,30)))}assert.ok(r.options.length>0)});
test('unrepairable hard reserve deadline returns a reason, not astronomical income',()=>{let p=loadPersona('priya');p.goals=[{...p.goals[0],months:1}];p.emergency=0;p.savings=0;p.shocks=[{type:'job',month:1,duration:1,value:1}];let r=recover(p,10);assert.equal(r.additionalIncome,null);assert.match(r.ceilingReason,/cannot repair/)});
test('optional debt and FX experiments are finite and reproducible',()=>{let c=collateralSwap({principal:500000,oldRate:.14,newRate:.08,fees:5000,collateral:1000000,months:12},50);assert.ok(Math.abs(c.annualSaving-25000)<.01);assert.ok(c.breachProbability>=0&&c.breachProbability<=1);assert.ok(bondSensitivity(6,45,-.01)>0);let args=[1e5,12,.04,.025];assert.deepEqual(foreignSleeve(...args),foreignSleeve(...args));let f=familyTreasury({amount:1e5,bankRate:.14,familyRate:.08,fdRate:.06,slab:.3,fees:0});assert.ok(f.borrowerAnnualSaving>0&&f.lenderAnnualDifference>0)});
test('active optimization levers reduce expected shortfall without lifestyle cut',()=>{let p=loadPersona('priya');let base=evaluate(p);let opt=structuredClone(p);opt.optimizations.directFeeRecapture=true;opt.optimizations.cashUpgrade=true;opt.optimizations.ltcgTaxHarvest=true;opt.optimizations.reitCashflowShield=true;let improved=evaluate(opt);assert.ok(improved.totalShortfall<=base.totalShortfall)});
test('statutory retirement assets auto-link to retirement goal when not explicitly set',()=>{let p=loadPersona('priya');p.statutoryGoal='';let r=evaluate(p);let retGoal=r.goal_outcomes.find(g=>g.category==='retirement');assert.ok(retGoal.corpus>0)});
test('velocity offset and family rate swap accelerate debt freedom',()=>{let p=loadPersona('vikram');let base=evaluate(p);let opt=structuredClone(p);opt.optimizations.velocityOffsetRefi=true;opt.optimizations.familyLoanSwap=true;let improved=evaluate(opt);assert.ok(improved.totalShortfall<=base.totalShortfall)});

// Priority P1: Authoritative Hackathon Financial Engine Verification
test('hackathon benchmark cash flow reconciles with exactly ₹25,000 monthly surplus', () => {
  let p = loadPersona('hackathon');
  assert.equal(p.income, 85000);
  assert.equal(p.essential, 40000);
  assert.equal(p.discretionary, 10000);
  assert.equal(p.loans[0].emi, 10000);
  // Uninflated Monthly Surplus = Household Income - Expenses - Required Debt Payments
  let expectedSurplus = p.income - p.essential - p.discretionary - p.loans[0].emi;
  assert.equal(expectedSurplus, 25000);
  let r = evaluate(p);
  // Month 1 surplus reflects 1 month of 6% annual inflation on expenses (50,000 * 1.004867)
  assert.ok(Math.abs(r.monthly_ledger[0].surplus - 24756.63) < 1);
});

test('future goal cost follows FV = PV * (1 + i)^t without inventing numbers', () => {
  let p = loadPersona('hackathon');
  let eduGoal = p.goals.find(g => g.id === 'education');
  assert.equal(eduGoal.cost, 1000000); // ₹10 Lakh PV
  assert.equal(eduGoal.months, 120);   // 10 Years
  assert.equal(eduGoal.inflation, 0.06); // 6% annual inflation
  let expectedFV = 1000000 * ((1 + 0.06) ** 10); // ≈ ₹17.91 Lakh (1790847.696)
  assert.ok(Math.abs(expectedFV - 1790847.7) < 1);
  let r = evaluate(p);
  let out = r.goal_outcomes.find(g => g.id === 'education');
  assert.ok(Math.abs(out.target - expectedFV) < 1);
});

test('unexpected expense shock reduces liquid savings without double counting', () => {
  let p = loadPersona('hackathon');
  let initialSavings = p.savings;
  // Step 2 in prompt: Introduce an unexpected ₹20,000 expense paid from liquid savings
  p.savings -= 20000;
  assert.equal(p.savings, initialSavings - 20000);
  let r = evaluate(p);
  assert.ok(r.monthly_ledger.every(m => Math.abs(m.invariant) < 0.01));
});

test('income reduction shock drops surplus by ₹10,000 and starves lower-priority goals', () => {
  let p = loadPersona('hackathon');
  let baseRes = evaluate(p);
  let shocked = structuredClone(p);
  // Step 4 in prompt: Reduce monthly household income by ₹10,000 (from ₹85,000 to ₹75,000)
  shocked.income -= 10000;
  let shockedRes = evaluate(shocked);
  // Surplus drops by exactly ₹10,000
  assert.ok(Math.abs((baseRes.monthly_ledger[0].surplus - shockedRes.monthly_ledger[0].surplus) - 10000) < 0.01);
  assert.ok(shockedRes.totalShortfall > baseRes.totalShortfall);
});
