import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

test('server hashes passwords with scrypt and compares hashes timing-safely', () => {
  assert.match(server, /scryptSync/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /passwordScheme: 'scrypt'/);
});

test('server no longer seeds or accepts the public demo credentials', () => {
  assert.doesNotMatch(server, /password:\s*'goalpulse2026'/);
  assert.doesNotMatch(server, /familyId === 'FAM-2026'/);
  assert.match(server, /Remove the old public demo account/);
});

test('server-side plan save requires a session token and matches the vault identity', () => {
  assert.match(server, /req\.headers\.authorization/);
  assert.match(server, /You can only save to your own Family Vault/);
  assert.match(server, /Your session expired/);
});

test('client sends bearer token for server-backed plan persistence', () => {
  assert.match(app, /Authorization:\s*`Bearer \$\{(?:session|identity)\.token\}`/);
  assert.match(app, /token: data\.token/);
});
