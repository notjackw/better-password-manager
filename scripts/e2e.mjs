// End-to-end check: loads the extension into Chrome, walks through the playground pages and
// asserts what ends up in the vault and review queue. Run with `npm run e2e`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

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

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
const worker = await swTarget.worker();
const storage = () => worker.evaluate(() => chrome.storage.local.get(null));

async function waitFor(desc, check, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await storage();
    if (check({ vault: last.vault || [], review: last.review || [] })) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for: ${desc}\nstorage: ${JSON.stringify(last, null, 2)}`);
}

const page = await browser.newPage();
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (err) {
    results.push(`✖ ${name}\n    ${err.message.split('\n').join('\n    ')}`);
  }
}

const find = (vault, username) => vault.find((c) => c.username === username);
const local = (path) => `http://localhost:${port}/${path}`;

async function fillAndSubmit(url, fields, submitSelector = 'button') {
  await page.goto(url);
  for (const [sel, value] of Object.entries(fields)) await page.type(sel, value);
  await page.click(submitSelector);
}

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

await step('focusing a login field with saved logins opens the autofill menu', async () => {
  await page.goto(local('login.html'));
  await page.focus('#email');
  await page.waitForSelector('pm-ui', { timeout: 3000 });
});

await browser.close();
server.close();
console.log(results.join('\n'));
process.exitCode = results.some((r) => r.startsWith('✖')) ? 1 : 0;
