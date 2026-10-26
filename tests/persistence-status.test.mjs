import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
test('persist reports local and server save status instead of swallowing server failures', () => {
  assert.match(app, /async function persist\(\)[\s\S]*return \{localSaved, serverSaved, hasSession: Boolean\(identity\?\.familyId\)\}/);
  assert.match(app, /serverSaved = response\.ok && data\.ok === true/);
});
test('vault save message does not claim server sync without confirmation', () => {
  assert.match(app, /if \(status\.serverSaved\) toast\('Plan changes saved to your Family Vault\.'/);
  assert.match(app, /server sync was not confirmed/);
});
