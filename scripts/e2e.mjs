// End-to-end check: loads the extension into Chrome, walks through the playground pages and
// asserts what ends up in the vault and review queue. Run with `npm run e2e`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';

const ROOT = resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  try {
    const path = join(ROOT, 'playground', new URL(req.url, 'http://x').pathname);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const syncServer = createServer(openDb(':memory:')).listen(0);
await new Promise((r) => syncServer.once('listening', r));
const SYNC = `http://localhost:${syncServer.address().port}`;

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
const worker = await swTarget.worker();
const extId = new URL(swTarget.url()).host;
const popup = `chrome-extension://${extId}/src/popup/popup.html`;
// The vault is always encrypted on disk, so read it the way the popup does.
const storage = () => worker.evaluate(async () => {
  if (await isLocked()) return {};
  const s = await handlers.GET_STATE();
  return { vault: s.vault, review: s.review };
});
const rawStorage = () => worker.evaluate(() => chrome.storage.local.get(null));

async function waitFor(desc, check, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await storage();
    if (check({ vault: last.vault || [], review: last.review || [] })) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  const session = await worker.evaluate(() => chrome.storage.session.get(null));
  throw new Error(`Timed out waiting for: ${desc}\nactivity: ${JSON.stringify(session.activity?.map((x) => x.text), null, 2)}`
    + `\npending attempts: ${JSON.stringify(Object.values(session.attempts || {}).map((x) => `${x.kind} ${x.username}`))}`);
}

const page = await browser.newPage();
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (err) {
    const shot = join(tmpdir(), `pm-e2e-fail-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    results.push(`✖ ${name}\n    ${err.message.split('\n').join('\n    ')}\n    screenshot: ${shot}`);
  }
}

const find = (vault, username) => vault.find((c) => c.username === username);
const local = (path) => `http://localhost:${port}/${path}`;

async function fillAndSubmit(url, fields, submitSelector = 'button') {
  await page.goto(url);
  for (const [sel, value] of Object.entries(fields)) await page.type(sel, value);
  await page.click(submitSelector);
}

await step('a login made before signing in is held, then saved by signing in through the popup', async () => {
  await fillAndSubmit(local('login.html'), { '#email': 'early@x.com', '#password': 'early-pw' });
  const end = Date.now() + 20000;
  let queued = [];
  while (Date.now() < end && !queued.length) {
    queued = (await worker.evaluate(() => chrome.storage.session.get('lockedQueue'))).lockedQueue || [];
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(queued.length, 1, 'login captured while signed out waits in memory');
  assert.equal((await rawStorage()).vault, undefined, 'nothing is saved while signed out');

  await page.goto(popup);
  await page.waitForSelector('#welcome:not([hidden])');
  await page.click('#welcome [data-go=signup]');
  await page.click('#server-box summary');
  await page.$eval('#server', (el, url) => { el.value = url; }, SYNC);
  await page.type('#up-username', 'tester');
  await page.type('#up-password', 'correct horse');
  await page.type('#up-confirm', 'correct horse');
  await page.click('#signup button[type=submit]');
  await page.waitForFunction(() => /Account created/.test(document.querySelector('#status').textContent), { timeout: 20000 });
  await waitFor('vault has early@x.com', ({ vault }) => find(vault, 'early@x.com')?.password === 'early-pw');
});

await step('failed login lands in review as "failed", not in the vault', async () => {
  await fillAndSubmit(local('login.html'), { '#email': 'a@b.com', '#password': 'wrong' });
  const s = await waitFor('failed review item', ({ review }) => review.some((r) => r.username === 'a@b.com' && r.status === 'failed'));
  assert.equal(find(s.vault || [], 'a@b.com'), undefined);
});

await step('successful form login (field cleared on submit) is saved and clears the failed try', async () => {
  await fillAndSubmit(local('login.html'), { '#email': 'a@b.com', '#password': 'pw-1' });
  const s = await waitFor('vault has a@b.com', ({ vault }) => find(vault, 'a@b.com')?.password === 'pw-1');
  assert.equal(s.review.filter((r) => r.username === 'a@b.com').length, 0);
});

await step('single-page app login with a div button and no navigation is saved', async () => {
  await fillAndSubmit(local('spa-login.html'), { '#user': 'spauser', '#pass': 'spa-pw' }, '#go');
  await waitFor('vault has spauser', ({ vault }) => find(vault, 'spauser')?.password === 'spa-pw');
});

await step('two-step login pairs the email from page 1 with the password from page 2', async () => {
  await fillAndSubmit(local('two-step.html'), { '#identifier': 'two@step.com' });
  await page.waitForSelector('#password');
  await page.type('#password', 'two-pw');
  await page.click('button');
  await waitFor('vault has two@step.com', ({ vault }) => find(vault, 'two@step.com')?.password === 'two-pw');
});

await step('signup with confirm password is saved', async () => {
  await fillAndSubmit(local('signup.html'), { '[name=full_name]': 'Jack', '#email': 'new@x.com', '#p1': 'sign-pw', '#p2': 'sign-pw' });
  await waitFor('vault has new@x.com', ({ vault }) => find(vault, 'new@x.com')?.password === 'sign-pw');
});

await step('reset on a site with several accounts goes to review as "which account"', async () => {
  await fillAndSubmit(local('reset.html'), { '#p1': 'reset-pw', '#p2': 'reset-pw' });
  await waitFor('which-account review', ({ review }) => review.some((r) => r.password === 'reset-pw' && r.status === 'which-account'));
});

await step('reset on a site with one account updates it and keeps the old password in history', async () => {
  const other = (path) => `http://127.0.0.1:${port}/${path}`;
  await fillAndSubmit(other('login.html'), { '#email': 'solo@x.com', '#password': 'old-pw' });
  await waitFor('vault has solo@x.com', ({ vault }) => find(vault, 'solo@x.com')?.password === 'old-pw');
  await fillAndSubmit(other('reset.html'), { '#p1': 'fresh-pw', '#p2': 'fresh-pw' });
  const s = await waitFor('solo@x.com updated', ({ vault }) => find(vault, 'solo@x.com')?.password === 'fresh-pw');
  assert.equal(find(s.vault, 'solo@x.com').history[0].password, 'old-pw');
});

await step('login popup in a cross-site frame, email then password, frame closes on success', async () => {
  await page.goto(local('modal-login.html'));
  await page.click('#open');
  const frameHandle = await page.waitForSelector('#login-frame');
  const frame = await frameHandle.contentFrame();
  await frame.waitForSelector('#email');
  await frame.type('#email', 'fan@espn-like.com');
  await frame.click('button[type=submit]');
  await frame.waitForSelector('#password');
  await frame.type('#password', 'frame-pw');
  await frame.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#state').textContent === 'Signed in.');
  const s = await waitFor('vault has fan@espn-like.com', ({ vault }) => find(vault, 'fan@espn-like.com')?.password === 'frame-pw');
  const cred = find(s.vault, 'fan@espn-like.com');
  assert.equal(cred.site, '127.0.0.1');
  assert.deepEqual(cred.seenOn, ['localhost']);
});

await step('focusing a login field with saved logins opens the autofill menu', async () => {
  await page.goto(local('login.html'));
  await page.focus('#email');
  await page.waitForSelector('pm-ui', { timeout: 3000 });
});

await step('CSV import adds new logins and sends a conflicting password to review', async () => {
  const { writeFile } = await import('node:fs/promises');
  const csvPath = join(tmpdir(), `pm-import-${Date.now()}.csv`);
  await writeFile(csvPath, 'name,url,username,password,note\n'
    + `localhost,http://localhost:${port}/login.html,a@b.com,stale-pw,\n`
    + 'mlb.com,https://www.mlb.com/login,fan@x.com,go-team,\n'
    + 'app,android://x@com.app/,me,pw,\n');
  await page.goto(`chrome-extension://${extId}/src/import/import.html`);
  const input = await page.$('#file');
  await input.uploadFile(csvPath);
  await page.click('#go');
  await page.waitForFunction(() => /Imported|failed/.test(document.querySelector('#result').textContent));
  const text = await page.$eval('#result', (el) => el.textContent);
  assert.match(text, /Imported 1 new login\./);
  assert.match(text, /1 differ/);
  assert.match(text, /Skipped 1/);
  const s = await storage();
  assert.equal(find(s.vault, 'fan@x.com')?.password, 'go-team');
  assert.equal(find(s.vault, 'a@b.com').password, 'pw-1', 'existing password must not be overwritten');
  assert.ok(s.review.some((r) => r.username === 'a@b.com' && r.status === 'import-conflict'));
});

await step('forgot password -> new password in the same tab updates that account, not "which account"', async () => {
  await fillAndSubmit(local('forgot.html'), { '#u': 'a@b.com' });
  await page.waitForSelector('#p1');
  await page.type('#p1', 'after-reset');
  await page.type('#p2', 'after-reset');
  await page.click('button');
  const s = await waitFor('a@b.com reset', ({ vault }) => find(vault, 'a@b.com')?.password === 'after-reset');
  assert.equal(find(s.vault, 'a@b.com').history[0].password, 'pw-1');
});

const pendingCards = async (number) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const { pendingCards: p = {} } = await worker.evaluate(() => chrome.storage.session.get('pendingCards'));
    const hit = Object.entries(p).find(([, c]) => c.number === number);
    if (hit) return { pendingId: hit[0], card: hit[1] };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no save-card prompt for ${number}`);
};
const savedCards = () => worker.evaluate(async () => (await handlers.GET_STATE()).cards);

await step('card payment with month/year dropdowns offers to save the card (without the CVC)', async () => {
  await page.goto(local('checkout.html'));
  await page.type('#nm', 'Jack Williams');
  await page.type('#cn', '4242 4242 4242 4242');
  await page.select('#mo', '4');
  await page.select('#yr', '2028');
  await page.type('#cv', '123');
  await page.type('#zp', '02114');
  await page.click('button');
  const { pendingId, card } = await pendingCards('4242424242424242');
  assert.deepEqual([card.expMonth, card.expYear, card.name, card.zip], ['04', '2028', 'Jack Williams', '02114']);
  assert.ok(!JSON.stringify(card).includes('123'), 'CVC is never captured');
  await worker.evaluate((id) => handlers.SAVE_CARD({ pendingId: id }, {}), pendingId); // the toast's Save button
  assert.deepEqual((await savedCards()).map((c) => c.number), ['4242424242424242']);
  assert.ok(!JSON.stringify(await rawStorage()).includes('4242424242424242'), 'cards are encrypted on disk');
});

await step('card fields split across iframes add up to one card', async () => {
  await page.goto(local('checkout-frames.html'));
  const frame = async (id) => (await page.waitForSelector(`#${id}`)).contentFrame();
  await page.type('#nm', 'Jack W');
  await (await frame('number')).type('#f', '5555555555554444');
  await (await frame('exp')).type('#f', '09 / 30');
  await (await frame('cvc')).type('#f', '999');
  await page.click('#pay');
  const { card } = await pendingCards('5555555555554444');
  assert.deepEqual([card.expMonth, card.expYear, card.name], ['09', '2030', 'Jack W']);
});

await step('focusing a card field in a small iframe shows the menu on the page; picking a card fills every frame', async () => {
  await page.goto(local('checkout-frames.html'));
  const numberFrame = await page.waitForSelector('#number');
  const number = await numberFrame.contentFrame();
  const exp = await (await page.waitForSelector('#exp')).contentFrame();
  const cvc = await (await page.waitForSelector('#cvc')).contentFrame();
  await number.waitForSelector('#f[name=cardnumber]');
  await number.click('#f');
  await page.waitForSelector('pm-ui', { timeout: 3000 }); // drawn by the top page, below the iframe
  await new Promise((r) => setTimeout(r, 300));
  const box = await numberFrame.boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height + 20); // the first card in the menu
  await number.waitForFunction(() => document.querySelector('#f').value === '4242424242424242');
  assert.equal(await exp.$eval('#f', (el) => el.value), '04 / 28');
  assert.equal(await page.$eval('#nm', (el) => el.value), 'Jack Williams');
  assert.equal(await cvc.$eval('#f', (el) => el.value), '', 'CVC is left for you to type');
});

await step('checkout with the address in an iframe offers to save name, email and address together', async () => {
  await page.goto(local('checkout-address.html'));
  const addr = await (await page.waitForSelector('#address')).contentFrame();
  await addr.waitForSelector('#line1');
  await page.type('#name-input', 'Jack Williams');
  await page.type('#email-input', 'jack@example.com');
  await addr.type('#line1', '1 Main St');
  await addr.type('#city', 'Boston');
  await addr.select('#state', 'MA');
  await addr.type('#zip', '02114');
  await page.click('#continue');
  const end = Date.now() + 10000;
  let hit;
  while (!hit && Date.now() < end) {
    const { pendingProfiles: p = {} } = await worker.evaluate(() => chrome.storage.session.get('pendingProfiles'));
    hit = Object.entries(p).find(([, x]) => x.address1 === '1 Main St');
    if (!hit) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(hit, 'no save-address prompt');
  const [pendingId, draft] = hit;
  assert.deepEqual([draft.name, draft.email, draft.city, draft.state, draft.zip, draft.country],
    ['Jack Williams', 'jack@example.com', 'Boston', 'MA', '02114', 'US']);
  await worker.evaluate((id) => handlers.SAVE_PROFILE({ pendingId: id }, {}), pendingId); // the toast's button
});

await step('picking a saved address fills the page and the address iframe, but not the footer newsletter box', async () => {
  await page.goto(local('checkout-address.html'));
  const addr = await (await page.waitForSelector('#address')).contentFrame();
  await addr.waitForSelector('#line1');
  await page.click('#name-input');
  await page.waitForSelector('pm-ui', { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 300));
  const box = await (await page.$('#name-input')).boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height + 20); // first item in the menu
  await page.waitForFunction(() => document.querySelector('#name-input').value === 'Jack Williams');
  assert.equal(await page.$eval('#email-input', (el) => el.value), 'jack@example.com');
  await addr.waitForFunction(() => document.querySelector('#line1').value === '1 Main St');
  assert.deepEqual(await addr.evaluate(() => ['#city', '#state', '#zip', '#country'].map((s) => document.querySelector(s).value)),
    ['Boston', 'MA', '02114', 'US']);
  assert.equal(await page.$eval('#newsletterSignupEmailInput', (el) => el.value), '', 'newsletter box untouched');
});

await step('the vault is encrypted on disk; logins made while locked are saved on unlock', async () => {
  const raw = JSON.stringify(await rawStorage());
  assert.ok(!raw.includes('after-reset') && !raw.includes('a@b.com'), 'no plaintext logins in local storage');

  await page.goto(popup);
  await page.click('#lock');
  await page.waitForSelector('#unlock:not([hidden])');
  await fillAndSubmit(local('login.html'), { '#email': 'locked@x.com', '#password': 'locked-pw' });
  const end = Date.now() + 20000;
  let queued = [];
  while (Date.now() < end && !queued.length) {
    queued = (await worker.evaluate(() => chrome.storage.session.get('lockedQueue'))).lockedQueue || [];
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(queued.length, 1, 'login captured while locked waits in memory');

  await page.goto(popup);
  await page.type('#u-password', 'wrong one');
  await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#unlock-error:not([hidden])');
  await page.$eval('#u-password', (el) => { el.value = ''; });
  await page.type('#u-password', 'correct horse');
  await page.click('#unlock button[type=submit]');
  await page.waitForFunction(() => /locked@x\.com/.test(document.querySelector('#vault').textContent)
    && /a@b\.com/.test(document.querySelector('#vault').textContent), { timeout: 20000 });
  assert.ok(!JSON.stringify(await rawStorage()).includes('locked-pw'));
});

await step('signing out uploads, then removes the logins from this computer', async () => {
  await page.goto(popup);
  await page.click('#open-sync');
  await page.click('#sign-out');
  await page.waitForSelector('#signin:not([hidden])');
  const raw = await rawStorage();
  assert.equal(raw.vault, undefined);
  assert.equal(raw.sync, undefined);

  // Reopening the popup lands on Sign in with the username and server remembered.
  await page.goto(popup);
  await page.waitForSelector('#signin:not([hidden])');
  assert.equal(await page.$eval('#in-username', (el) => el.value), 'tester');
  await page.type('#in-password', 'wrong horse');
  await page.click('#signin button[type=submit]');
  await page.waitForFunction(() => /Wrong master password/.test(document.querySelector('#signin-error').textContent), { timeout: 20000 });
  await page.$eval('#in-password', (el) => { el.value = ''; });
  await page.type('#in-password', 'correct horse');
  await page.click('#signin button[type=submit]');
  await page.waitForFunction(() => /Signed in/.test(document.querySelector('#status').textContent), { timeout: 20000 });
  await waitFor('logins back from the account', ({ vault }) => find(vault, 'locked@x.com') && find(vault, 'early@x.com'));
  assert.deepEqual((await savedCards()).map((c) => c.number), ['4242424242424242'], 'cards come back from the account too');
});

await browser.close();
server.close();
syncServer.close();
console.log(results.join('\n'));
process.exitCode = results.some((r) => r.startsWith('✖')) ? 1 : 0;
