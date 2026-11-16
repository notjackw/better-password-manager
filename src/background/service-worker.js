// Background: owns the vault, tracks the in-flight login attempt per tab, and decides what gets saved.
//
// Flow: content script reports ATTEMPT on submit -> the page (or the next page, via HELLO) watches
// what happens -> OUTCOME success saves to the vault; failure/unknown goes to "Needs review" so a
// credential is never silently lost.
importScripts('../shared/domain.js', '../shared/vault-crypto.js', '../shared/sync-merge.js', '../shared/cards.js', '../shared/profiles.js');

const PM = globalThis.PM;
const ATTEMPT_TTL_MS = 2 * 60 * 1000;
const STEP_TTL_MS = 10 * 60 * 1000;
const RESET_STEP_TTL_MS = 30 * 60 * 1000; // forgot password -> emailed code -> new password can take a while
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
// Account first: nothing is saved until you sign in to (or create) a sync account, and its master
// password is the one that unlocks this computer. `vault` and `review` are stored encrypted
// ({ enc: 1, iv, data }) in chrome.storage.local, and the key lives only in chrome.storage.session:
// memory, never written to disk, gone when Chrome quits, and unreadable by content scripts.
// While signed out or locked, finished logins wait in session storage (`lockedQueue`) until you're in.

async function getKey() {
  const jwk = await load('session', 'key', null);
  return jwk ? PM.importKey(jwk) : null;
}

async function signedIn() {
  return Boolean(await load('local', 'sync', null));
}

async function isLocked() {
  return !(await signedIn()) || !(await load('session', 'key', null));
}

async function loadSecret(name) {
  const stored = await load('local', name, []);
  if (!PM.isEncrypted(stored)) return stored;
  const key = await getKey();
  if (!key) throw new Error('locked');
  return PM.decryptJson(key, stored);
}

async function writeSecret(name, value) {
  const key = await getKey();
  if (!key) throw new Error('locked');
  await save('local', name, await PM.encryptJson(key, value));
  if (name === 'review') await save('local', 'reviewCount', value.length); // so the badge works while locked
}

// Like writeSecret, but a vault change is also pushed to the sync server.
async function saveSecret(name, value) {
  await writeSecret(name, value);
  if (name === 'vault' || name === 'cards' || name === 'profiles') syncSoon();
}

// Derives the key for `password` and checks it against the stored vault. Returns null if it's wrong.
async function checkMaster(password) {
  const kdf = await load('local', 'kdf', null);
  if (!kdf) return null;
  const key = await PM.deriveKey(password, kdf);
  const stored = await load('local', 'vault', []);
  try {
    if (PM.isEncrypted(stored)) await PM.decryptJson(key, stored);
    return key;
  } catch {
    return null;
  }
}

async function queueWhileLocked(item) {
  const q = await load('session', 'lockedQueue', []);
  await save('session', 'lockedQueue', [...q, item]);
}

// Saves the logins that finished while signed out or locked. Returns how many there were.
async function drainLockedQueue() {
  const pending = await load('session', 'lockedQueue', []);
  await save('session', 'lockedQueue', []);
  for (const item of pending) {
    if (item.attempt) await resolveAttempt(item.attempt, item.outcome);
    else await addReview(item.review, item.status);
  }
  await updateBadge();
  return pending.length;
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

// ---- Sync ------------------------------------------------------------------------------------
//
// Optional account on the sync server (server/). The server gets the username, a login hash derived
// from the master password (PM.loginHash), and the vault encrypted with the same key as on disk.
// It never sees the master password or the vault key. Sync state, including the server's session
// token, lives in chrome.storage.local `sync`; deletions are kept as `tombstones` so they sync too.
//
// Unlocking is the only sign-in: it also keeps the login hash in session storage (memory), so if the
// server session ever ends, syncNow signs back in by itself. Changes are pushed ~1.5s after any save.
// Other devices hear about them over a WebSocket (/events) and pull right away; the alarm is the
// fallback, and reopens that socket if Chrome stopped the service worker.

const SYNC_PERIOD_MIN = 1;
const KEEPALIVE_MS = 20000; // a message every <30s keeps the MV3 service worker (and socket) alive

async function api(sync, method, path, body) {
  const res = await fetch(sync.server + path, {
    method,
    headers: { 'content-type': 'application/json', ...(sync.token && { authorization: `Bearer ${sync.token}` }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}

let syncTimer = null;
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => serial(syncNow), 1500);
}

async function failSync(sync, error) {
  await save('local', 'sync', { ...sync, error });
  return { error };
}

// A fresh server session using the login hash saved at unlock. Returns false if that isn't possible.
async function resignIn(sync) {
  const authHash = await load('session', 'loginHash', null);
  if (!authHash) return false;
  const res = await api(sync, 'POST', '/login', { username: sync.username, authHash });
  if (res.status !== 200) return false;
  sync.token = res.data.token;
  await save('local', 'sync', sync);
  connectEvents(sync);
  return true;
}

let events = null;
function connectEvents(sync) {
  if (!sync?.token) return;
  if (events && events.token === sync.token && events.ws.readyState <= WebSocket.OPEN) return;
  events?.ws.close();
  const ws = new WebSocket(`${sync.server.replace(/^http/, 'ws')}/events`);
  const keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), KEEPALIVE_MS);
  events = { ws, token: sync.token };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: sync.token }));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'changed') return;
    if (msg.revision !== (await load('local', 'sync', null))?.revision) serial(syncNow);
  };
  ws.onclose = () => {
    clearInterval(keepalive);
    if (events?.ws === ws) events = null;
  };
}

// Pull, merge, and push if the server is missing anything. A 409 means another device saved in
// between, so go around again with its newer copy.
async function syncNow() {
  const sync = await load('local', 'sync', null);
  if (!sync?.token || await isLocked()) return {};
  try {
    const key = await getKey();
    for (let tries = 0; tries < 3; tries++) {
      let got = await api(sync, 'GET', '/vault');
      if (got.status === 401 && await resignIn(sync)) got = await api(sync, 'GET', '/vault');
      if (got.status === 401) return failSync(sync, 'Signed out of the sync server. Lock and unlock to sign back in.');
      if (got.status !== 200) throw new Error(`server said ${got.status}`);

      let remote = { vault: [], cards: [], profiles: [], tombstones: [] };
      if (got.data.data) {
        try {
          remote = await PM.decryptJson(key, got.data.data);
        } catch {
          return failSync(sync, 'The server copy uses a different master password. Disconnect and sign in again.');
        }
      }
      const local = {
        vault: await loadSecret('vault'),
        cards: await loadSecret('cards'),
        profiles: await loadSecret('profiles'),
        tombstones: await load('local', 'tombstones', []),
      };
      const merged = PM.mergePayloads(local, remote);
      if (!PM.samePayload(merged, local)) {
        await writeSecret('vault', merged.vault);
        await writeSecret('cards', merged.cards);
        await writeSecret('profiles', merged.profiles);
        await save('local', 'tombstones', merged.tombstones);
      }
      if (got.data.data && PM.samePayload(merged, remote)) {
        sync.revision = got.data.revision;
        break;
      }
      const put = await api(sync, 'PUT', '/vault', { revision: got.data.revision, data: await PM.encryptJson(key, merged) });
      if (put.status === 409) continue;
      if (put.status !== 200) throw new Error(`server said ${put.status}`);
      sync.revision = put.data.revision;
      break;
    }
    await save('local', 'sync', { ...sync, lastSync: Date.now(), error: '' });
    connectEvents(sync);
    return {};
  } catch (err) {
    return failSync(sync, `Couldn't sync: ${err.message}`);
  }
}

async function addTombstone(id) {
  const tombstones = await load('local', 'tombstones', []);
  await save('local', 'tombstones', [...tombstones.filter((t) => t.id !== id), { id, at: Date.now() }]);
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
  // A login saved without a username (e.g. from a reset page) learns it the next time you sign in with it.
  if (!match && username) match = onSite.find((c) => !c.username && c.password === password);
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

// ---- Cards ----------------------------------------------------------------------------------
//
// Card fields report what's typed in them (CARD_FIELDS), per frame, and the background merges them
// per tab into a draft in session storage (memory only). When a pay button is pressed (CARD_SUBMIT),
// a complete, valid draft becomes a "Save this card?" toast; the card is only written to the vault
// if you click Save. Cards are { id, number, expMonth, expYear, name, zip, brand, created, updated }.

const CARD_DRAFT_TTL_MS = 30 * 60 * 1000;
const CARD_PROMPT_MS = 30000;

function mergeCardFields(draft, fields) {
  const d = { ...draft, ts: Date.now() };
  if (fields.number) d.number = fields.number;
  if (fields.exp) Object.assign(d, { month: fields.exp.month, year: fields.exp.year });
  if (fields.month) d.month = fields.month;
  if (fields.year) d.year = fields.year;
  if (fields.name) d.name = fields.name;
  if (fields.zip) d.zip = fields.zip;
  return d;
}

async function updateCardDraft(tabId, fields) {
  const drafts = await load('session', 'cardDrafts', {});
  const prev = drafts[tabId] && Date.now() - drafts[tabId].ts < CARD_DRAFT_TTL_MS ? drafts[tabId] : {};
  drafts[tabId] = mergeCardFields(prev, fields || {});
  await save('session', 'cardDrafts', drafts);
  return drafts[tabId];
}

async function takeCardDraft(tabId) {
  const drafts = await load('session', 'cardDrafts', {});
  const d = drafts[tabId];
  delete drafts[tabId];
  await save('session', 'cardDrafts', drafts);
  return d;
}

// ---- Profiles -------------------------------------------------------------------------------
//
// Same flow as cards: PROFILE_FIELDS from each frame merge into a per-tab draft, and PROFILE_SUBMIT
// offers to save it. Profiles are { id, name, email, phone, address1, address2, city, state, zip,
// country, created, updated }.

const PROFILE_KEYS = ['name', 'email', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'country'];
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sameAddress = (a, b) => Boolean(a.address1 && b.address1)
  && squash(a.address1) === squash(b.address1) && squash(a.zip).slice(0, 5) === squash(b.zip).slice(0, 5);

async function updateProfileDraft(tabId, fields) {
  const drafts = await load('session', 'profileDrafts', {});
  const prev = drafts[tabId] && Date.now() - drafts[tabId].ts < CARD_DRAFT_TTL_MS ? drafts[tabId] : {};
  drafts[tabId] = { ...prev, ...fields, ts: Date.now() };
  await save('session', 'profileDrafts', drafts);
  return drafts[tabId];
}

async function takeProfileDraft(tabId) {
  const drafts = await load('session', 'profileDrafts', {});
  delete drafts[tabId];
  await save('session', 'profileDrafts', drafts);
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
    const action = (await signedIn()) ? 'Unlock' : 'Sign in to';
    await notifyTab(a.tabId, { type: 'TOAST', text: `Login captured for ${a.site}. ${action} Password Manager to save it.` });
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
  async STEP_USERNAME({ username, site, forReset = false }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const steps = await load('session', 'steps', {});
    const prev = steps[tabId];
    steps[tabId] = { username, site, forReset, ts: Date.now() };
    await save('session', 'steps', steps);
    // One Continue click often fires both click and submit.
    if (!(prev && prev.username === username && prev.site === site && Date.now() - prev.ts < 5000)) {
      await logActivity(`Remembered ${username} from the ${forReset ? 'forgot-password' : 'email'} step on ${site}`);
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
    // the same site. A reset borrows only the account named on a forgot-password form in this same
    // tab and site (forgot password -> emailed code -> new password). A reset link opened from an
    // email lands in a new tab with no step, so it never picks up an unrelated username.
    if (!a.username && ['login', 'signup', 'reset'].includes(a.kind)) {
      const step = (await load('session', 'steps', {}))[tabId];
      if (a.kind === 'reset') {
        if (step?.forReset && step.site === a.site && now - step.ts < RESET_STEP_TTL_MS) a.username = step.username;
      } else if (step && now - step.ts < STEP_TTL_MS && (a.kind === 'login' || step.site === a.site)) {
        a.username = step.username;
      }
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
      await addTombstone(cred.id);
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
    const sync = await load('local', 'sync', null);
    if (await isLocked()) {
      return {
        signedIn: Boolean(sync),
        locked: true,
        username: sync?.username,
        server: await load('local', 'lastServer', ''),
        lastUsername: await load('local', 'lastUsername', ''),
        activity: await load('session', 'activity', []),
      };
    }
    return {
      signedIn: true,
      locked: false,
      vault: await loadSecret('vault'),
      cards: await loadSecret('cards'),
      profiles: await loadSecret('profiles'),
      review: await loadSecret('review'),
      activity: await load('session', 'activity', []),
      sync: publicSync(await load('local', 'sync', null)),
    };
  },

  async UNLOCK({ password }) {
    if (!(await signedIn())) return { error: 'Sign in first.' };
    const key = await checkMaster(password);
    if (!key) return { error: 'Wrong master password.' };
    await save('session', 'key', await PM.exportKey(key));
    await save('session', 'loginHash', await PM.loginHash(key, password));
    const saved = await drainLockedQueue();
    syncSoon();
    return { saved };
  },

  async LOCK() {
    await chrome.storage.session.remove(['key', 'loginHash']);
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
    if (await isLocked()) return { error: 'Sign in to or unlock Password Manager (click its toolbar icon) before importing.' };
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
    await addTombstone(id);
    await saveSecret('vault', vault.filter((c) => c.id !== id));
    return {};
  },

  // mode 'signup' creates the account; 'signin' fetches the account's salt and signs in. Either way the
  // account's master password becomes the one that unlocks this computer, and anything already here
  // (from before accounts) is merged with the server's copy. Failures carry a `code` for the popup:
  // no-account, taken, wrong-password, offline.
  async SIGN_IN({ mode, server, username, password }) {
    if (await signedIn()) return { error: 'Already signed in.' };
    const sync = { server: server.trim().replace(/\/+$/, ''), username: username.trim().toLowerCase() };
    if (!/^https?:\/\/[^/]+$/.test(sync.server)) return { error: 'The server address should look like http://localhost:8787.' };

    // Logins saved before accounts existed may be encrypted under this computer's old master password.
    let existing;
    try {
      existing = { vault: await loadSecret('vault'), cards: await loadSecret('cards'), profiles: await loadSecret('profiles'), review: await loadSecret('review') };
    } catch {
      const oldKey = await checkMaster(password);
      if (!oldKey) return { error: 'This computer has logins saved under a different master password. Sign in with that one.' };
      await save('session', 'key', await PM.exportKey(oldKey));
      existing = { vault: await loadSecret('vault'), cards: await loadSecret('cards'), profiles: await loadSecret('profiles'), review: await loadSecret('review') };
    }

    let created = false;
    let kdf, key, authHash;
    try {
      const pre = await api(sync, 'POST', '/prelogin', { username: sync.username });
      if (pre.status !== 200 && pre.status !== 404) return { error: pre.data?.error || `Server said ${pre.status}` };
      if (mode === 'signin' && pre.status === 404) {
        return { code: 'no-account', error: `There's no account named “${sync.username}” on this server. Check the spelling, or create one.` };
      }
      if (mode === 'signup' && pre.status === 200) {
        return { code: 'taken', error: `“${sync.username}” is already taken. If it's yours, sign in instead.` };
      }
      created = pre.status === 404;
      kdf = created ? PM.newKdfParams() : pre.data.kdf;
      key = await PM.deriveKey(password, kdf);
      authHash = await PM.loginHash(key, password);
      const res = created
        ? await api(sync, 'POST', '/register', { username: sync.username, authHash, kdf })
        : await api(sync, 'POST', '/login', { username: sync.username, authHash });
      if (res.status === 401) return { code: 'wrong-password', error: `Wrong master password for “${sync.username}”.` };
      if (res.status !== 200 && res.status !== 201) return { error: res.data?.error || `Server said ${res.status}` };
      sync.token = res.data.token;
    } catch {
      return { code: 'offline', error: `Can't reach the server at ${sync.server}. Is it running? (cd server && npm start)` };
    }

    await save('local', 'lastServer', sync.server);
    await save('local', 'lastUsername', sync.username);
    await save('session', 'key', await PM.exportKey(key));
    await save('session', 'loginHash', authHash);
    await save('local', 'kdf', kdf);
    await save('local', 'sync', sync);
    await writeSecret('vault', existing.vault);
    await writeSecret('cards', existing.cards);
    await writeSecret('profiles', existing.profiles);
    await writeSecret('review', existing.review);
    await chrome.alarms.create('sync', { periodInMinutes: SYNC_PERIOD_MIN });
    await logActivity(`${created ? 'Created account' : 'Signed in'} as ${sync.username}`);
    const saved = await drainLockedQueue();
    return { ...(await syncNow()), created, saved };
  },

  async SYNC_NOW() {
    return syncNow();
  },

  // Signing out removes the logins from this computer; they stay in the account. Pushes first so
  // nothing is lost, unless `force` (the user chose to sign out even though that push failed).
  async SIGN_OUT({ force }) {
    const sync = await load('local', 'sync', null);
    if (!sync) return {};
    if (!force && await isLocked()) return { error: 'Unlock first, so your latest changes can be uploaded.' };
    if (!force) {
      const res = await syncNow();
      if (res.error) return { error: `${res.error} Signing out now would lose changes not on the server yet.`, unsynced: true };
    }
    await api(sync, 'POST', '/logout').catch(() => {});
    events?.ws.close();
    await chrome.alarms.clear('sync');
    await chrome.storage.local.remove(['sync', 'vault', 'cards', 'profiles', 'review', 'reviewCount', 'kdf', 'tombstones']);
    await chrome.storage.session.remove(['key', 'loginHash', 'lockedQueue', 'cardDrafts', 'pendingCards', 'profileDrafts', 'pendingProfiles']);
    await logActivity(`Signed out of ${sync.username}`);
    await updateBadge();
    return {};
  },

  async CARD_FIELDS({ fields }, sender) {
    if (sender.tab?.id != null) await updateCardDraft(sender.tab.id, fields);
    return {};
  },

  // A pay/continue button was pressed somewhere in the tab. Offer to save the card if the fields
  // added up to a valid card that isn't saved yet (or update the expiry of one that is).
  async CARD_SUBMIT({ fields }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const d = await updateCardDraft(tabId, fields);
    if (!PM.luhnOk(d.number) || !d.month || !d.year) return {};
    await takeCardDraft(tabId);
    if (await isLocked()) {
      await notifyTab(tabId, { type: 'TOAST', text: 'Unlock Password Manager to save cards.' });
      return {};
    }
    const card = { number: d.number, expMonth: d.month, expYear: d.year, name: d.name || '', zip: d.zip || '' };
    const cards = await loadSecret('cards');
    const existing = cards.find((c) => c.number === card.number);
    if (existing) {
      if (existing.expMonth === card.expMonth && existing.expYear === card.expYear) return {};
      Object.assign(existing, { expMonth: card.expMonth, expYear: card.expYear, updated: Date.now() });
      await saveSecret('cards', cards);
      await notifyTab(tabId, { type: 'TOAST', text: `Updated the expiry of ${PM.cardLabel(existing)}` });
      return {};
    }
    const id = crypto.randomUUID();
    const pending = await load('session', 'pendingCards', {});
    pending[id] = { ...card, brand: PM.cardBrand(card.number), ts: Date.now() };
    await save('session', 'pendingCards', pending);
    await logActivity(`Card ${PM.cardLabel(pending[id])} entered on ${sender.tab.url ? PM.siteKey(new URL(sender.tab.url).hostname) : 'a page'}`);
    await notifyTab(tabId, {
      type: 'TOAST',
      text: `Save ${PM.cardLabel(pending[id])} to Password Manager?`,
      action: { label: 'Save card', message: { type: 'SAVE_CARD', pendingId: id } },
      duration: CARD_PROMPT_MS,
    });
    return {};
  },

  async SAVE_CARD({ pendingId, card }, sender) {
    if (await isLocked()) return { error: 'locked' };
    let c = card;
    if (pendingId) {
      const pending = await load('session', 'pendingCards', {});
      c = pending[pendingId];
      delete pending[pendingId];
      await save('session', 'pendingCards', pending);
    }
    if (!c || !PM.luhnOk(c.number)) return { error: 'Not a valid card number.' };
    const cards = await loadSecret('cards');
    const now = Date.now();
    const number = PM.cardDigits(c.number);
    const existing = cards.find((x) => x.id === c.id || x.number === number);
    const fields = { number, expMonth: c.expMonth, expYear: c.expYear, name: c.name || '', zip: c.zip || '', brand: PM.cardBrand(number) };
    if (existing) Object.assign(existing, fields, { updated: now });
    else cards.push({ id: crypto.randomUUID(), ...fields, created: now, updated: now });
    await saveSecret('cards', cards);
    await logActivity(`Saved card ${PM.cardLabel(fields)}`);
    if (sender.tab?.id != null) await notifyTab(sender.tab.id, { type: 'TOAST', text: `Saved ${PM.cardLabel(fields)}` });
    return {};
  },

  async GET_CARDS() {
    if (await isLocked()) return { cards: [], locked: true };
    const cards = await loadSecret('cards');
    return { cards: cards.map(({ id, number, brand, expMonth, expYear, name }) => ({ id, number: number.slice(-4), brand, expMonth, expYear, name })) };
  },

  // Sends the full card to every frame in the tab; each frame decides whether it may fill (cards.js).
  async FILL_CARD({ id, frameUrl }, sender) {
    if (await isLocked()) return {};
    const card = (await loadSecret('cards')).find((c) => c.id === id);
    if (!card) return {};
    if (sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'FILL_CARD_FIELDS', card, frameUrl }).catch(() => {});
    return { card };
  },

  // A card or profile field in a small iframe asks the top page to draw (or hide) the menu for it.
  async FRAME_MENU({ show, kind, frameUrl }, sender) {
    if (sender.tab?.id == null) return {};
    chrome.tabs.sendMessage(sender.tab.id, { type: 'FRAME_MENU', show, kind, frameUrl }, { frameId: 0 }).catch(() => {});
    return {};
  },

  async PROFILE_FIELDS({ fields }, sender) {
    if (sender.tab?.id != null) await updateProfileDraft(sender.tab.id, fields);
    return {};
  },

  // Continue/pay was pressed. A draft with an address that isn't saved yet becomes a "Save this
  // address?" toast. One that matches a saved profile just fills in that profile's blanks.
  async PROFILE_SUBMIT({ fields }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const d = await updateProfileDraft(tabId, fields);
    if (!d.address1 || !(d.zip || d.city) || !(d.name || d.email)) return {};
    await takeProfileDraft(tabId);
    if (await isLocked()) return {};
    const draft = Object.fromEntries(PROFILE_KEYS.filter((k) => d[k]).map((k) => [k, d[k]]));
    const profiles = await loadSecret('profiles');
    const existing = profiles.find((p) => sameAddress(p, draft));
    if (existing) {
      const blanks = PROFILE_KEYS.filter((k) => draft[k] && !existing[k]);
      if (blanks.length) {
        for (const k of blanks) existing[k] = draft[k];
        existing.updated = Date.now();
        await saveSecret('profiles', profiles);
      }
      return {};
    }
    const id = crypto.randomUUID();
    const pending = await load('session', 'pendingProfiles', {});
    pending[id] = { ...draft, ts: Date.now() };
    await save('session', 'pendingProfiles', pending);
    await notifyTab(tabId, {
      type: 'TOAST',
      text: `Save ${draft.address1} to Password Manager for next time?`,
      action: { label: 'Save address', message: { type: 'SAVE_PROFILE', pendingId: id } },
      duration: CARD_PROMPT_MS,
    });
    return {};
  },

  async SAVE_PROFILE({ pendingId, profile }, sender) {
    if (await isLocked()) return { error: 'locked' };
    let p = profile;
    if (pendingId) {
      const pending = await load('session', 'pendingProfiles', {});
      p = pending[pendingId];
      delete pending[pendingId];
      await save('session', 'pendingProfiles', pending);
    }
    if (!p || !PROFILE_KEYS.some((k) => p[k])) return { error: 'Fill in at least one field.' };
    const profiles = await loadSecret('profiles');
    const now = Date.now();
    const fields = Object.fromEntries(PROFILE_KEYS.map((k) => [k, String(p[k] || '').trim()]));
    fields.state = PM.normState(fields.state);
    fields.country = PM.normCountry(fields.country);
    const existing = profiles.find((x) => x.id === p.id);
    if (existing) Object.assign(existing, fields, { updated: now });
    else profiles.push({ id: crypto.randomUUID(), ...fields, created: now, updated: now });
    await saveSecret('profiles', profiles);
    await logActivity(`Saved profile ${PM.profileLabel(fields)}`);
    if (sender.tab?.id != null) await notifyTab(sender.tab.id, { type: 'TOAST', text: `Saved ${fields.address1 || PM.profileLabel(fields)}` });
    return {};
  },

  async GET_PROFILES() {
    if (await isLocked()) return { profiles: [], locked: true };
    return { profiles: await loadSecret('profiles') };
  },

  async FILL_PROFILE({ id, frameUrl }, sender) {
    if (await isLocked()) return {};
    const profile = (await loadSecret('profiles')).find((p) => p.id === id);
    if (!profile) return {};
    if (sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'FILL_PROFILE_FIELDS', profile, frameUrl }).catch(() => {});
    return { profile };
  },

  async DELETE_PROFILE({ id }) {
    const profiles = await loadSecret('profiles');
    await addTombstone(id);
    await saveSecret('profiles', profiles.filter((p) => p.id !== id));
    return {};
  },

  async DELETE_CARD({ id }) {
    const cards = await loadSecret('cards');
    await addTombstone(id);
    await saveSecret('cards', cards.filter((c) => c.id !== id));
    return {};
  },

  async DISCARD_REVIEW({ id }) {
    const review = await loadSecret('review');
    await saveSecret('review', review.filter((r) => r.id !== id));
    await updateBadge();
    return {};
  },
};

const publicSync = (sync) => sync && { server: sync.server, username: sync.username, lastSync: sync.lastSync, error: sync.error };

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
  if (alarm.name === 'sync') serial(syncNow);
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

// Whenever the service worker starts, reopen the live connection and keep the fallback alarm going.
load('local', 'sync', null).then(async (sync) => {
  if (!sync?.token) return;
  // Re-creating an existing alarm restarts its countdown, so only create it if it's missing.
  if (!(await chrome.alarms.get('sync'))) chrome.alarms.create('sync', { periodInMinutes: SYNC_PERIOD_MIN });
  connectEvents(sync);
});
