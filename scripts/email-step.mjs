// Step 2 of the survey, for email-first logins: types your saved username into the first screen,
// submits it, and records what the next screen is. Never types a password.
//   node scripts/email-step.mjs research/email-step-sites.json [outDir]   (JSON list of [name, url, username])
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(import.meta.dirname, '..');
const SITES = JSON.parse(await readFile(process.argv[2], 'utf8'));
const OUT = resolve(process.argv[3] || join(ROOT, 'research', 'email-step'));
const SCRIPTS = ['src/shared/domain.js', 'src/content/fields.js', 'src/content/forms.js'];
const detection = (await Promise.all(SCRIPTS.map((f) => readFile(join(ROOT, f), 'utf8')))).join('\n;\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(join(OUT, 'shots'), { recursive: true });
process.on('unhandledRejection', (err) => console.error(`ignored: ${err?.message || err}`));

// What the extension sees on a screen, across all frames.
async function screen(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(detection);
      const groups = await frame.evaluate(() => {
        const anchors = PM.deepQueryAll(document, 'input').filter(PM.isVisible)
          .filter((el) => ['password', 'username', 'otp'].includes(PM.classifyField(el)?.role));
        return [...new Set(anchors.map(PM.findRoot))].map((root) => PM.analyzeGroup(root).kind);
      });
      out.push(...groups.map((k) => (frame === page.mainFrame() ? k : `frame:${k}`)));
    } catch { /* frame went away */ }
  }
  return out;
}

// Finds the username box the extension would use, in any frame, and returns [frame, selector-handle].
async function findUsernameBox(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(detection);
      const handle = await frame.evaluateHandle(() => {
        const el = PM.deepQueryAll(document, 'input').filter(PM.isVisible)
          .find((i) => PM.classifyField(i)?.role === 'username');
        return el || null;
      });
      const el = handle.asElement();
      if (el) return el;
    } catch { /* ignore */ }
  }
  return null;
}

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 60000 });
const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');

let done = 0;
async function run([name, url, username]) {
  const page = await browser.newPage();
  await page.setUserAgent(ua);
  await page.setViewport({ width: 1280, height: 900 });
  const r = { name, url };
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    r.before = await screen(page);
    const box = await findUsernameBox(page);
    if (!box) {
      r.result = 'no email box found';
    } else {
      await box.click();
      await box.type(username, { delay: 40 });
      await sleep(300);
      await box.press('Enter');
      await sleep(7000);
      r.after = await screen(page);
      r.afterUrl = page.url();
      const text = await page.evaluate(() => document.body?.innerText.slice(0, 2000) || '');
      r.captcha = /captcha|robot|human|unusual activity|verify you/i.test(text);
      r.code = /code|check your (email|inbox|phone)|we sent|one-time/i.test(text);
      r.result = r.after.some((k) => /login$/.test(k)) ? 'password screen'
        : r.after.some((k) => /signup$/.test(k)) ? 'signup screen'
          : r.after.some((k) => /otp$/.test(k)) || r.code ? 'code instead of password'
            : r.captcha ? 'bot check'
              : r.after.some((k) => /username-step$/.test(k)) ? 'still on email screen'
                : 'something else';
    }
    await page.screenshot({ path: join(OUT, 'shots', `${name.replace(/\W+/g, '_')}.png`) });
  } catch (e) {
    r.result = `error: ${e.message.slice(0, 80)}`;
  }
  await appendFile(join(OUT, 'results.jsonl'), `${JSON.stringify(r)}\n`);
  console.log(`[${++done}/${SITES.length}] ${name}: ${r.result} after=[${r.after || ''}]`);
  await page.close().catch(() => {});
}

let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < SITES.length) {
    const item = SITES[next++];
    await Promise.race([run(item), sleep(90000)]);
  }
}));
await browser.close();
