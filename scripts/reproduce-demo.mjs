// Synthetic numerical evidence. No account, credentials, or network required.
import {loadPersona} from '../dist/data/personas.js';
import {simulate, emi} from '../dist/engine/core.js';

const plan = loadPersona('priya');
Object.assign(plan, {
  name: 'Synthetic submission example', income: 100000, extraIncome: 0,
  essential: 40000, discretionary: 10000, savings: 500000,
  emergency: 200000, bonus: 0, shocks: [],
  loans: [{id:'demo-loan', name:'Example loan', principal:300000, apr:.12,
    months:36, emi:emi(300000,.12,36), floating:false, extraMonthly:0}]
});
plan.goals = plan.goals.filter(g => ['education','retirement'].includes(g.category))
  .map(g => ({...g, cost:g.category==='education'?1000000:5000000,
    months:g.category==='education'?120:240, earmarked:0}));

const summarize = r => ({
  firstMonthSurplus: Math.round(r.monthly_ledger[0].surplus * 100) / 100,
  firstCashDeficitMonth: r.firstDeficit,
  cumulativeUnfunded: Math.round(r.unfunded * 100) / 100,
  maxAccountingResidual: Math.max(...r.monthly_ledger.map(m => Math.abs(m.invariant))),
  goals: r.goal_outcomes.map(g => ({name:g.name, successProbability:g.probability}))
});
const baseline = summarize(simulate(plan));
const interrupted = structuredClone(plan);
interrupted.shocks = [{type:'job',month:3,duration:6,value:1}];
const incomeInterruption = summarize(simulate(interrupted));
console.log(JSON.stringify({
  notice:'Synthetic scenario; other bundled Priya assumptions are inherited. Probabilities are model estimates, not guarantees.',
  baseline, incomeInterruption
}, null, 2));
