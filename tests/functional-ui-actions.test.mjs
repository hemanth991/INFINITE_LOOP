import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

test('profile exposes tangible gold, jewellery, silver and land inputs with user-entered price assumptions', () => {
  for (const field of ['assets.goldGrams', 'assets.goldPricePerGram', 'assets.jewelleryGrams', 'assets.jewelleryPricePerGram', 'assets.silverGrams', 'assets.silverPricePerGram', 'assets.landValue']) assert.ok(app.includes(field), `missing ${field}`);
  assert.match(app, /not live market quotes/);
  assert.match(app, /not treated as liquid savings/);
});

test('loan removal, goal removal, snapshot load and snapshot delete have click handlers', () => {
  for (const selector of ['[data-remove-loan]', '[data-remove-goal]', '[data-load-snapshot]', '[data-delete-snapshot]']) assert.ok(app.includes(`document.querySelectorAll('${selector}')`), `missing handler ${selector}`);
  assert.match(app, /plan\.loans\.splice\(index, 1\)/);
  assert.match(app, /snapshots\.splice\(index, 1\)/);
  assert.match(app, /plan = clone\(snapshot\.plan\)/);
});

test('monthly execution view explicitly says the app does not execute transfers or debits', () => {
  assert.match(app, /does not initiate transfers, SIPs, or loan auto-debits/);
  assert.match(app, /No transactions are executed by this app/);
  assert.doesNotMatch(app, /Automated Monthly Standing Instruction Sheet/);
});

test('identical snapshot copies are explicitly labelled instead of silently blocking the add action', () => {
  assert.match(app, /const isDuplicate = snapshots\.some/);
  assert.match(app, /Identical copy/);
});

test('new users do not silently inherit the hackathon benchmark as their live plan', () => {
  assert.match(app, /function createEmptyHouseholdPlan\(\)/);
  assert.match(app, /: createEmptyHouseholdPlan\(\)/);
  assert.match(app, /p\.income = 0/);
  assert.match(app, /p\.loans = \[\]/);
});

test('adding a goal on the goals page edits the draft and does not apply invented costs', () => {
  assert.match(app, /route === 'goals' \? \(goalDraft \|\| \(goalDraft = clone\(plan\.goals\)\)\) : plan\.goals/);
  assert.match(app, /cost: 0/);
  assert.match(app, /Blank goal added to the draft/);
});

test('known benchmark household and snapshots are excluded from user plan initialization', () => {
  assert.match(app, /function isBenchmarkPlan\(candidate\)/);
  assert.match(app, /!isBenchmarkPlan\(persisted\.plan\)/);
  assert.match(app, /filter\(snapshot => !isBenchmarkPlan\(snapshot\?\.plan\)\)/);
});

test('empty first-run plan is explicitly identified rather than presented as a personalized forecast', () => {
  assert.match(app, /Set up your household to see personalized calculations/);
  assert.match(app, /These zero values are an empty starting point, not a forecast/);
});

test('goal removal is a draft action and the user can remove all goals', () => {
  assert.match(app, /goalDraft\.splice\(index, 1\)/);
  assert.doesNotMatch(app, /goalDraft\.length <= 1/);
});
