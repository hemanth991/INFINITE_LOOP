import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const backend = await readFile(new URL('../backend/main.py', import.meta.url), 'utf8');

test('household-specific local plan is preferred over another household global plan', () => {
  assert.match(app, /const sessionPlan = session\?\.familyId[\s\S]*goalpulse_family_\$\{session\.familyId\}/);
  assert.match(app, /!session && persisted\?\.plan/);
});

test('login failure cannot authenticate using a device-only local vault', () => {
  assert.match(app, /Never treat a device-only plan as proof of identity/);
  assert.doesNotMatch(app, /const localVault = JSON\.parse\(localStorage\.getItem\(`goalpulse_family_\$\{familyId\}`/);
});

test('registration failure cannot create a fake local session', () => {
  assert.match(app, /Registration was not completed on the server/);
  assert.doesNotMatch(app, /session = \{familyId: regWizard\.step1\.familyId, familyName: regWizard\.step1\.familyName\}/);
});

test('new registration does not prefill a known demo password or household name', () => {
  assert.doesNotMatch(app, /regWizard\.step1\.password \|\| 'goalpulse2026'/);
  assert.doesNotMatch(app, /regWizard\.step1\.familyName \|\| 'Sharma Household'/);
  assert.match(app, /p1Fixed: 0,[\s\S]*p1Variable: 0/);
});

test('new plan clears sample investment balances and requires entered goal amounts', () => {
  assert.match(app, /for \(const key of \['epf', 'ppf', 'nps', 'regularCorpus', 'unrealisedGains', 'familyPool', 'ufpi', 'bonus', 'basic', 'extraIncome'\]\) newPlan\[key\] = 0/);
  assert.match(app, /newPlan\.goals\.some\(g => !Number\.isFinite\(g\.cost\) \|\| g\.cost <= 0/);
});

test('Python backend requires bearer authentication for saving and verifies family ownership', () => {
  assert.match(backend, /authenticated_family = current_family\(authorization\)/);
  assert.match(backend, /payload\.familyId != authenticated_family/);
});
