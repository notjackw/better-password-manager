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

const send = (msg) => chrome.runtime.sendMessage(msg);

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

// Which part of the popup is showing: 'lists', 'editor', 'unlock' or 'master'.
function show(view) {
  for (const id of ['lists', 'editor', 'unlock', 'master']) $(`#${id}`).hidden = id !== view;
  $('header').hidden = view === 'unlock';
}

async function refresh() {
  const state = await send({ type: 'GET_STATE' });
  $('#lock').hidden = !state.master || state.locked;
  $('#set-master').hidden = state.master;
  renderActivity(state.activity);
  if (state.locked) {
    show('unlock');
    $('#u-password').focus();
    return;
  }
  renderReview(state.review);
  renderVault(state.vault);
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

$('#set-master').addEventListener('click', () => {
  show('master');
  $('#m-password').focus();
});
$('#master-cancel').addEventListener('click', () => show('lists'));

$('#master').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#m-password').value !== $('#m-confirm').value) return setError('#master-error', "The two passwords don't match.");
  setError('#master-error', '');
  const res = await send({ type: 'SET_MASTER', password: $('#m-password').value });
  if (res?.error) return setError('#master-error', res.error);
  $('#m-password').value = $('#m-confirm').value = '';
  show('lists');
  setStatus('Your logins are now encrypted.');
  refresh();
});

$('#lock').addEventListener('click', async () => {
  await send({ type: 'LOCK' });
  refresh();
});
$('#add').addEventListener('click', () => openEditor({}));
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
