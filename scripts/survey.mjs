// Login-page survey: opens each site's login page (never types or submits anything), records how the
// page is built, and runs the extension's detection on every frame.
//   node scripts/survey.mjs [outDir]                      the built-in list below
//   SITES=research/all-sites.json node scripts/survey.mjs  a JSON list of [name, url] pairs
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'research'));
const SCRIPTS = ['src/shared/domain.js', 'src/content/fields.js', 'src/content/forms.js'];
const detection = (await Promise.all(SCRIPTS.map((f) => readFile(join(ROOT, f), 'utf8')))).join('\n;\n');

const BUILT_IN = [
  ['Google', 'https://accounts.google.com/signin'],
  ['Microsoft', 'https://login.live.com/'],
  ['Apple', 'https://account.apple.com/sign-in'],
  ['Yahoo', 'https://login.yahoo.com/'],
  ['GitHub', 'https://github.com/login'],
  ['GitLab', 'https://gitlab.com/users/sign_in'],
  ['X', 'https://x.com/i/flow/login'],
  ['Facebook', 'https://www.facebook.com/login'],
  ['Instagram', 'https://www.instagram.com/accounts/login/'],
  ['LinkedIn', 'https://www.linkedin.com/login'],
  ['Reddit', 'https://www.reddit.com/login/'],
  ['Discord', 'https://discord.com/login'],
  ['Twitch', 'https://www.twitch.tv/login'],
  ['Dropbox', 'https://www.dropbox.com/login'],
  ['Zoom', 'https://zoom.us/signin'],
  ['OpenAI', 'https://auth.openai.com/log-in'],
  ['Amazon', 'https://www.amazon.com/gp/sign-in.html'],
  ['eBay', 'https://signin.ebay.com/'],
  ['Walmart', 'https://www.walmart.com/account/login'],
  ['Target', 'https://www.target.com/login'],
  ['Nike', 'https://www.nike.com/login'],
  ['Home Depot', 'https://www.homedepot.com/auth/view/signin'],
  ['Chewy', 'https://www.chewy.com/app/login'],
  ['Netflix', 'https://www.netflix.com/login'],
  ['Disney+', 'https://www.disneyplus.com/login'],
  ['Hulu', 'https://auth.hulu.com/web/login'],
  ['Spotify', 'https://accounts.spotify.com/login'],
  ['Peacock', 'https://www.peacocktv.com/signin'],
  ['Paramount+', 'https://www.paramountplus.com/account/signin/'],
  ['Chase', 'https://secure.chase.com/web/auth/dashboard'],
  ['American Express', 'https://www.americanexpress.com/en-us/account/login'],
  ['Wells Fargo', 'https://connect.secure.wellsfargo.com/auth/login/present'],
  ['Schwab', 'https://client.schwab.com/Login/SignOn/CustomerCenterLogin.aspx'],
  ['Fidelity', 'https://digital.fidelity.com/prgw/digital/login/full-page'],
  ['PayPal', 'https://www.paypal.com/signin'],
  ['Venmo', 'https://id.venmo.com/signin'],
  ['Robinhood', 'https://robinhood.com/login'],
  ['Coinbase', 'https://login.coinbase.com/signin'],
  ['Delta', 'https://www.delta.com/login/loginPage'],
  ['Airbnb', 'https://www.airbnb.com/login'],
  ['Marriott', 'https://www.marriott.com/sign-in.mi'],
  ['Canvas', 'https://canvas.instructure.com/login/canvas'],
  ['Workday (Boeing)', 'https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/login'],
  ['Taleo (EY)', 'https://ey.taleo.net/careersection/iam/accessmanagement/login.jsf'],
  ['Login.gov', 'https://secure.login.gov/'],
  ['USPS', 'https://reg.usps.com/entreg/LoginAction_input'],
  ['Ticketmaster', 'https://www.ticketmaster.com/member'],
  ['Starbucks', 'https://www.starbucks.com/account/signin'],
  ['NYTimes', 'https://myaccount.nytimes.com/auth/login'],
  ['LeetCode', 'https://leetcode.com/accounts/login/'],
  ['Quizlet', 'https://quizlet.com/login'],
  ['Georgia Tech (CAS)', 'https://sso.gatech.edu/cas/login'],
];

const SITES = process.env.SITES ? JSON.parse(await readFile(process.env.SITES, 'utf8')) : BUILT_IN;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

// Script/URL fingerprints of login products and bot-protection vendors.
const VENDORS = {
  Okta: /okta(cdn)?\.com|okta-sign-in/i,
  Auth0: /auth0\.com|auth0-lock|cdn\.auth0/i,
  'AWS Cognito': /cognito/i,
  'SAP Gigya': /gigya|cdns\.gigya/i,
  ForgeRock: /forgerock/i,
  'Ping Identity': /pingidentity|pingone|pingfed/i,
  'Microsoft (MSAL/AAD)': /msauth|aadcdn|login\.microsoftonline/i,
  'Disney OneID': /registerdisney/i,
  Workday: /myworkday/i,
  Taleo: /taleo/i,
  CAS: /\/cas\/login/i,
  reCAPTCHA: /recaptcha/i,
  hCaptcha: /hcaptcha/i,
  'Arkose (FunCaptcha)': /arkoselabs|funcaptcha/i,
  Akamai: /akam|_abck/i,
  PerimeterX: /perimeterx|px-cdn|px-cloud/i,
  DataDome: /datadome/i,
  Cloudflare: /challenges\.cloudflare|cf-turnstile/i,
};

function collect() {
  const PM = globalThis.PM;
  const inputs = PM.deepQueryAll(document, 'input');
  const visible = inputs.filter(PM.isVisible);
  const describeInput = (el) => {
    const c = PM.classifyField(el);
    return {
      type: el.type, name: el.name, id: el.id, autocomplete: el.getAttribute('autocomplete') || '',
      role: c?.role || null, inShadow: el.getRootNode() !== document, inForm: Boolean(el.form),
    };
  };
  const anchors = visible.filter((el) => ['password', 'username', 'otp'].includes(PM.classifyField(el)?.role));
  const groups = [...new Set(anchors.map(PM.findRoot))].map((root) => {
    const g = PM.analyzeGroup(root);
    return { root: root.tagName.toLowerCase(), kind: g.kind, username: Boolean(g.username), password: Boolean(g.current || g.new) };
  });
  return {
    url: location.href,
    title: document.title,
    visibleInputs: visible.filter((el) => !['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(el.type)).map(describeInput),
    forms: document.forms.length,
    shadowHosts: [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length,
    groups,
  };
}

function pageFacts() {
  const srcs = [...document.scripts].map((s) => s.src).filter(Boolean);
  return {
    scripts: srcs.slice(0, 200),
    html: document.documentElement.outerHTML.slice(0, 400000),
    framework: [
      window.__NEXT_DATA__ || document.getElementById('__next') ? 'Next.js' : '',
      document.querySelector('[ng-version]') ? 'Angular' : '',
      window.__NUXT__ ? 'Nuxt' : '',
      document.querySelector('[data-reactroot], #root, #react-root') || window.React ? 'React' : '',
      document.querySelector('[data-v-app], [data-server-rendered]') ? 'Vue' : '',
      window.jQuery ? 'jQuery' : '',
    ].filter(Boolean),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, id: f.id, visible: f.offsetWidth > 50 && f.offsetHeight > 50 })),
  };
}

const siteOf = (url) => {
  try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return ''; }
};

await mkdir(join(OUT, 'shots'), { recursive: true });
// Chrome sometimes drops a tab's connection mid-check; skip that site instead of crashing the run.
process.on('unhandledRejection', (err) => console.error(`ignored: ${err?.message || err}`));
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 60000, args: ['--window-size=1280,900'] });
const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const results = [];

async function survey([name, url]) {
  const page = await browser.newPage();
  await page.setUserAgent(ua);
  await page.setViewport({ width: 1280, height: 900 });
  const r = { name, url };
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch((e) => ({ error: e.message }));
    r.status = resp?.status?.() ?? resp?.error;
    await new Promise((res) => setTimeout(res, 3000));
    r.finalUrl = page.url();
    const facts = await page.evaluate(pageFacts);
    r.framework = facts.framework;
    r.iframes = facts.iframes.filter((f) => f.visible);
    const haystack = [r.finalUrl, ...facts.scripts, facts.html].join('\n');
    r.vendors = Object.keys(VENDORS).filter((k) => VENDORS[k].test(haystack));
    r.frames = [];
    for (const frame of page.frames()) {
      try {
        await frame.evaluate(detection);
        const c = await frame.evaluate(collect);
        if (frame === page.mainFrame() || c.visibleInputs.length) {
          r.frames.push({ ...c, top: frame === page.mainFrame(), crossSite: siteOf(c.url) !== siteOf(r.finalUrl) });
        }
      } catch (e) {
        if (frame === page.mainFrame()) r.frames.push({ top: true, error: e.message });
      }
    }
    await page.screenshot({ path: join(OUT, 'shots', `${name.replace(/\W+/g, '_')}.png`) });
  } catch (e) {
    r.error = e.message;
  }
  results.push(r);
  await appendFile(join(OUT, 'survey.jsonl'), `${JSON.stringify(r)}\n`); // kept even if the run dies later
  done++;
  const kinds = r.frames?.flatMap((f) => (f.groups || []).map((g) => `${f.top ? '' : 'frame:'}${g.kind}`)).join(',');
  console.log(`[${done}/${queue.length}] ${name}: ${r.status} ${r.error || ''} groups=[${kinds}] vendors=[${r.vendors || ''}]`);
  await page.close().catch(() => {});
}

// Sites already in survey.jsonl from an interrupted run are skipped.
const finished = new Set((await readFile(join(OUT, 'survey.jsonl'), 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map((line) => JSON.parse(line).name));
const queue = SITES.filter(([name]) => (!only || only.test(name)) && !finished.has(name));
let done = 0;
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < queue.length) {
    const item = queue[next++];
    // A page that hangs mid-check shouldn't stall the whole run.
    const stuck = new Promise((res) => setTimeout(() => res('stuck'), 90000));
    if (await Promise.race([survey(item), stuck]) === 'stuck') {
      results.push({ name: item[0], url: item[1], error: 'gave up after 90s' });
      done++;
    }
  }
}));

await browser.close();
await writeFile(join(OUT, only ? 'survey-partial.json' : 'survey.json'), JSON.stringify(results, null, 2));
