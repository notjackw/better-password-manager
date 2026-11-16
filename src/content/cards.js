// Payment cards: recognizes card fields, including when a payment processor puts them in its own
// iframe (often one iframe per field), offers to save the card after a payment is submitted, and fills
// a saved card into the card fields of every frame in the tab.
//
// Each frame reports its card fields' values to the background when they change; the background
// merges them per tab, so a number in one iframe and an expiry in another still make one card.
// The CVC is never read or saved.
(() => {
  const PM = (globalThis.PM ||= {});

  // All patterns run against normalized text (PM.norm). Order matters: see classify().
  const RE = {
    csc: /\bcvv|\bcvc|\bcsc\b|\bcid\b|security (code|number)|card ?code|verification (code|number|value)|card ?verif/,
    exp: /\bexp(iry|iration|ires?|date)?\b|valid (thru|through|until)|good thru|\bmm ?yy/,
    month: /month|\bmm\b/,
    year: /year|\byy(yy)?\b/,
    name: /name on (the )?card|card ?holder|holder ?name|\bcard ?name|name as (it )?appears|\bcc ?name/,
    number: /card ?(number|num|no\b|#)|\bcc ?(number|num|no\b)|\bccn\b|credit ?card|debit ?card|\bpan\b|^card$/,
    zip: /\bzip|postal|post ?code/,
  };
  const AC = {
    'cc-number': 'number', 'cc-exp': 'exp', 'cc-exp-month': 'month', 'cc-exp-year': 'year',
    'cc-csc': 'csc', 'cc-name': 'name', 'cc-given-name': 'name', 'postal-code': 'zip',
  };
  const PAY_BUTTON_RE = /\bpay|payment|submit|place (your )?order|purchase|\bbuy\b|check ?out|confirm|complete|donate|continue|\bnext\b|review|\bsave\b|authorize|process/;
  // Origins allowed to receive a saved card when it isn't the page's own site.
  const PROCESSOR_RE = /(^|\.)(stripe\.com|stripe\.network|braintreegateway\.com|braintree-api\.com|adyen\.com|adyenpayments\.com|paypal\.com|squareup\.com|squarecdn\.com|checkout\.com|authorize\.net|paymetric\.com|xisecurenet\.com|instamed\.com|cybersource\.com|worldpay\.com|paymentech\.com|chasepaymentech\.com|elavon\.com|convergepay\.com|heartlandpaymentsystems\.com|globalpay\.com|globalpayments\.com|tsys\.com|cardconnect\.com|spreedly\.com|recurly\.com|chargebee\.com|paya\.com|payeezy\.com|firstdata\.com|clover\.com|nmi\.com|bluepay\.com|repay\.com|payrix\.com|paymentus\.com|epicpay\.com|trustcommerce\.com|usaepay\.com)$/;

  const isSelect = (el) => el.tagName === 'SELECT';

  // What a <select>'s options look like: 'month' (1–12 or month names), 'year' (20xx) or null.
  function selectKind(el) {
    const opts = [...el.options];
    // Two-digit years are told apart from months by being over 12 ("26", "27", ...).
    const isYear = (o) => /\b20\d\d\b/.test(`${o.value} ${o.textContent}`) || (/^\d{2}$/.test(o.value.trim()) && Number(o.value) > 12);
    if (opts.filter(isYear).length >= 3) return 'year';
    if (opts.filter((o) => PM.normMonth(o.value) || PM.normMonth(o.textContent)).length >= 12) return 'month';
    return null;
  }

  // Returns { role, strong } or null. Strong roles count as card fields on their own; weak ones (a
  // bare "month" or "zip") only when the same frame also has a strong card field.
  function classify(el) {
    if (!(el?.tagName === 'INPUT' || isSelect(el))) return null;
    if (el.tagName === 'INPUT' && !['text', 'tel', 'number', 'password', ''].includes(el.type)) return null;
    for (const t of PM.acTokens(el)) if (AC[t]) return { role: AC[t], strong: AC[t] !== 'zip' };
    const sig = PM.fieldSignals(el);
    if (RE.csc.test(sig)) return { role: 'csc', strong: true };
    const sel = isSelect(el) ? selectKind(el) : null;
    if (RE.exp.test(sig) || sel) {
      if (sel === 'month' || (RE.month.test(sig) && !RE.year.test(sig))) return { role: 'month', strong: RE.exp.test(sig) };
      if (sel === 'year' || (RE.year.test(sig) && !RE.month.test(sig))) return { role: 'year', strong: RE.exp.test(sig) };
      if (RE.exp.test(sig) && !isSelect(el)) return { role: 'exp', strong: true };
    }
    if (RE.name.test(sig)) return { role: 'name', strong: true };
    if (isSelect(el)) return null;
    if (RE.number.test(sig)) return { role: 'number', strong: true };
    if (RE.zip.test(sig)) return { role: 'zip', strong: false };
    return null;
  }

  PM.classifyCardField = classify;

  // The card fields in this frame (first visible field per role), or {} if there's no card form here.
  PM.cardFields = (root = document) => {
    const found = {};
    let strong = false;
    for (const el of PM.deepQueryAll(root, 'input, select')) {
      if (!PM.isVisible(el)) continue;
      const c = classify(el);
      if (!c || found[c.role]) continue;
      found[c.role] = el;
      strong ||= c.strong;
    }
    return strong ? found : {};
  };

  // The role of a focused field, if it's part of a card form.
  PM.cardRole = (el) => {
    const c = classify(el);
    if (!c) return null;
    return Object.values(PM.cardFields()).includes(el) ? c.role : null;
  };

  // Normalized values from this frame's card fields: { number, exp: {month, year}, month, year, name, zip }.
  function readCard(fields) {
    const out = {};
    const text = (el) => (isSelect(el) ? `${el.value} ${el.selectedOptions[0]?.textContent || ''}` : PM.fieldValue(el));
    if (fields.number) out.number = PM.cardDigits(text(fields.number));
    if (fields.exp) out.exp = PM.parseExpiry(text(fields.exp));
    if (fields.month) out.month = isSelect(fields.month)
      ? PM.normMonth(fields.month.value) || PM.normMonth(fields.month.selectedOptions[0]?.textContent)
      : PM.normMonth(text(fields.month));
    if (fields.year) out.year = PM.normYear(isSelect(fields.year) ? fields.year.value : text(fields.year))
      || (isSelect(fields.year) ? PM.normYear(fields.year.selectedOptions[0]?.textContent) : '');
    if (fields.name) out.name = text(fields.name).trim();
    if (fields.zip) out.zip = text(fields.zip).trim();
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }

  // ---- Capture ----

  document.addEventListener('change', (e) => {
    if (!classify(e.composedPath()[0])) return;
    const fields = PM.cardFields();
    if (fields.number || fields.exp || fields.month || fields.year) PM.send({ type: 'CARD_FIELDS', fields: readCard(fields) });
  }, true);

  function submitted() {
    const fields = PM.cardFields();
    const hasFields = Object.keys(fields).length > 0;
    // The pay button is usually on the page while the fields sit in a processor's iframe.
    if (hasFields || window === top) PM.send({ type: 'CARD_SUBMIT', fields: hasFields ? readCard(fields) : {} });
  }

  document.addEventListener('submit', submitted, true);
  document.addEventListener('click', (e) => {
    const btn = e.composedPath().find((el) => el.nodeType === 1 && el.matches?.('button, input[type=submit], input[type=button], [role=button], a'));
    if (btn && PAY_BUTTON_RE.test(PM.buttonLabel(btn))) submitted();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && PM.cardRole(e.composedPath()[0])) submitted();
  }, true);

  // ---- Fill ----

  const setSelect = PM.setSelectOption = (el, match) => {
    const i = [...el.options].findIndex(match);
    if (i === -1) return false;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // Formats the expiry the way the field asks for it: "MM/YY" by default, "MM/YYYY" or "MMYY" when the
  // placeholder or length says so.
  function expiryText(el, card) {
    const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    const max = Number(el.getAttribute('maxlength')) || 0;
    const yy = card.expYear.slice(-2);
    if (/yyyy/.test(hint) || max === 7) return `${card.expMonth}/${card.expYear}`;
    if (max === 4) return `${card.expMonth}${yy}`;
    return hint.includes(' / ') ? `${card.expMonth} / ${yy}` : `${card.expMonth}/${yy}`;
  }

  // Fills this frame's card fields from a saved card. The CVC is left for the user.
  PM.fillCard = (card) => {
    const f = PM.cardFields();
    if (f.number) PM.setFieldValue(f.number, card.number);
    if (f.exp && card.expMonth) PM.setFieldValue(f.exp, expiryText(f.exp, card));
    if (f.month && card.expMonth) {
      if (isSelect(f.month)) setSelect(f.month, (o) => PM.normMonth(o.value) === card.expMonth || PM.normMonth(o.textContent) === card.expMonth);
      else PM.setFieldValue(f.month, card.expMonth);
    }
    if (f.year && card.expYear) {
      if (isSelect(f.year)) setSelect(f.year, (o) => PM.normYear(o.value) === card.expYear || PM.normYear(o.textContent.trim()) === card.expYear);
      else PM.setFieldValue(f.year, Number(f.year.getAttribute('maxlength')) === 2 ? card.expYear.slice(-2) : card.expYear);
    }
    if (f.name && card.name && !isSelect(f.name)) PM.setFieldValue(f.name, card.name);
    if (f.zip && card.zip && !PM.fieldValue(f.zip)) PM.setFieldValue(f.zip, card.zip);
    f.csc?.focus();
    return Object.keys(f).length > 0;
  };

  // A saved card or profile is sent to every frame in the tab; a frame fills it only if it's the page
  // itself, on the page's own site, or a known payment processor. Other embedded frames (ads, widgets)
  // never do. `frameUrl` is the frame whose field the user picked from, which always may fill.
  PM.mayFillFrame = (frameUrl) => {
    if (window === top || frameUrl === location.href) return true;
    const origins = location.ancestorOrigins;
    const topHost = origins?.length ? new URL(origins[origins.length - 1]).hostname : '';
    return (topHost && PM.siteKey(location.hostname) === PM.siteKey(topHost)) || PROCESSOR_RE.test(location.hostname);
  };

  // Menu items for a focused card field: one per saved card. `frameUrl` is set when the top page draws
  // the menu for a field in a small iframe.
  PM.cardMenuItems = async ({ frameUrl } = {}) => {
    const res = await PM.send({ type: 'GET_CARDS' });
    return (res?.cards || []).map((c) => ({
      label: PM.cardLabel(c),
      sub: [`Exp ${c.expMonth}/${c.expYear.slice(-2)}`, c.name].filter(Boolean).join(' · '),
      onPick: async () => {
        const full = await PM.send({ type: 'FILL_CARD', id: c.id, frameUrl });
        if (full?.card) PM.fillCard(full.card);
      },
    }));
  };
})();
