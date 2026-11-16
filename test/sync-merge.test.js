import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, String, JSON });
for (const f of ['vault-crypto.js', 'sync-merge.js']) {
  vm.runInContext(readFileSync(new URL(`../src/shared/${f}`, import.meta.url), 'utf8'), context);
}
const { PM } = context;
const plain = (x) => JSON.parse(JSON.stringify(x));
const cred = (id, site, username, password, updated) => ({ id, site, username, password, updated });

test('newer copy of a login wins, and logins only on one side are kept', () => {
  const a = { vault: [cred('1', 'x.com', 'me', 'old', 100), cred('2', 'a.com', 'me', 'pw', 100)], tombstones: [] };
  const b = { vault: [cred('1', 'x.com', 'me', 'new', 200), cred('3', 'b.com', 'me', 'pw', 100)], tombstones: [] };
  const merged = PM.mergePayloads(a, b, 1000);
  assert.deepEqual(plain(merged.vault).map((c) => [c.id, c.password]), [['1', 'new'], ['2', 'pw'], ['3', 'pw']]);
  assert.ok(PM.samePayload(merged, PM.mergePayloads(b, a, 1000)));
});

test('same login saved on two devices under different ids is not duplicated', () => {
  const a = { vault: [cred('1', 'x.com', 'Me', 'pw1', 100)] };
  const b = { vault: [cred('2', 'x.com', 'me', 'pw2', 300)] };
  assert.deepEqual(plain(PM.mergePayloads(a, b, 1000).vault).map((c) => c.password), ['pw2']);
});

test('a deletion removes the login on the other side, unless it was edited afterwards', () => {
  const deleted = { vault: [], tombstones: [{ id: '1', at: 500 }] };
  assert.equal(PM.mergePayloads(deleted, { vault: [cred('1', 'x.com', 'me', 'pw', 100)] }, 1000).vault.length, 0);
  assert.equal(PM.mergePayloads(deleted, { vault: [cred('1', 'x.com', 'me', 'pw', 900)] }, 1000).vault.length, 1);
});

test('login hash is stable for the same password and differs from the vault key', async () => {
  const kdf = { ...PM.newKdfParams(), iterations: 1000 };
  const key = await PM.deriveKey('master pw', kdf);
  const h1 = await PM.loginHash(key, 'master pw');
  assert.equal(h1, await PM.loginHash(await PM.deriveKey('master pw', kdf), 'master pw'));
  assert.notEqual(h1, await PM.loginHash(await PM.deriveKey('other pw', kdf), 'other pw'));
  const jwk = await PM.exportKey(key);
  assert.notEqual(h1.replace(/=+$/, ''), jwk.k);
});

test('cards merge by number, newest wins, and deletions sync', () => {
  const card = (id, number, expYear, updated) => ({ id, number, expMonth: '01', expYear, updated });
  const a = { cards: [card('a', '4242424242424242', '2027', 100)] };
  const b = { cards: [card('b', '4242424242424242', '2029', 200), card('c', '5555555555554444', '2030', 100)] };
  assert.deepEqual(plain(PM.mergePayloads(a, b, 1000).cards).map((c) => c.expYear), ['2029', '2030']);
  const gone = PM.mergePayloads({ cards: [], tombstones: [{ id: 'c', at: 500 }] }, b, 1000);
  assert.deepEqual(plain(gone.cards).map((c) => c.id), ['b']);
});

test('profiles sync by id', () => {
  const a = { profiles: [{ id: 'p1', address1: '1 Main', updated: 100 }] };
  const b = { profiles: [{ id: 'p1', address1: '2 Main', updated: 200 }, { id: 'p2', address1: '9 Elm', updated: 50 }] };
  assert.deepEqual(plain(PM.mergePayloads(a, b, 1000).profiles).map((p) => p.address1), ['2 Main', '9 Elm']);
});
