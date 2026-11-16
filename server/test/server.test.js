import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { openDb } from '../db.js';

let server, base;
before(async () => {
  server = createServer(openDb(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const kdf = { salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iterations: 600000 };
const authHash = 'a'.repeat(44);

test('register, login, and round-trip a vault', async () => {
  const reg = await call('POST', '/register', { username: 'Jack', authHash, kdf });
  assert.equal(reg.status, 201);

  assert.equal((await call('POST', '/register', { username: 'jack', authHash, kdf })).status, 409);
  assert.deepEqual((await call('POST', '/prelogin', { username: 'jack' })).body, { kdf });
  assert.equal((await call('POST', '/login', { username: 'jack', authHash: 'b'.repeat(44) })).status, 401);

  const { token } = (await call('POST', '/login', { username: 'jack', authHash })).body;
  assert.deepEqual((await call('GET', '/vault', null, token)).body, { revision: 0, data: null });

  const blob = { enc: 1, iv: 'x', data: 'y' };
  assert.deepEqual((await call('PUT', '/vault', { revision: 0, data: blob }, token)).body, { revision: 1 });
  assert.deepEqual((await call('GET', '/vault', null, token)).body, { revision: 1, data: blob });
});

test('stale upload is rejected with the current vault', async () => {
  const { token } = (await call('POST', '/register', { username: 'stale', authHash, kdf })).body;
  await call('PUT', '/vault', { revision: 0, data: { v: 1 } }, token);
  const res = await call('PUT', '/vault', { revision: 0, data: { v: 2 } }, token);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { revision: 1, data: { v: 1 } });
});

test('vault requires a valid token, and logout revokes it', async () => {
  assert.equal((await call('GET', '/vault')).status, 401);
  const { token } = (await call('POST', '/register', { username: 'bye', authHash, kdf })).body;
  assert.equal((await call('POST', '/logout', null, token)).status, 204);
  assert.equal((await call('GET', '/vault', null, token)).status, 401);
});

test('other open devices are told when the vault changes', async () => {
  const { token } = (await call('POST', '/register', { username: 'live', authHash, kdf })).body;
  const ws = new WebSocket(base.replace('http', 'ws') + '/events');
  const messages = [];
  const got = (type) => new Promise((resolve) => {
    const check = () => (messages.some((m) => m.type === type) ? resolve() : setTimeout(check, 20));
    check();
  });
  ws.onmessage = (e) => messages.push(JSON.parse(e.data));
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await got('ready');
  await call('PUT', '/vault', { revision: 0, data: { v: 1 } }, token);
  await got('changed');
  assert.deepEqual(messages.at(-1), { type: 'changed', revision: 1 });
  ws.close();
});

test('a bad token gets the socket closed', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/events');
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
  const { code } = await new Promise((r) => { ws.onclose = r; });
  assert.equal(code, 4001);
});
