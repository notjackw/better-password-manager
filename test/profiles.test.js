import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SCRIPTS = ['src/shared/domain.js', 'src/shared/cards.js', 'src/shared/profiles.js', 'src/content/fields.js',
  'src/content/forms.js', 'src/content/ui.js', 'src/content/cards.js', 'src/content/profiles.js', 'src/content/autofill.js'];
const sources = SCRIPTS.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

function page(html, url = 'https://secondwave.example.com/checkout', { framed = false } = {}) {
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only' });
  if (framed) window.PM = { inSubframe: () => true };
  for (const src of sources) window.eval(src);
  window.PM.isVisible = (el) => el.isConnected && el.type !== 'hidden';
  window.PM.send = async () => null;
  return window;
}
const roles = (w) => [...w.PM.profileFields()].map((f) => `${f.role}:${f.el.id}`);

const FAHERTY = `
  <form><h3>Contact</h3>
    <label for="name-input">Full Name (first and last)</label><input id="name-input" name="name" type="text">
    <label for="email-input">Email</label><input id="email-input" name="email" type="text">
    <input type="hidden" name="address_line_1"><button type="button">Continue to payment</button></form>
  <footer><form><input id="news" name="email" placeholder="Email address" aria-label="Email"><button>Sign up</button></form></footer>`;

const { PM } = page('');

test('states, countries and names', () => {
  assert.equal(PM.normState('massachusetts'), 'MA');
  assert.equal(PM.normState('ma'), 'MA');
  assert.equal(PM.normCountry('United States of America'), 'US');
  assert.ok(PM.stateMatches('MA', 'Massachusetts'));
  assert.deepEqual({ ...PM.splitName('Jack R Williams') }, { given: 'Jack R', family: 'Williams' });
});

test('Faherty checkout: full name and email are a profile form; the footer newsletter box is not', () => {
  assert.deepEqual(roles(page(FAHERTY)), ['name:name-input', 'email:email-input']);
});

test('a lone email box (newsletter, login step) is not a profile form', () => {
  assert.deepEqual(roles(page('<form><input id="e" type="email" name="email"><button>Sign up</button></form>')), []);
});

test('Stripe-style address iframe: one address field is enough inside a frame', () => {
  const w = page(`
    <select id="country" autocomplete="shipping country"><option value="US">United States</option></select>
    <input id="line1" name="addressLine1" autocomplete="shipping address-line1">
    <input id="city" name="locality"><select id="state" name="administrativeArea"><option value="MA">Massachusetts</option></select>
    <input id="zip" name="postalCode">`, 'https://js.stripe.com/v3/elements-inner-address', { framed: true });
  assert.deepEqual(roles(w), ['country:country', 'address1:line1', 'city:city', 'state:state', 'zip:zip']);
});

test('classic shipping form with first/last name, phone and labels', () => {
  const w = page(`<form>
    <label for="f">First name</label><input id="f"><label for="l">Last name</label><input id="l">
    <label for="a1">Street address</label><input id="a1"><label for="a2">Apt / Suite</label><input id="a2">
    <label for="c">City</label><input id="c"><label for="s">State</label><input id="s">
    <label for="z">ZIP code</label><input id="z"><label for="p">Phone</label><input id="p" type="tel">
    <label for="promo">Promo code</label><input id="promo"><button>Continue</button></form>`);
  assert.deepEqual(roles(w), ['given:f', 'family:l', 'address1:a1', 'address2:a2', 'city:c', 'state:s', 'zip:z', 'tel:p']);
});

test('card fields stay card fields, not profile fields', () => {
  const w = page(`<form>
    <input id="nm" autocomplete="cc-name"><input id="cn" autocomplete="cc-number">
    <label for="zp">Billing ZIP</label><input id="zp"><label for="em">Email</label><input id="em" type="email">
    <button>Pay</button></form>`);
  assert.deepEqual(roles(w), []);
});

test('fill splits the name for first/last boxes, picks dropdown options, and never overwrites', async () => {
  const w = page(`<form>
    <label for="f">First name</label><input id="f"><label for="l">Last name</label><input id="l" value="Typed">
    <label for="a1">Address</label><input id="a1">
    <label for="s">State</label><select id="s"><option value="">--</option><option value="Massachusetts">Massachusetts</option></select>
    <button>Continue</button></form>`);
  await w.PM.fillProfile({ name: 'Jack Williams', address1: '1 Main St', state: 'MA' });
  const v = (id) => w.document.getElementById(id).value;
  assert.deepEqual([v('f'), v('l'), v('a1'), v('s')], ['Jack', 'Typed', '1 Main St', 'Massachusetts']);
});

// Faherty with items in the bag: every field has data-testid="AddressForm-…", the address box is a
// type=search Google Places field, and State is a Material UI dropdown (hidden input + listbox button).
const FAHERTY_SHIPPING = `<form>
  <label for="name-input">Full Name (first and last)</label><input id="name-input" name="name" data-testid="AddressForm-name">
  <label for="a1">Address</label><input id="a1" type="search" aria-label="Address" data-testid="AddressForm-address_line_1">
  <label for="city">City</label><input id="city" name="locality" data-testid="AddressForm-locality">
  <div><label id="st-label">State</label>
    <div role="button" aria-haspopup="listbox" aria-labelledby="st-label" id="st-button"></div>
    <input id="st" name="administrative_area" aria-hidden="true" tabindex="-1" data-testid="AddressForm-administrative_area"></div>
  <label for="zip">Zip</label><input id="zip" name="postal_code" data-testid="AddressForm-postal_code">
  <label for="email-input">Email</label><input id="email-input" name="email">
  <button>Place order</button></form>`;

test('Faherty shipping form: test ids don\'t turn every field into an address line', () => {
  const w = page(FAHERTY_SHIPPING);
  assert.deepEqual(roles(w), ['name:name-input', 'address1:a1', 'city:city', 'state:st', 'zip:zip', 'email:email-input']);
});

test('a Material UI state dropdown is filled by opening it and clicking the option', async () => {
  const w = page(FAHERTY_SHIPPING);
  const d = w.document;
  d.getElementById('st-button').addEventListener('mousedown', () => {
    if (d.querySelector('[role=listbox]')) return;
    d.body.insertAdjacentHTML('beforeend', '<ul role="listbox"><li role="option" data-value="CA">California</li><li role="option" data-value="MA">Massachusetts</li></ul>');
    for (const o of d.querySelectorAll('[role=option]')) o.addEventListener('click', () => { d.getElementById('st').value = o.dataset.value; });
  });
  await w.PM.fillProfile({ name: 'Jack Williams', address1: '1 Main St', city: 'Boston', state: 'MA', zip: '02114', email: 'j@x.com' });
  const v = (id) => d.getElementById(id).value;
  assert.deepEqual(['name-input', 'a1', 'city', 'st', 'zip', 'email-input'].map(v), ['Jack Williams', '1 Main St', 'Boston', 'MA', '02114', 'j@x.com']);
});

test('OpenWeb sign-up (Lifehacker comments): a "Name" box named username still counts as a name', () => {
  const w = page(`<form>
    <label for="name">Name</label><input id="name" data-testid="username">
    <label for="email-address">Email Address</label><input id="email-address" type="email">
    <label for="password">Password</label><input id="password" type="password">
    <button>Create Account</button></form>`, 'https://lifehacker.com/tech/x');
  assert.deepEqual(roles(w), ['name:name', 'email:email-address']);
});
