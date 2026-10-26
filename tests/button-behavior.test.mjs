import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

test('Explain My Plan buttons have an explicit click action and prevent accidental submit/bubbling', () => {
  assert.match(app, /document\.querySelectorAll\('\[data-act="explain"\]'\)\.forEach\(el => \{[\s\S]*?el\.onclick = event => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?openAIDrawer\(\);/);
});

test('Lock switches stop click propagation and update only through the field-change path', () => {
  assert.match(app, /el\.dataset\.field === 'locks\.lifestyle' \|\| el\.dataset\.field === 'locks\.dates'[\s\S]*?el\.addEventListener\('click', event => event\.stopPropagation\(\)\)/);
  assert.match(app, /setValue\(path, value\);[\s\S]*?persist\(\);[\s\S]*?changed\(\);/);
});

test('Action buttons are explicitly non-submit buttons before dispatch', () => {
  assert.match(app, /document\.querySelectorAll\('\[data-act\]:not\(\[data-act="explain"\]\)'\)\.forEach\(el => \{\s*el\.type = 'button';\s*el\.onclick = event => \{ event\.preventDefault\(\); handleAction\(el\.dataset\.act\); \};/);
});
