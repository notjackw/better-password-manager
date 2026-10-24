// Background: owns the vault, tracks the in-flight login attempt per tab, and decides what gets saved.
//
// Flow: content script reports ATTEMPT on submit -> the page (or the next page, via HELLO) watches
// what happens -> OUTCOME success saves to the vault; failure/unknown goes to "Needs review" so a
// credential is never silently lost.
importScripts('../shared/domain.js');

const PM = globalThis.PM;
const ATTEMPT_TTL_MS = 2 * 60 * 1000;
const STEP_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 10;

// Serializes read-modify-write cycles on storage so concurrent messages can't clobber each other.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function load(area, key, fallback) {
  const result = await chrome.storage[area].get(key);
  return result[key] ?? fallback;
}
const save = (area, key, value) => chrome.storage[area].set({ [key]: value });

const sameUser = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

async function updateBadge() {
  const review = await load('local', 'review', []);
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  await chrome.action.setBadgeText({ text: review.length ? String(review.length) : '' });
}

// ---- Vault -----------------------------------------------------------------------------------

// Inserts or updates the login for (site, username). Returns { cred, created, changed, ambiguous }.
async function upsertCredential({ site, origin, username = '', password, currentPassword = '', kind }) {
  const vault = await load('local', 'vault', []);
  const onSite = vault.filter((c) => c.site === site);
  let match = null;
  if (username) match = onSite.find((c) => sameUser(c.username, username));
  if (!match && currentPassword) match = onSite.find((c) => c.password === currentPassword);
  if (!match && !username) {
    // A reset/change form with no username: only safe to guess when the site has one login.
    if (onSite.length === 1) match = onSite[0];
    else if (onSite.length > 1) return { ambiguous: true };
  }

  const now = Date.now();
  let created = false;
  let changed = false;
  if (match) {
    if (match.password !== password) {
      changed = true;
      match.history = [{ password: match.password, replacedAt: now }, ...(match.history || [])].slice(0, HISTORY_LIMIT);
      match.password = password;
    }
    if (username && !match.username) match.username = username;
    match.updated = now;
  } else {
    match = { id: crypto.randomUUID(), site, origin, username, password, history: [], source: kind, created: now, updated: now };
    vault.push(match);
    created = true;
  }
  await save('local', 'vault', vault);
  return { cred: match, created, changed };
}

// ---- Review queue ----------------------------------------------------------------------------

async function addReview(a, status) {
  const review = await load('local', 'review', []);
  const existing = review.find((r) => r.site === a.site && sameUser(r.username, a.username) && r.password === a.password);
  const item = existing || { id: crypto.randomUUID() };
  Object.assign(item, {
    site: a.site,
    origin: a.origin,
    url: a.url,
    username: a.username || '',
    password: a.password,
    currentPassword: a.currentPassword || '',
    kind: a.kind,
    status,
    ts: Date.now(),
  });
  if (!existing) review.unshift(item);
  await save('local', 'review', review);
  await updateBadge();
}

// After a confirmed save, earlier failed/unconfirmed tries for the same account are noise.
async function clearReviewFor(a) {
  const review = await load('local', 'review', []);
  const kept = review.filter((r) => !(r.site === a.site && (sameUser(r.username, a.username) || r.password === a.password)));
  if (kept.length !== review.length) {
    await save('local', 'review', kept);
    await updateBadge();
  }
}

// ---- Attempts --------------------------------------------------------------------------------

function notifyTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

async function resolveAttempt(a, outcome) {
  if (outcome !== 'success') {
    await addReview(a, outcome === 'failure' ? 'failed' : 'unconfirmed');
    return;
  }
  const res = await upsertCredential(a);
  if (res.ambiguous) {
    await addReview(a, 'which-account');
    return;
  }
  await clearReviewFor(a);
  const steps = await load('session', 'steps', {});
  if (steps[a.tabId]) {
    delete steps[a.tabId];
    await save('session', 'steps', steps);
  }
  if (!res.created && !res.changed) return; // already in the vault as-is
  const who = res.cred.username ? ` (${res.cred.username})` : '';
  const verb = !res.created ? 'Updated password' : a.kind === 'login' ? 'Saved login' : 'Saved new account';
  notifyTab(a.tabId, {
    type: 'TOAST',
    text: `${verb} for ${a.site}${who}`,
    undo: { credId: res.cred.id, created: res.created },
  });
}

async function takeAttempt(predicate) {
  const attempts = await load('session', 'attempts', {});
  const entry = Object.entries(attempts).find(([, a]) => predicate(a));
  if (!entry) return null;
  delete attempts[entry[0]];
  await save('session', 'attempts', attempts);
  return entry[1];
}

async function sweepAttempts() {
  const now = Date.now();
  let expired;
  while ((expired = await takeAttempt((a) => now - a.ts > ATTEMPT_TTL_MS))) await resolveAttempt(expired, 'unknown');
  if (Object.keys(await load('session', 'attempts', {})).length) await chrome.alarms.create('sweep', { delayInMinutes: 3 });
}

// ---- Message handlers ------------------------------------------------------------------------

const handlers = {
  async STEP_USERNAME({ username, site }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const steps = await load('session', 'steps', {});
    steps[tabId] = { username, site, ts: Date.now() };
    await save('session', 'steps', steps);
    return {};
  },

  async ATTEMPT({ attempt }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const now = Date.now();
    const a = { ...attempt, id: crypto.randomUUID(), tabId, frameId: sender.frameId ?? 0, ts: now };

    // Multi-step logins (email on one page, password on the next): borrow the earlier username.
    // Only for logins: a reset or signup page without a username field is a different flow.
    if (!a.username && a.kind === 'login') {
      const step = (await load('session', 'steps', {}))[tabId];
      if (step && now - step.ts < STEP_TTL_MS) a.username = step.username;
    }

    if (a.trigger === 'unload' || a.trigger === 'removed') {
      await addReview(a, 'unconfirmed');
      return {};
    }

    const attempts = await load('session', 'attempts', {});
    const prev = attempts[tabId];
    // A retry for the same account replaces the earlier try; a different account's try is kept for review.
    if (prev && !(prev.site === a.site && sameUser(prev.username, a.username))) await addReview(prev, 'unconfirmed');
    attempts[tabId] = a;
    await save('session', 'attempts', attempts);
    await chrome.alarms.create('sweep', { delayInMinutes: 3 });
    return { id: a.id };
  },

  // A page finished loading. If its tab has a fresh attempt, this page decides how it went.
  async HELLO(_msg, sender) {
    const tabId = sender.tab?.id;
    const a = (await load('session', 'attempts', {}))[tabId];
    if (!a || Date.now() - a.ts > ATTEMPT_TTL_MS) return {};
    if (sender.frameId !== 0 && sender.frameId !== a.frameId) return {};
    return { evaluate: a.id };
  },

  async OUTCOME({ id, outcome }) {
    const a = await takeAttempt((x) => x.id === id);
    if (a) await resolveAttempt(a, outcome);
    return {};
  },

  async GENERATED(msg) {
    await addReview(msg, 'generated');
    return {};
  },

  async UNDO({ undo }) {
    const vault = await load('local', 'vault', []);
    const cred = vault.find((c) => c.id === undo.credId);
    if (!cred) return {};
    if (undo.created) {
      vault.splice(vault.indexOf(cred), 1);
    } else if (cred.history?.length) {
      cred.password = cred.history.shift().password;
      cred.updated = Date.now();
    }
    await save('local', 'vault', vault);
    return {};
  },

  async GET_CREDS(_msg, sender) {
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : sender.url;
    const site = PM.siteKey(new URL(origin).hostname);
    const vault = await load('local', 'vault', []);
    const step = (await load('session', 'steps', {}))[sender.tab?.id];
    const hint = step && Date.now() - step.ts < STEP_TTL_MS ? step.username : '';
    const creds = vault
      .filter((c) => c.site === site)
      .sort((a, b) => b.updated - a.updated)
      .map(({ id, username, password }) => ({ id, username, password }));
    return { creds, hint };
  },

  // ---- Popup ----

  async GET_STATE() {
    return { vault: await load('local', 'vault', []), review: await load('local', 'review', []) };
  },

  async SAVE_CRED({ cred, reviewId }) {
    if (cred.id) {
      const vault = await load('local', 'vault', []);
      const existing = vault.find((c) => c.id === cred.id);
      if (existing) {
        if (existing.password !== cred.password) {
          existing.history = [{ password: existing.password, replacedAt: Date.now() }, ...(existing.history || [])]
            .slice(0, HISTORY_LIMIT);
        }
        Object.assign(existing, { site: cred.site, username: cred.username, password: cred.password, updated: Date.now() });
        await save('local', 'vault', vault);
      }
    } else {
      await upsertCredential({ ...cred, kind: 'manual' });
    }
    if (reviewId) {
      const review = await load('local', 'review', []);
      await save('local', 'review', review.filter((r) => r.id !== reviewId));
    }
    await updateBadge();
    return {};
  },

  async DELETE_CRED({ id }) {
    const vault = await load('local', 'vault', []);
    await save('local', 'vault', vault.filter((c) => c.id !== id));
    return {};
  },

  async DISCARD_REVIEW({ id }) {
    const review = await load('local', 'review', []);
    await save('local', 'review', review.filter((r) => r.id !== id));
    await updateBadge();
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  serial(() => handler(msg, sender)).then(sendResponse, (err) => {
    console.error(`${msg.type} failed`, err);
    sendResponse({ error: String(err) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sweep') serial(sweepAttempts);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const a = await takeAttempt((x) => x.tabId === tabId);
    if (a) await resolveAttempt(a, 'unknown');
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-login' || tab?.id == null) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'FILL_BEST' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => serial(updateBadge));
chrome.runtime.onStartup.addListener(() => serial(updateBadge));
