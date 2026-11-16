// End-to-end sync check: runs the sync server in-process and two Chromes with the extension, then
// checks that logins (and deletions) made on one show up on the other. Run with `npm run e2e:sync`.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';

const ROOT = resolve(import.meta.dirname, '..');
const server = createServer(openDb(':memory:')).listen(0);
await new Promise((r) => server.once('listening', r));
const SERVER = `http://localhost:${server.address().port}`;

async function device() {
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const vault = async () => (await send({ type: 'GET_STATE' })).vault;
  return { browser, page, send, vault };
}

const results = [];
const a = await device();
const b = await device();
try {
  const login = (site, username, password) => ({ type: 'SAVE_CRED', cred: { site, origin: '', username, password } });

  assert.equal((await a.send({ type: 'SIGN_IN', mode: 'signin', server: SERVER, username: 'jack', password: 'correct horse' })).code, 'no-account');
  assert.equal((await a.send({ type: 'SIGN_IN', mode: 'signin', server: 'http://localhost:1', username: 'jack', password: 'correct horse' })).code, 'offline');
  assert.deepEqual(await a.send({ type: 'SIGN_IN', mode: 'signup', server: SERVER, username: 'Jack', password: 'correct horse' }), { created: true, saved: 0 });
  await a.send(login('example.com', 'jack', 'pw-a'));
  await a.send({ type: 'SYNC_NOW' });
  results.push('✔ device A: unknown account and unreachable server get clear errors, then it creates an account and saves a login');

  assert.equal((await b.send(login('other.com', 'jack', 'pw-b'))).error, 'Error: locked', 'nothing saves before signing in');
  assert.equal((await b.send({ type: 'SIGN_IN', mode: 'signup', server: SERVER, username: 'jack', password: 'whatever!' })).code, 'taken');
  assert.equal((await b.send({ type: 'SIGN_IN', mode: 'signin', server: SERVER, username: 'jack', password: 'nope nope' })).code, 'wrong-password');
  assert.deepEqual(await b.send({ type: 'SIGN_IN', mode: 'signin', server: SERVER, username: 'jack', password: 'correct horse' }), { created: false, saved: 0 });
  assert.deepEqual((await b.vault()).map((c) => c.site), ['example.com']);
  await b.send(login('other.com', 'jack', 'pw-b'));
  await b.send({ type: 'SYNC_NOW' });
  results.push('✔ device B can\'t save before signing in, can\'t take a used username, rejects a wrong password, then gets A\'s logins');

  await a.send({ type: 'SYNC_NOW' });
  assert.deepEqual((await a.vault()).map((c) => c.site).sort(), ['example.com', 'other.com']);
  results.push('✔ device A picks up B\'s login');

  const doomed = (await a.vault()).find((c) => c.site === 'other.com');
  await a.send({ type: 'DELETE_CRED', id: doomed.id });
  await a.send({ type: 'SYNC_NOW' });
  await b.send({ type: 'SYNC_NOW' });
  assert.deepEqual((await b.vault()).map((c) => c.site), ['example.com']);
  results.push('✔ a deletion on A removes the login on B');

  await a.send(login('live.com', 'jack', 'pw-live'));
  const end = Date.now() + 10000;
  while (!(await b.vault()).some((c) => c.site === 'live.com') && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  assert.ok((await b.vault()).some((c) => c.site === 'live.com'), 'B never got the new login');
  results.push(`✔ a login saved on A shows up on B by itself, ${((10000 - (end - Date.now())) / 1000).toFixed(1)}s later`);

  const { sync } = await b.page.evaluate(() => chrome.storage.local.get('sync'));
  await fetch(`${SERVER}/logout`, { method: 'POST', headers: { authorization: `Bearer ${sync.token}` } });
  assert.deepEqual(await b.send({ type: 'SYNC_NOW' }), {});
  results.push('✔ when the server session ends, B signs back in by itself');

  await b.send({ type: 'LOCK' });
  const unlocked = await b.send({ type: 'UNLOCK', password: 'correct horse' });
  assert.equal(unlocked.error, undefined);
  results.push('✔ B now unlocks with the account\'s master password');
} catch (err) {
  results.push(`✖ ${err.message}`);
  process.exitCode = 1;
} finally {
  console.log(results.join('\n'));
  await a.browser.close();
  await b.browser.close();
  server.close();
}
