import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

test('profile/registration essential expense total is not overwritten by legacy demo expense rows', () => {
  assert.match(app, /function changed\(\) \{[\s\S]*?\/\/ `essential` is the authoritative monthly total/);
  assert.doesNotMatch(app, /function changed\(\) \{\s*if \(plan\.expenses\.length\) plan\.essential = sum\(plan\.expenses\.map\(e => e\.amount\)\);/);
});

test('goal draft is validated before calculation and before applying', () => {
  assert.match(app, /const draftPlan = \{ \.\.\.plan, goals: clone\(goalDraft\) \};\s*const errors = validate\(draftPlan\);/);
  assert.match(app, /const candidate = \{ \.\.\.plan, goals: clone\(goalDraft\) \};\s*const errors = validate\(candidate\);/);
});

test('what-if alternative A extends the configured retirement horizon instead of forcing a demo deadline', () => {
  assert.match(app, /ret\.months = Math\.min\(600, ret\.months \+ 36\)/);
  assert.doesNotMatch(app, /if \(ret\) ret\.months = 276/);
});

test('equal priority message does not claim equal funding', () => {
  assert.match(app, /equal priority does not guarantee equal funding/);
});

test('rendered controls default to non-submit buttons unless explicitly submit', async () => {
  const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(source, /querySelectorAll\('button:not\(\[type\]\)'\)\.forEach\(button => \{ button\.type = 'button'; \}\)/);
});

test('action controls avoid duplicate explain and shock click bindings', async () => {
  const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes("document.querySelectorAll('[data-act]:not([data-act=\"explain\"])')"));
  assert.doesNotMatch(source, /document\.querySelectorAll\('\[data-shock\]'\)\.forEach\(el => \(el\.onclick =/);
});
