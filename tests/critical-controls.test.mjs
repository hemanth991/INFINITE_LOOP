import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

test('critical control routing intercepts lock toggles before parent click handlers', () => {
  assert.match(app, /document\.addEventListener\('click', event => \{/);
  assert.match(app, /input\[data-field="locks\.lifestyle"\], input\[data-field="locks\.dates"\]/);
  assert.match(app, /if \(directLock \|\| labelForLock\) \{\s*\/\/ Let the checkbox's native default action/);
  assert.match(app, /if \(!window\.__goalPulseCriticalControlsBound\)/);
});

test('Explain My Plan is routed directly to the AI drawer from capture phase', () => {
  assert.match(app, /target\.closest\('#open-ai-copilot, \[data-act="explain"\]'\)/);
  assert.match(app, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*openAIDrawer\(\);/);
});
