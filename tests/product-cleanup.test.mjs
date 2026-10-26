import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
test('login UI no longer exposes judge quick-fill demo controls', () => {
  assert.equal(app.includes('Judge Quick-Fill Demo Account'), false);
  assert.equal(app.includes("$('#btn-quick-fill-judge')"), false);
});
test('navigation presents methodology in customer-facing language', () => {
  assert.equal(app.includes("['method', '10 Methodology & Assumptions']"), true);
  assert.equal(app.includes("heading('12 CFP BENCHMARK & AUDIT MATRIX'"), false);
});
