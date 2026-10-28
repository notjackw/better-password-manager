// Background: owns the vault, tracks the in-flight login attempt per tab, and decides what gets saved.
//
// Flow: content script reports ATTEMPT on submit -> the page (or the next page, via HELLO) watches
// what happens -> OUTCOME success saves to the vault; failure/unknown goes to "Needs review" so a
// credential is never silently lost.
importScripts('../shared/domain.js', '../shared/vault-crypto.js');

const PM = globalThis.PM;
const ATTEMPT_TTL_MS = 2 * 60 * 1000;
const STEP_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 10;
const ACTIVITY_LIMIT = 30;
const TOAST_REPLAY_MS = 8000;

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

// ---- Encryption -------------------------------------------------------------------------------
//
// Without a master password, `vault` and `review` are plain arrays in chrome.storage.local. With one,
// they're stored encrypted ({ enc: 1, iv, data }), and the key lives only in chrome.storage.session:
// memory, never written to disk, gone when Chrome quits, and unreadable by content scripts.
// While locked, finished logins wait in session storage (`lockedQueue`) until the next unlock.

async function getKey() {
  const jwk = await load('session', 'key', null);
  return jwk ? PM.importKey(jwk) : null;
}

async function hasMaster() {
  return Boolean(await load('local', 'kdf', null));
}

async function isLocked() {
  return (await hasMaster()) && !(await load('session', 'key', null));
}

async function loadSecret(name) {
  const stored = await load('local', name, []);
  if (!PM.isEncrypted(stored)) return stored;
  const key = await getKey();
  if (!key) throw new Error('locked');
  return PM.decryptJson(key, stored);
}

async function saveSecret(name, value) {
  const key = (await hasMaster()) ? await getKey() : null;
  if ((await hasMaster()) && !key) throw new Error('locked');
  await save('local', name, key ? await PM.encryptJson(key, value) : value);
  if (name === 'review') await save('local', 'reviewCount', value.length); // so the badge works while locked
}

async function queueWhileLocked(item) {
  const q = await load('session', 'lockedQueue', []);
  await save('session', 'lockedQueue', [...q, item]);
}

const sameUser = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

async function updateBadge() {
  const locked = await isLocked();
  const count = await load('local', 'reviewCount', 0) + (await load('session', 'lockedQueue', [])).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  await chrome.action.setBadgeText({ text: count ? String(count) : locked ? '🔒' : '' });
}

// What the extension noticed and decided, newest first, shown under "Recent activity" in the popup.
// It's how you tell "never saw the login" apart from "saw it but couldn't confirm it worked".
async function logActivity(text) {
  const activity = await load('session', 'activity', []);
  await save('session', 'activity', [{ ts: Date.now(), text }, ...activity].slice(0, ACTIVITY_LIMIT));
}

const describe = (a) => `${a.kind} on ${a.site}${a.username ? ` (${a.username})` : ' (no username)'}`;

// ---- Vault -----------------------------------------------------------------------------------

// Inserts or updates the login for (site, username). Returns { cred, created, changed, ambiguous }.
async function upsertCredential({ site, origin, username = '', password, currentPassword = '', kind, pageSite }) {
  const vault = await loadSecret('vault');
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
    addSeenOn(match, pageSite);
  } else {
    match = newCredential({ site, origin, username, password }, kind);
    addSeenOn(match, pageSite);
    vault.push(match);
    created = true;
  }
  await saveSecret('vault', vault);
  return { cred: match, created, changed };
}

// Logins typed into a frame embedded from another site (Disney's login on espn.com) are filed under the
// frame's site, which is where they get filled again. seenOn remembers the pages they were used on.
function addSeenOn(cred, pageSite) {
  if (!pageSite || pageSite === cred.site) return;
  cred.seenOn = [...new Set([...(cred.seenOn || []), pageSite])];
}

function newCredential({ site, origin, username = '', password }, source) {
  const now = Date.now();
  return { id: crypto.randomUUID(), site, origin, username, password, history: [], source, created: now, updated: now };
}

// ---- Review queue ----------------------------------------------------------------------------

async function addReview(a, status) {
  if (await isLocked()) {
    await queueWhileLocked({ review: a, status });
    await updateBadge();
    return;
  }
  const review = await loadSecret('review');
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
  await saveSecret('review', review);
  await updateBadge();
}

// After a confirmed save, earlier failed/unconfirmed tries for the same account are noise.
async function clearReviewFor(a) {
  const review = await loadSecret('review');
  const kept = review.filter((r) => !(r.site === a.site && (sameUser(r.username, a.username) || r.password === a.password)));
  if (kept.length !== review.length) {
    await saveSecret('review', kept);
    await updateBadge();
  }
}

// ---- Attempts --------------------------------------------------------------------------------

// Toasts go to the top page. Sites often reload that page right after a login (espn.com does when its
// login frame closes), which would wipe the toast, so the next page load in the tab replays it.
async function notifyTab(tabId, msg) {
  const toasts = await load('session', 'toasts', {});
  toasts[tabId] = { msg, ts: Date.now() };
  await save('session', 'toasts', toasts);
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

async function takeToast(tabId) {
  const toasts = await load('session', 'toasts', {});
  const t = toasts[tabId];
  if (!t) return null;
  delete toasts[tabId];
  await save('session', 'toasts', toasts);
  return Date.now() - t.ts < TOAST_REPLAY_MS ? t.msg : null;
}

async function resolveAttempt(a, outcome) {
  if (await isLocked()) {
    await queueWhileLocked({ attempt: a, outcome });
    await logActivity(`${describe(a)}: ${outcome === 'success' ? 'worked' : 'finished'}, waiting for you to unlock`);
    await notifyTab(a.tabId, { type: 'TOAST', text: `Login captured for ${a.site}. Unlock Password Manager to save it.` });
    await updateBadge();
    return;
  }
  if (outcome !== 'success') {
    await addReview(a, outcome === 'failure' ? 'failed' : 'unconfirmed');
    await logActivity(`${describe(a)}: ${outcome === 'failure' ? 'looked like it failed' : "couldn't confirm it worked"}, sent to Needs review`);
    return;
  }
  const res = await upsertCredential(a);
  if (res.ambiguous) {
    await addReview(a, 'which-account');
    await logActivity(`${describe(a)}: worked, but the site has several accounts, sent to Needs review`);
    return;
  }
  await clearReviewFor(a);
  const steps = await load('session', 'steps', {});
  if (steps[a.tabId]) {
    delete steps[a.tabId];
    await save('session', 'steps', steps);
  }
  const who = res.cred.username ? ` (${res.cred.username})` : '';
  // Confirm every recognized login, even one already saved as-is, so silence always means "not seen".
  const verb = res.created ? (a.kind === 'login' ? 'Saved login' : 'Saved new account')
    : res.changed ? 'Updated password' : 'Login recognized, already saved';
  await logActivity(`${describe(a)}: worked. ${verb}`);
  await notifyTab(a.tabId, {
    type: 'TOAST',
    text: `${verb} for ${a.site}${who}`,
    undo: res.created || res.changed ? { credId: res.cred.id, created: res.created } : null,
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
    const prev = steps[tabId];
    steps[tabId] = { username, site, ts: Date.now() };
    await save('session', 'steps', steps);
    // One Continue click often fires both click and submit.
    if (!(prev && prev.username === username && prev.site === site && Date.now() - prev.ts < 5000)) {
      await logActivity(`Remembered ${username} from the email step on ${site}`);
    }
    return {};
  },

  async ATTEMPT({ attempt }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const now = Date.now();
    const a = { ...attempt, id: attempt.id || crypto.randomUUID(), tabId, frameId: sender.frameId ?? 0, ts: now };
    if (sender.tab.url) a.pageSite = PM.siteKey(new URL(sender.tab.url).hostname);

    // Multi-step flows (email on one screen, password on the next): borrow the earlier username.
    // Logins may cross sites (login.live.com -> login.microsoftonline.com); signups must stay on
    // the same site. Resets never borrow: the reset link may be for a different account entirely.
    if (!a.username && (a.kind === 'login' || a.kind === 'signup')) {
      const step = (await load('session', 'steps', {}))[tabId];
      const fresh = step && now - step.ts < STEP_TTL_MS;
      if (fresh && (a.kind === 'login' || step.site === a.site)) a.username = step.username;
    }

    if (a.trigger === 'unload' || a.trigger === 'removed') {
      await addReview(a, 'unconfirmed');
      await logActivity(`${describe(a)}: caught only as the page closed, sent to Needs review`);
      return {};
    }

    const attempts = await load('session', 'attempts', {});
    const prev = attempts[tabId];
    // A retry for the same account replaces the earlier try; a different account's try is kept for review.
    if (prev && !(prev.site === a.site && sameUser(prev.username, a.username))) await addReview(prev, 'unconfirmed');
    attempts[tabId] = a;
    await save('session', 'attempts', attempts);
    await chrome.alarms.create('sweep', { delayInMinutes: 3 });
    await logActivity(`${describe(a)}: submitted, watching whether it worked`);
    return { id: a.id };
  },

  // A page finished loading. If its tab has a fresh attempt, this page decides how it went.
  async HELLO(_msg, sender) {
    const tabId = sender.tab?.id;
    const toast = sender.frameId === 0 ? await takeToast(tabId) : null;
    const a = (await load('session', 'attempts', {}))[tabId];
    if (!a || Date.now() - a.ts > ATTEMPT_TTL_MS) return { toast };
    if (sender.frameId !== 0 && sender.frameId !== a.frameId) return { toast };
    return { toast, evaluate: a.id };
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
    if (await isLocked()) return {};
    const vault = await loadSecret('vault');
    const cred = vault.find((c) => c.id === undo.credId);
    if (!cred) return {};
    if (undo.created) {
      vault.splice(vault.indexOf(cred), 1);
    } else if (cred.history?.length) {
      cred.password = cred.history.shift().password;
      cred.updated = Date.now();
    }
    await saveSecret('vault', vault);
    return {};
  },

  async GET_CREDS(_msg, sender) {
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : sender.url;
    const site = PM.siteKey(new URL(origin).hostname);
    if (await isLocked()) return { creds: [], hint: '', locked: true };
    const vault = await loadSecret('vault');
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
    const master = await hasMaster();
    if (await isLocked()) return { master, locked: true, activity: await load('session', 'activity', []) };
    return {
      master,
      locked: false,
      vault: await loadSecret('vault'),
      review: await loadSecret('review'),
      activity: await load('session', 'activity', []),
    };
  },

  // Turns on encryption: re-saves the vault and review queue encrypted with a key from the password.
  async SET_MASTER({ password }) {
    if (await hasMaster()) return { error: 'A master password is already set.' };
    const vault = await loadSecret('vault');
    const review = await loadSecret('review');
    const kdf = PM.newKdfParams();
    const key = await PM.deriveKey(password, kdf);
    await save('session', 'key', await PM.exportKey(key));
    await save('local', 'kdf', kdf);
    await saveSecret('vault', vault);
    await saveSecret('review', review);
    await logActivity('Master password set. Your vault is now encrypted');
    return {};
  },

  async UNLOCK({ password }) {
    const kdf = await load('local', 'kdf', null);
    if (!kdf) return {};
    const key = await PM.deriveKey(password, kdf);
    const stored = await load('local', 'vault', []);
    try {
      if (PM.isEncrypted(stored)) await PM.decryptJson(key, stored);
    } catch {
      return { error: 'Wrong master password.' };
    }
    await save('session', 'key', await PM.exportKey(key));
    // Logins finished while locked get saved now.
    const pending = await load('session', 'lockedQueue', []);
    await save('session', 'lockedQueue', []);
    for (const item of pending) {
      if (item.attempt) await resolveAttempt(item.attempt, item.outcome);
      else await addReview(item.review, item.status);
    }
    await updateBadge();
    return { saved: pending.length };
  },

  async LOCK() {
    await chrome.storage.session.remove('key');
    await updateBadge();
    return {};
  },

  async SAVE_CRED({ cred, reviewId }) {
    if (cred.id) {
      const vault = await loadSecret('vault');
      const existing = vault.find((c) => c.id === cred.id);
      if (existing) {
        if (existing.password !== cred.password) {
          existing.history = [{ password: existing.password, replacedAt: Date.now() }, ...(existing.history || [])]
            .slice(0, HISTORY_LIMIT);
        }
        Object.assign(existing, { site: cred.site, username: cred.username, password: cred.password, updated: Date.now() });
        await saveSecret('vault', vault);
      }
    } else {
      await upsertCredential({ ...cred, kind: 'manual' });
    }
    if (reviewId) {
      const review = await loadSecret('review');
      await saveSecret('review', review.filter((r) => r.id !== reviewId));
    }
    await updateBadge();
    return {};
  },

  // Bulk import from a password-manager CSV export. Never overwrites: a saved login whose password
  // differs from the file's goes to review, since the file can't say which one is newer.
  async IMPORT({ creds }) {
    if (await isLocked()) return { error: 'Unlock Password Manager (click its toolbar icon) before importing.' };
    const vault = await loadSecret('vault');
    const counts = { added: 0, unchanged: 0, conflicts: 0 };
    const conflicts = [];
    for (const c of creds) {
      const existing = vault.find((v) => v.site === c.site && sameUser(v.username, c.username));
      if (!existing) {
        vault.push(newCredential(c, 'import'));
        counts.added++;
      } else if (existing.password === c.password) {
        counts.unchanged++;
      } else {
        conflicts.push(c);
        counts.conflicts++;
      }
    }
    await saveSecret('vault', vault);
    for (const c of conflicts) await addReview({ ...c, kind: 'import' }, 'import-conflict');
    return counts;
  },

  async DELETE_CRED({ id }) {
    const vault = await loadSecret('vault');
    await saveSecret('vault', vault.filter((c) => c.id !== id));
    return {};
  },

  async DISCARD_REVIEW({ id }) {
    const review = await loadSecret('review');
    await saveSecret('review', review.filter((r) => r.id !== id));
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
