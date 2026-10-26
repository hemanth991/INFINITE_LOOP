import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

test('UI does not claim fixed debt savings independent of loan inputs', () => {
  assert.equal(app.includes('Saves ₹4,07,520 in interest'), false);
  assert.equal(app.includes('compresses tenure by 84 months'), false);
});

test('UI does not claim all eight optimizations were applied by recovery action', () => {
  assert.equal(app.includes('All 8 zero-sacrifice efficiency optimizations applied'), false);
});

test('optimization UI does not promise principal protection or a fixed crisis cushion', () => {
  assert.equal(app.includes('0% Principal Loss Risk'), false);
  assert.equal(app.includes('+6.2% Crisis Cushion'), false);
  assert.equal(app.includes('55% Drawdown Shield'), false);
});


test('optimization cards label unmodelled strategies instead of claiming returns', () => {
  assert.equal(app.includes('+382 bps Net Yield'), false);
  assert.equal(app.includes('+130 bps Net CAGR'), false);
  assert.equal(app.includes('+8.5% Cash Relay'), false);
  assert.equal(app.includes('Annual ₹1.25L LTCG Harvest'), false);
  assert.equal(app.includes('Saves ₹11.9L'), false);
  assert.equal(app.includes('₹1.45 Cr by Month 240'), false);
});

test('customer-facing plan UI contains no hackathon demo banner', () => {
  assert.equal(app.includes('ILLUSTRATIVE DEMO WORKFLOW'), false);
  assert.equal(app.includes('Complete Hackathon Pipeline (F-02 Standard)'), false);
  assert.equal(app.includes('Load Hackathon Scenario (₹85k Inflow'), false);
});

test('header uses an icon-only brand mark rather than a text wordmark', () => {
  assert.match(app, /class=\"brand brand-mark sf-mark\" aria-label=\"Home\"/);
  assert.doesNotMatch(app, /class=\"brand\">Goal<span>Pulse/);
});

test('goal comparison uses engine required-saving outputs rather than target divided by months', async () => {
  const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(app, /Use the engine's required-saving calculation, not target ÷ months/);
  assert.match(app, /const prevReq = ag\.required \?\? 0/);
  assert.match(app, /const newReq = dg\.required \?\? 0/);
});

test('what-if alternatives derive their summaries from the current plan and engine', async () => {
  const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(app, /const alternativeA = clone\(plan\)/);
  assert.match(app, /const alternativeB = clone\(plan\)/);
  assert.match(app, /const resultA = safeEvaluate\(alternativeA\)/);
  assert.match(app, /const resultB = safeEvaluate\(alternativeB\)/);
  assert.doesNotMatch(app, /Required Contribution: <strong>Reduced by ₹3,800\/mo/);
  assert.doesNotMatch(app, /Monthly Surplus: <strong class="good">Recovers to ₹20,000\/mo/);
});
