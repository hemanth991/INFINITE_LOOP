import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

test('registration wizard uses explicit validation so Next does not silently fail native form validation', () => {
  assert.match(app, /<form id="wizard-form" novalidate>/);
  assert.match(app, /const rejectStep = \(message, selector\) =>/);
  assert.match(app, /Use a Family ID of 4–48 letters, numbers, underscores or hyphens\./);
  assert.match(app, /Choose a password with at least 8 characters\./);
  assert.match(app, /Income values must be zero or a positive monthly amount\./);
});

test('registration wizard validates expenses before advancing and preserves step values', () => {
  assert.match(app, /const expenseFields = \['#reg-essential', '#reg-disc', '#reg-emi', '#reg-savings', '#reg-emergency', '#reg-insurance'\]/);
  assert.match(app, /Expense, EMI, savings and reserve values must be zero or positive\./);
  assert.match(app, /registerStep\+\+;\s*render\(\);/);
});
