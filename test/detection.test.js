import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SCRIPTS = ['src/shared/domain.js', 'src/content/fields.js', 'src/content/forms.js', 'src/content/outcome.js'];
const sources = SCRIPTS.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

// jsdom has no layout, so "visible" means connected, not type=hidden, and not inside [data-hidden].
function page(html, url = 'https://example.com/login', title = '') {
  const { window } = new JSDOM(`<!doctype html><title>${title}</title><body>${html}</body>`, { url, runScripts: 'outside-only' });
  for (const src of sources) window.eval(src);
  window.PM.isVisible = (el) => el.isConnected && el.type !== 'hidden' && !el.closest('[data-hidden]');
  return window;
}

function group(window, selector, { values } = {}) {
  const { PM, document } = window;
  for (const [sel, v] of Object.entries(values || {})) document.querySelector(sel).value = v;
  return PM.analyzeGroup(PM.findRoot(document.querySelector(selector)), { withValues: Boolean(values) });
}

const $ = (window, sel) => window.document.querySelector(sel);

test('classic login form', () => {
  const w = page(`
    <form><h1>Sign in</h1>
      <label for="e">Email</label><input id="e" type="email">
      <input id="p" type="password">
      <button>Sign in</button>
    </form>`);
  const g = group(w, '#p');
  assert.equal(g.kind, 'login');
  assert.equal(g.username, $(w, '#e'));
  assert.equal(g.current, $(w, '#p'));
});

test('formless login built from divs, with an unlabeled text username', () => {
  const w = page(`
    <div class="page"><div class="card">
      <div><input id="u" type="text" placeholder="Your handle"></div>
      <div><input id="p" type="password"></div>
      <div><button type="button">Log in</button></div>
    </div></div>`);
  const g = group(w, '#p');
  assert.equal(g.kind, 'login');
  assert.equal(g.username, $(w, '#u'));
});

test('generic text box is the username fallback', () => {
  const w = page(`<form><input id="u" name="f1"><input id="p" type="password"><button>Go</button></form>`);
  assert.equal(group(w, '#p').username, $(w, '#u'));
});

test('signup with confirm password', () => {
  const w = page(`
    <form><h2>Create your account</h2>
      <input name="first_name"><input id="e" name="email">
      <input id="p1" type="password" name="password">
      <input id="p2" type="password" name="password_confirmation">
      <button>Sign up</button>
    </form>`, 'https://example.com/join');
  const g = group(w, '#p1');
  assert.equal(g.kind, 'signup');
  assert.equal(g.username, $(w, '#e'));
  assert.equal(g.new, $(w, '#p1'));
  assert.equal(g.confirm, $(w, '#p2'));
});

test('signup with a single password field, recognized from the button and URL', () => {
  const w = page(`
    <form><input id="e" type="email"><input id="p" type="password"><button>Create account</button></form>`,
  'https://example.com/signup');
  const g = group(w, '#p');
  assert.equal(g.kind, 'signup');
  assert.equal(g.new, $(w, '#p'));
});

test('change password with current, new and confirm', () => {
  const w = page(`
    <form>
      <input id="a" type="password" name="old_password">
      <input id="b" type="password" name="new_password">
      <input id="c" type="password" name="new_password2">
      <button>Update password</button>
    </form>`, 'https://example.com/settings/security');
  const g = group(w, '#a');
  assert.equal(g.kind, 'change');
  assert.deepEqual([g.current, g.new, g.confirm], [$(w, '#a'), $(w, '#b'), $(w, '#c')]);
});

test('two unlabeled password boxes with different values on a settings page: old and new', () => {
  const w = page(`<form><input id="a" type="password"><input id="b" type="password"><button>Save</button></form>`,
    'https://example.com/settings');
  const g = group(w, '#a', { values: { '#a': 'old-secret', '#b': 'new-secret' } });
  assert.equal(g.kind, 'change');
  assert.equal(g.current, $(w, '#a'));
  assert.equal(g.new, $(w, '#b'));
});

test('password reset from an email link (no username)', () => {
  const w = page(`
    <form><h1>Choose a new password</h1>
      <input id="a" type="password"><input id="b" type="password"><button>Reset password</button>
    </form>`, 'https://example.com/reset-password/abc123');
  const g = group(w, '#a');
  assert.equal(g.kind, 'reset');
  assert.equal(g.new, $(w, '#a'));
  assert.equal(g.confirm, $(w, '#b'));
});

test('first step of a two-step login (email, then Next)', () => {
  const w = page(`
    <h1>Sign in</h1>
    <form><input id="e" type="email" name="identifier"><button>Next</button></form>`, 'https://accounts.example.com/');
  assert.equal(group(w, '#e').kind, 'username-step');
});

test('forgot-password email form is not mistaken for a login step', () => {
  const w = page(`<h1>Forgot your password?</h1><form><input id="e" type="email"><button>Send reset link</button></form>`,
    'https://example.com/forgot');
  assert.equal(group(w, '#e').kind, null);
});

test('newsletter email box elsewhere on a formless page is not picked as the username', () => {
  const w = page(`
    <div class="login">
      <input id="u" name="login">
      <input id="p" type="password">
      <button type="button">Sign in</button>
    </div>
    <footer><input id="n" type="email" name="newsletter_email"><button>Subscribe</button></footer>`);
  const g = group(w, '#p', { values: { '#u': 'jack', '#p': 'pw' } });
  assert.equal(g.username, $(w, '#u'));
});

test('email address label is a username, not an excluded address field', () => {
  const w = page(`<form><label>Email address <input id="e" name="f"></label><input id="p" type="password"><button>Log in</button></form>`);
  assert.equal(group(w, '#p').username, $(w, '#e'));
});

test('show-password toggle (type flips to text) keeps the field a password', () => {
  const w = page(`<form><input id="u" type="email"><input id="p" type="password"><button>Sign in</button></form>`);
  const pw = $(w, '#p');
  assert.equal(group(w, '#p').current, pw);
  pw.type = 'text';
  assert.equal(group(w, '#p').current, pw);
});

test('login inside an open shadow root', () => {
  const w = page(`<my-login id="host"></my-login>`);
  const host = $(w, '#host');
  host.attachShadow({ mode: 'open' }).innerHTML = `
    <div><input id="u" autocomplete="username"><input id="p" type="password"><button>Sign in</button></div>`;
  const pw = host.shadowRoot.querySelector('#p');
  const g = w.PM.analyzeGroup(w.PM.findRoot(pw));
  assert.equal(g.kind, 'login');
  assert.equal(g.username, host.shadowRoot.querySelector('#u'));
});

test('autocomplete=new-password on a login form (autofill blocker) is still a login', () => {
  const w = page(`<form><input id="u" name="username"><input id="p" type="password" autocomplete="new-password"><button>Log in</button></form>`);
  const g = group(w, '#p');
  assert.equal(g.kind, 'login');
  assert.equal(g.current, $(w, '#p'));
});

test('second step of a two-step login uses a hidden username field when it holds an email', () => {
  const w = page(`<form><input id="h" type="hidden" name="email"><input id="p" type="password"><button>Sign in</button></form>`);
  const g = group(w, '#p', { values: { '#h': 'me@example.com', '#p': 'pw' } });
  assert.equal(g.username, $(w, '#h'));
});

test('hidden field that is not an email is not used as the username', () => {
  const w = page(`<form><input id="h" type="hidden" name="account_id"><input id="p" type="password"><button>Sign in</button></form>`);
  const g = group(w, '#p', { values: { '#h': '8812734', '#p': 'pw' } });
  assert.equal(g.username, null);
});

test('password field already hidden by the site after submit still counts when it has a value', () => {
  const w = page(`<form><input id="u" type="email"><div data-hidden><input id="p" type="password"></div><button>Sign in</button></form>`);
  assert.equal(group(w, '#u').kind, 'username-step');
  const g = group(w, '#u', { values: { '#u': 'me@example.com', '#p': 'secret' } });
  assert.equal(g.kind, 'login');
});

test('one-time code page', () => {
  const w = page(`<form><input id="c" autocomplete="one-time-code"><button>Verify</button></form>`);
  assert.equal(group(w, '#c').kind, 'otp');
});

test('show-password and forgot buttons are not submit buttons', () => {
  const w = page(`<button id="a" type="button"></button><button id="b">Show password</button><button id="c">Forgot?</button><button id="d">Continue</button>`);
  const { PM } = w;
  assert.equal(PM.isNonSubmitButton($(w, '#a')), true);
  assert.equal(PM.isNonSubmitButton($(w, '#b')), true);
  assert.equal(PM.isNonSubmitButton($(w, '#c')), true);
  assert.equal(PM.isNonSubmitButton($(w, '#d')), false);
});

test('a clicked formless button finds its credential group', () => {
  const w = page(`<div><div><input id="u" type="email"><input id="p" type="password"></div><div><span><button id="b">Sign in</button></span></div></div>`);
  const root = w.PM.findRootForButton($(w, '#b'));
  assert.equal(w.PM.analyzeGroup(root).current, $(w, '#p'));
});

test('error messages that appear after submit are detected; pre-existing ones are not', () => {
  const w = page(`<form><input id="p" type="password"></form><div role="alert" id="old">Too many attempts, try again</div>`);
  const baseline = w.PM.visibleErrors();
  assert.equal(w.PM.pageState(baseline).newError, false);
  w.document.body.insertAdjacentHTML('beforeend', `<p class="form-error">Incorrect password.</p>`);
  const s = w.PM.pageState(baseline);
  assert.equal(s.newError, true);
  assert.equal(s.password, true);
});

test('siteKey groups subdomains under the registrable domain', () => {
  const { PM } = page('');
  assert.equal(PM.siteKey('login.example.com'), 'example.com');
  assert.equal(PM.siteKey('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(PM.siteKey('localhost'), 'localhost');
  assert.equal(PM.siteKey('192.168.1.10'), '192.168.1.10');
});

test('brand words inside a hostname do not count as context ("registerdisney" is a login host)', () => {
  const w = page(`<form><h2>Enter your password</h2><p>fan@x.com</p><input id="p" type="password"><button type="submit">Log In</button></form>`,
    'https://cdn.registerdisney.go.com/v4/bundle/web/ESPN-ONESITE.WEB/en-US');
  const g = group(w, '#p');
  assert.equal(g.kind, 'login');
  assert.equal(g.current, $(w, '#p'));
});

test('email-only step that uses autocomplete=email counts as a login step', () => {
  const w = page(`<form novalidate><h2>Enter your email to continue</h2><input id="e" type="email" autocomplete="email"><button type="submit">Continue</button></form>`,
    'https://cdn.registerdisney.go.com/v4/bundle/web/ESPN-ONESITE.WEB/en-US');
  assert.equal(group(w, '#e').kind, 'username-step');
});

test('autocomplete=current-password wins over a "confirmation" id (TurboTax password step)', () => {
  const w = page(`
    <form action="#"><p>Enter your Intuit password</p><p>fan@x.com</p>
      <input type="text" name="Email" autocomplete="username">
      <input id="iux-password-confirmation-password" type="password" name="Password" autocomplete="current-password">
      <button type="submit">Continue</button><button type="button">Text a code to (***) ***-**09</button>
    </form>`, 'https://myturbotax.intuit.com/', 'TurboTax® Login - Sign in to Get Started on Your Tax Return');
  const g = group(w, '#iux-password-confirmation-password');
  assert.equal(g.kind, 'login');
  assert.equal(g.current, $(w, '#iux-password-confirmation-password'));
});

test('identifier-first signup that shows the email as text (MyDisney "Create your account")', () => {
  const w = page(`
    <form><h1>Create your account</h1>
      <p>Choose a password to create your account using <b>fan@x.com</b> <a href="#">(edit)</a></p>
      <input placeholder="First Name" name="firstName"><input placeholder="Last Name" name="lastName">
      <input id="p" type="password" placeholder="Choose a password">
      <label><input type="checkbox"> Yes! Send me offers</label>
      <button type="submit">Agree &amp; Continue</button>
    </form>`, 'https://cdn.registerdisney.go.com/v4/bundle/web/ESPN-ONESITE.WEB/en-US');
  const g = group(w, '#p');
  assert.equal(g.kind, 'signup');
  assert.equal(g.username, null);
  assert.equal(g.new, $(w, '#p'));
});
