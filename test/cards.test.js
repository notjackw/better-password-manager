import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SCRIPTS = ['src/shared/domain.js', 'src/shared/cards.js', 'src/shared/profiles.js', 'src/content/fields.js',
  'src/content/forms.js', 'src/content/ui.js', 'src/content/cards.js', 'src/content/profiles.js', 'src/content/autofill.js'];
const sources = SCRIPTS.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

function page(html, url = 'https://shop.example.com/checkout') {
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only' });
  for (const src of sources) window.eval(src);
  window.PM.isVisible = (el) => el.isConnected && el.type !== 'hidden';
  window.PM.send = async () => null; // no background in tests
  return window;
}
const roles = (w) => Object.fromEntries(Object.entries(w.PM.cardFields()).map(([role, el]) => [role, el.id]));
const months = '<option value="">Month</option>' + Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${String(i + 1).padStart(2, '0')} - ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]}</option>`).join('');
const years = '<option value="">Year</option>' + [2026, 2027, 2028, 2029, 2030].map((y) => `<option value="${y}">${y}</option>`).join('');

const { PM } = page('');

test('card number checks and brands', () => {
  assert.equal(PM.luhnOk('4242 4242 4242 4242'), true);
  assert.equal(PM.luhnOk('4242 4242 4242 4241'), false);
  assert.equal(PM.luhnOk('1234'), false);
  assert.equal(PM.cardBrand('4111111111111111'), 'Visa');
  assert.equal(PM.cardBrand('5555555555554444'), 'Mastercard');
  assert.equal(PM.cardBrand('2223003122003222'), 'Mastercard');
  assert.equal(PM.cardBrand('378282246310005'), 'Amex');
  assert.equal(PM.cardBrand('6011111111111117'), 'Discover');
  assert.equal(PM.cardLabel({ number: '4242424242424242' }), 'Visa •••• 4242');
});

test('expiry parsing', () => {
  assert.deepEqual({ ...PM.parseExpiry('04/28') }, { month: '04', year: '2028' });
  assert.deepEqual({ ...PM.parseExpiry('4 / 2028') }, { month: '04', year: '2028' });
  assert.deepEqual({ ...PM.parseExpiry('0428') }, { month: '04', year: '2028' });
  assert.equal(PM.parseExpiry('13/28'), null);
  assert.equal(PM.normMonth('April'), '04');
  assert.equal(PM.normMonth('09 - Sep'), '09');
  assert.equal(PM.normYear('28'), '2028');
});

test('card form with autocomplete attributes', () => {
  const w = page(`<form>
    <input id="n" autocomplete="cc-name"><input id="c" autocomplete="cc-number">
    <input id="e" autocomplete="cc-exp"><input id="s" autocomplete="cc-csc"><button>Pay</button></form>`);
  assert.deepEqual(roles(w), { name: 'n', number: 'c', exp: 'e', csc: 's' });
});

test('MyChart-style card form: labels only, month and year dropdowns, billing ZIP', () => {
  const w = page(`<form>
    <label for="nm">Name on card</label><input id="nm" name="NameOnCard">
    <label for="cn">Card number</label><input id="cn" name="CardNumber" inputmode="numeric">
    <label for="mo">Expiration date</label><select id="mo" name="ExpMonth">${months}</select>
    <select id="yr" name="ExpYear" aria-label="Expiration year">${years}</select>
    <label for="cv">Security code</label><input id="cv" name="Cvv">
    <label for="zp">Billing ZIP code</label><input id="zp" name="BillingZip">
    <button>Continue</button></form>`);
  assert.deepEqual(roles(w), { name: 'nm', number: 'cn', month: 'mo', year: 'yr', csc: 'cv', zip: 'zp' });
});

test('a processor iframe with only an expiry field is still a card field', () => {
  const w = page('<input id="e" name="exp-date" placeholder="MM / YY">', 'https://js.stripe.com/v3/elements-inner-card');
  assert.deepEqual(roles(w), { exp: 'e' });
});

test('date of birth and shipping ZIP are not card fields', () => {
  const w = page(`<form>
    <select id="m" name="birthMonth">${months}</select><select id="y" name="birthYear">${years}</select>
    <input id="z" name="zip"><input id="x" name="express"><button>Save</button></form>`);
  assert.deepEqual(roles(w), {});
});

test('fill writes the number, a formatted expiry, dropdowns and name, but never the CVC', () => {
  const w = page(`<form>
    <input id="nm" autocomplete="cc-name"><input id="cn" autocomplete="cc-number">
    <select id="mo" name="ExpMonth" aria-label="Expiration month">${months}</select>
    <select id="yr" name="ExpYear" aria-label="Expiration year">${years}</select>
    <input id="cv" autocomplete="cc-csc"></form>`);
  w.PM.fillCard({ number: '4242424242424242', expMonth: '04', expYear: '2028', name: 'Jack W' });
  const v = (id) => w.document.getElementById(id).value;
  assert.deepEqual([v('nm'), v('cn'), v('mo'), v('yr'), v('cv')], ['Jack W', '4242424242424242', '4', '2028', '']);

  const w2 = page('<input id="e" autocomplete="cc-exp" placeholder="MM / YY"><input id="n" autocomplete="cc-number">');
  w2.PM.fillCard({ number: '4242424242424242', expMonth: '04', expYear: '2028' });
  assert.equal(w2.document.getElementById('e').value, '04 / 28');
});
