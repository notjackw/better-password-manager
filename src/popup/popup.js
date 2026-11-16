const PM = globalThis.PM;
const $ = (sel) => document.querySelector(sel);

const STATUS_TEXT = {
  generated: 'Generated password, sign-up not confirmed yet',
  unconfirmed: "Couldn't confirm the sign-in worked",
  failed: 'Sign-in looked like it failed',
  'which-account': 'Password changed, but which account?',
  'import-conflict': 'From your import file, but a different password is already saved',
};

let tab = null;
let site = '';
let editing = null; // { id?, reviewId? }
let editingCard = null; // id of the card being edited
let editingProfile = null; // id of the profile being edited
const PROFILE_INPUTS = ['name', 'email', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'country'];
let syncState = null;
let current = null; // the view on screen
let prefilled = false;

// Every background handler answers with an object, so no answer means the background is running older
// code than this popup (an unpacked extension's popup is read from disk each time, but the background
// keeps running until the extension is reloaded). Reload it so the two match again.
async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res !== undefined) return res;
  document.body.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'reloading',
    textContent: 'Password Manager was updated and is restarting. Click its icon again in a moment.',
  }));
  setTimeout(() => chrome.runtime.reload(), 1500);
  return new Promise(() => {}); // stop the caller here
}

async function sendToTab(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return undefined;
  }
}

function setStatus(text) {
  $('#status').textContent = text;
  $('#status').hidden = !text;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(label, onClick) {
  const b = el('button', { className: 'small', type: 'button', textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

function passwordLine(password) {
  const line = el('div', { className: 'entry-pw', textContent: '••••••••' });
  let shown = false;
  const toggle = button('Show', () => {
    shown = !shown;
    line.textContent = shown ? password : '••••••••';
    toggle.textContent = shown ? 'Hide' : 'Show';
  });
  return { line, toggle };
}

function copyButton(label, value) {
  const b = button(label, async () => {
    await navigator.clipboard.writeText(value);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = label; }, 1200);
  });
  return b;
}

function renderReview(review) {
  $('#review-section').hidden = !review.length;
  $('#review').replaceChildren(...review.map((r) => {
    const { line, toggle } = passwordLine(r.password);
    return el('li', { className: r.site === site ? 'here' : '' },
      el('div', { className: 'entry-site', textContent: r.site }),
      el('div', { className: 'entry-user', textContent: r.username || '(no username)' }),
      line,
      el('div', { className: 'entry-status', textContent: STATUS_TEXT[r.status] || r.status }),
      el('div', { className: 'entry-buttons' },
        button('Save…', () => openEditor({ site: r.site, username: r.username, password: r.password }, { reviewId: r.id })),
        toggle,
        copyButton('Copy password', r.password),
        button('Discard', async () => {
          await send({ type: 'DISCARD_REVIEW', id: r.id });
          refresh();
        })));
  }));
}

function renderVault(vault) {
  const q = $('#search').value.trim().toLowerCase();
  const isHere = (c) => c.site === site || (c.seenOn || []).includes(site);
  const items = vault
    .filter((c) => !q || [c.site, ...(c.seenOn || []), c.username || ''].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => Number(isHere(b)) - Number(isHere(a)) || a.site.localeCompare(b.site));
  $('#empty').hidden = vault.length > 0;
  $('#vault').replaceChildren(...items.map((c) => {
    const { line, toggle } = passwordLine(c.password);
    let armed = false;
    const del = button('Delete', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Really delete?';
        return;
      }
      await send({ type: 'DELETE_CRED', id: c.id });
      refresh();
    });
    const usedOn = c.seenOn?.length ? ` · used on ${c.seenOn.join(', ')}` : '';
    return el('li', { className: isHere(c) ? 'here' : '' },
      el('div', { className: 'entry-top' },
        el('div', { className: 'entry-site', textContent: c.site + usedOn })),
      el('div', { className: 'entry-user', textContent: c.username || '(no username)' }),
      line,
      el('div', { className: 'entry-buttons' },
        copyButton('Copy password', c.password),
        c.username ? copyButton('Copy username', c.username) : '',
        toggle,
        button('Edit', () => openEditor(c, { id: c.id })),
        del));
  }));
}

function renderActivity(activity) {
  $('#activity-empty').hidden = activity.length > 0;
  $('#activity').replaceChildren(...activity.map((a) => el('li', {},
    el('time', { textContent: new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
    ` ${a.text}`)));
}

// Signed out, the popup shows one of these; signed in, it's 'lists', 'editor', 'account' or 'unlock'.
const AUTH_VIEWS = ['welcome', 'signin', 'signup'];

function show(view) {
  for (const id of ['lists', 'editor', 'card-editor', 'profile-editor', 'unlock', 'account', ...AUTH_VIEWS]) $(`#${id}`).hidden = id !== view;
  current = view;
  const auth = AUTH_VIEWS.includes(view);
  $('header').hidden = auth || view === 'unlock';
  $('#server-box').hidden = !auth;
}

async function refresh() {
  const state = await send({ type: 'GET_STATE' });
  $('#lock').hidden = state.locked;
  $('footer').hidden = !state.signedIn;
  renderActivity(state.activity);
  if (!state.signedIn) {
    syncState = null;
    if (!prefilled) {
      prefilled = true;
      if (state.server) $('#server').value = state.server;
      $('#in-username').value = state.lastUsername || '';
    }
    $('#server-label').textContent = $('#server').value;
    if (!AUTH_VIEWS.includes(current)) goTo(state.lastUsername ? 'signin' : 'welcome');
    return;
  }
  if (state.locked) {
    $('#unlock-user').textContent = state.username;
    show('unlock');
    $('#u-password').focus();
    return;
  }
  syncState = state.sync;
  $('#open-sync').textContent = state.sync?.error ? 'Account ⚠' : 'Account';
  renderAccount();
  renderReview(state.review);
  renderVault(state.vault);
  renderCards(state.cards || []);
  renderProfiles(state.profiles || []);
}

function renderProfiles(profiles) {
  $('#profiles-empty').hidden = profiles.length > 0;
  $('#profiles').replaceChildren(...profiles.map((p) => {
    let armed = false;
    const del = button('Delete', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Really delete?';
        return;
      }
      await send({ type: 'DELETE_PROFILE', id: p.id });
      refresh();
    });
    const lines = [p.address1, p.address2, [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')]
      .filter(Boolean).join('\n');
    return el('li', {},
      el('div', { className: 'entry-site', textContent: PM.profileLabel(p) }),
      el('div', { className: 'entry-user profile-lines', textContent: lines }),
      el('div', { className: 'entry-user', textContent: [p.email, p.phone].filter(Boolean).join(' · ') }),
      el('div', { className: 'entry-buttons' }, button('Edit', () => openProfileEditor(p)), del));
  }));
}

function openProfileEditor(p = null) {
  editingProfile = p?.id || null;
  $('#profile-editor-title').textContent = p ? 'Edit address' : 'Add address';
  for (const k of PROFILE_INPUTS) $(`#pf-${k}`).value = p ? p[k] || '' : k === 'country' ? 'US' : '';
  setError('#profile-error', '');
  show('profile-editor');
  $('#pf-name').focus();
}

function renderCards(cards) {
  $('#cards-empty').hidden = cards.length > 0;
  $('#cards').replaceChildren(...cards.map((c) => {
    const masked = PM.cardLabel(c);
    const line = el('div', { className: 'entry-pw', textContent: masked });
    let shown = false;
    const toggle = button('Show', () => {
      shown = !shown;
      line.textContent = shown ? c.number.replace(/(\d{4})(?=\d)/g, '$1 ') : masked;
      toggle.textContent = shown ? 'Hide' : 'Show';
    });
    let armed = false;
    const del = button('Delete', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Really delete?';
        return;
      }
      await send({ type: 'DELETE_CARD', id: c.id });
      refresh();
    });
    return el('li', {},
      el('div', { className: 'entry-site', textContent: c.brand || PM.cardBrand(c.number) }),
      line,
      el('div', { className: 'entry-user', textContent: [`Exp ${c.expMonth}/${c.expYear.slice(-2)}`, c.name].filter(Boolean).join(' · ') }),
      el('div', { className: 'entry-buttons' },
        copyButton('Copy number', c.number),
        toggle,
        button('Edit', () => openCardEditor(c)),
        del));
  }));
}

function openCardEditor(c = null) {
  editingCard = c?.id || null;
  $('#card-editor-title').textContent = c ? 'Edit card' : 'Add card';
  $('#c-number').value = c?.number || '';
  $('#c-exp').value = c ? `${c.expMonth}/${c.expYear.slice(-2)}` : '';
  $('#c-name').value = c?.name || '';
  $('#c-zip').value = c?.zip || '';
  setError('#card-error', '');
  show('card-editor');
  $('#c-number').focus();
}

// Shows a view and puts the cursor in its first empty field.
function goTo(view) {
  show(view);
  const inputs = [...$(`#${view}`).querySelectorAll('input')];
  (inputs.find((i) => !i.value) || inputs[0])?.focus();
}

function renderAccount() {
  const s = syncState;
  if (!s) return;
  $('#acct-user').textContent = s.username;
  $('#acct-server').textContent = s.server;
  $('#acct-last').textContent = s.lastSync ? `Last synced ${new Date(s.lastSync).toLocaleString()}` : 'Not synced yet';
  setError('#acct-error', s.error || '');
  $('#sign-out').textContent = 'Sign out';
}

function openEditor(values, meta = {}) {
  editing = meta;
  $('#editor-title').textContent = meta.id ? 'Edit login' : meta.reviewId ? 'Save login' : 'Add login';
  $('#f-site').value = values.site || site;
  $('#f-username').value = values.username || '';
  $('#f-password').value = values.password || '';
  show('editor');
  $('#f-username').focus();
}

function closeEditor() {
  editing = null;
  show('lists');
}

$('#editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const siteValue = $('#f-site').value.trim().toLowerCase();
  const cred = {
    id: editing?.id,
    site: PM.siteKey(siteValue.replace(/^\w+:\/\//, '').split('/')[0]),
    origin: '',
    username: $('#f-username').value.trim(),
    password: $('#f-password').value,
  };
  await send({ type: 'SAVE_CRED', cred, reviewId: editing?.reviewId });
  closeEditor();
  refresh();
});

$('#cancel').addEventListener('click', closeEditor);

function setError(sel, text) {
  $(sel).textContent = text;
  $(sel).hidden = !text;
}

$('#unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('#unlock-error', '');
  const button = $('#unlock button');
  button.disabled = true;
  button.textContent = 'Unlocking…';
  const res = await send({ type: 'UNLOCK', password: $('#u-password').value });
  button.disabled = false;
  button.textContent = 'Unlock';
  if (res?.error) return setError('#unlock-error', res.error);
  $('#u-password').value = '';
  show('lists');
  if (res?.saved) setStatus(`Saved ${res.saved} login${res.saved > 1 ? 's' : ''} captured while locked.`);
  refresh();
});

$('#open-sync').addEventListener('click', () => {
  renderAccount();
  show('account');
});
for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', () => {
    setError('#signin-error', '');
    setError('#signup-error', '');
    goTo(b.dataset.go);
  });
}
$('#server').addEventListener('input', () => { $('#server-label').textContent = $('#server').value; });

async function authenticate(mode, form, username, password, errorSel) {
  setError(errorSel, '');
  const submit = form.querySelector('button[type=submit]');
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
  const res = await send({ type: 'SIGN_IN', mode, server: $('#server').value, username, password });
  submit.disabled = false;
  submit.textContent = label;
  if (!(await send({ type: 'GET_STATE' })).signedIn) {
    setError(errorSel, res?.error || 'Something went wrong. Try again.');
    if (res?.code === 'offline') $('#server-box').open = true;
    return;
  }
  for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
  show('lists');
  const caught = res.saved ? ` Saved ${res.saved} login${res.saved > 1 ? 's' : ''} captured before you signed in.` : '';
  setStatus(`${mode === 'signup' ? 'Account created.' : 'Signed in.'}${caught}${res.error ? ` ${res.error}` : ''}`);
  refresh();
}

$('#signin').addEventListener('submit', (e) => {
  e.preventDefault();
  authenticate('signin', $('#signin'), $('#in-username').value, $('#in-password').value, '#signin-error');
});

$('#signup').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('#up-password').value !== $('#up-confirm').value) return setError('#signup-error', "The two passwords don't match.");
  authenticate('signup', $('#signup'), $('#up-username').value, $('#up-password').value, '#signup-error');
});

$('#sync-now').addEventListener('click', async () => {
  $('#sync-now').disabled = true;
  await send({ type: 'SYNC_NOW' });
  $('#sync-now').disabled = false;
  await refresh();
  show('account');
});

// If the final upload fails, the button turns into "Sign out anyway".
$('#sign-out').addEventListener('click', async () => {
  const force = $('#sign-out').textContent === 'Sign out anyway';
  const res = await send({ type: 'SIGN_OUT', force });
  if (res?.error) {
    setError('#acct-error', res.error);
    if (res.unsynced) $('#sign-out').textContent = 'Sign out anyway';
    return;
  }
  setStatus('');
  refresh();
});

// Locked with a forgotten password, or someone else's account: sign out without unlocking. Changes not
// uploaded yet are lost, so it takes a second click.
$('#unlock-switch').addEventListener('click', async () => {
  const b = $('#unlock-switch');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = 'Sign out? Changes not uploaded yet will be lost. Click again';
    return;
  }
  await send({ type: 'SIGN_OUT', force: true });
  b.dataset.armed = '';
  b.textContent = 'Use a different account';
  refresh();
});

$('#lock').addEventListener('click', async () => {
  await send({ type: 'LOCK' });
  refresh();
});
$('#add').addEventListener('click', () => openEditor({}));
$('#add-card').addEventListener('click', () => openCardEditor());
$('#add-profile').addEventListener('click', () => openProfileEditor());

$('#profile-editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const profile = { id: editingProfile };
  for (const k of PROFILE_INPUTS) profile[k] = $(`#pf-${k}`).value.trim();
  const res = await send({ type: 'SAVE_PROFILE', profile });
  if (res?.error) return setError('#profile-error', res.error);
  show('lists');
  refresh();
});

$('#card-editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const number = PM.cardDigits($('#c-number').value);
  const exp = PM.parseExpiry($('#c-exp').value);
  if (!PM.luhnOk(number)) return setError('#card-error', "That card number doesn't look right.");
  if (!exp) return setError('#card-error', 'Enter the expiry as MM/YY.');
  const card = { id: editingCard, number, expMonth: exp.month, expYear: exp.year, name: $('#c-name').value.trim(), zip: $('#c-zip').value.trim() };
  const res = await send({ type: 'SAVE_CARD', card });
  if (res?.error) return setError('#card-error', res.error);
  show('lists');
  refresh();
});
$('#search').addEventListener('input', refresh);

$('#fill').addEventListener('click', async () => {
  const res = await sendToTab({ type: 'FILL_BEST' });
  if (res?.filled) window.close();
  else setStatus(site ? `No saved login for ${site} matches a field on this page.` : 'Nothing to fill on this page.');
});

$('#grab').addEventListener('click', async () => {
  const res = await sendToTab({ type: 'CAPTURE_PAGE' });
  if (res?.creds) openEditor(res.creds);
  else setStatus('No filled-in login fields found. Type your username and password into the page first.');
});

$('#debug').addEventListener('click', async () => {
  const res = await sendToTab({ type: 'TOGGLE_DEBUG' });
  if (!res) return setStatus('Reload this page so the extension can see it.');
  $('#debug').textContent = res.enabled ? 'Hide field highlights' : 'Highlight detected fields';
});

// A file picker would close the popup on macOS before the file is read, so import runs in a tab.
$('#import').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/import/import.html') });
  window.close();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  site = url && /^https?:$/.test(url.protocol) ? PM.siteKey(url.hostname) : '';
  $('#site').textContent = site || 'No website in this tab';
  refresh();
})();
