// Address profiles: recognizes name, email, phone and postal address fields on checkout and account
// forms (including inside a payment processor's address iframe, like Stripe's), offers to save what you
// typed when you continue, and fills a saved profile into those fields in every frame of the tab.
//
// Like cards, each frame reports its own fields to the background, which merges them per tab. Fills
// never overwrite a text box that already has something in it, and skip one-box forms (newsletter
// sign-ups) and the page footer.
(() => {
  const PM = (globalThis.PM ||= {});

  const AC = {
    name: 'name', 'given-name': 'given', 'family-name': 'family', email: 'email', tel: 'tel', 'tel-national': 'tel',
    'street-address': 'address1', 'address-line1': 'address1', 'address-line2': 'address2', 'address-level2': 'city',
    'address-level1': 'state', 'postal-code': 'zip', country: 'country', 'country-name': 'country',
  };
  // All patterns run against normalized text (PM.norm). Order matters: see classify().
  const RE = {
    skip: /search|coupon|promo|discount|gift|captcha|password|user ?name|\blogin\b|company|business|organi[sz]ation|nick|\bcard\b|cvv|cvc|message|comment|\bnote|instruction/,
    email: /e ?mail/,
    tel: /phone|\btel\b|mobile|\bcell\b/,
    given: /first ?name|given ?name|\bf ?name\b|forename/,
    family: /last ?name|family ?name|surname|\bl ?name\b/,
    address2: /address ?(line )?2|\baddr ?2|\bline ?2|\bapt\b|apartment|suite|\bunit\b/,
    address1: /address ?(line )?1|\baddr ?1|\bline ?1|street|\baddress\b/,
    city: /\bcity\b|\btown\b|locality|suburb/,
    state: /\bstate\b|province|\bregion\b|administrative ?area/,
    zip: /\bzip|postal|post ?code/,
    country: /country/,
    name: /full ?name|\bname\b|recipient/,
  };
  const ORDER = ['email', 'tel', 'given', 'family', 'address2', 'address1', 'city', 'state', 'zip', 'country', 'name'];
  const ADDRESS_ROLES = new Set(['address1', 'address2', 'city', 'state', 'zip', 'country']);
  const CONTINUE_RE = /continue|\bnext\b|submit|place (your )?order|\bpay\b|payment|check ?out|purchase|confirm|\bsave\b|complete|review|ship/;

  const isSelect = (el) => el.tagName === 'SELECT';
  PM.inSubframe ||= () => window !== top;

  function classify(el) {
    if (!el || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return null;
    if (el.tagName === 'INPUT' && !['text', 'email', 'tel', 'search', ''].includes(el.type)) return null;
    if (PM.classifyCardField(el)?.strong || PM.cardRole(el)) return null;
    const ac = PM.acTokens(el);
    if (ac.some((t) => t.startsWith('cc-'))) return null;
    for (const t of ac) if (AC[t]) return AC[t];
    const sig = PM.fieldSignals(el);
    if (!sig || RE.skip.test(sig)) return null;
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'tel';
    // What the user sees decides first, then the field's name, then test ids and other hints: Faherty
    // tags every field data-testid="AddressForm-…", which would make them all look like address lines.
    const sources = [PM.labelText(el) + ' ' + (el.getAttribute('aria-label') || ''), `${el.name} ${el.id}`, sig];
    for (const s of sources) {
      const t = PM.norm(s);
      const role = t && ORDER.find((r) => RE[r].test(t));
      if (role) return role;
    }
    return null;
  }

  // One-box forms are newsletter sign-ups or searches, and the footer is where those live.
  function excluded(el) {
    if (el.closest('footer, [role="contentinfo"]')) return true;
    const form = el.closest('form');
    if (!form) return false;
    return PM.deepQueryAll(form, 'input, select, textarea').filter((f) => PM.isVisible(f) && classify(f)).length < 2;
  }

  // [{ el, role }] for this frame, or [] if it isn't a profile form: the top page needs two different
  // kinds of fields (name + email, say); an embedded frame (an address iframe) needs one address field.
  PM.profileFields = () => {
    const fields = [];
    for (const el of PM.deepQueryAll(document, 'input, select, textarea')) {
      if (!PM.isVisible(el)) continue;
      const role = classify(el);
      if (role && !excluded(el)) fields.push({ el, role });
    }
    const roles = new Set(fields.map((f) => f.role));
    const enough = roles.size >= 2 || (PM.inSubframe() && [...roles].some((r) => ADDRESS_ROLES.has(r)));
    return enough ? fields : [];
  };

  PM.profileRole = (el) => PM.profileFields().find((f) => f.el === el)?.role || null;

  const text = (el) => (isSelect(el) ? el.selectedOptions[0]?.textContent || el.value : PM.fieldValue(el)).trim();

  // What's typed in this frame's profile fields, as profile keys.
  function readProfile(fields) {
    const v = {};
    for (const { el, role } of fields) {
      const t = isSelect(el) && !el.value ? '' : text(el);
      if (t && !v[role]) v[role] = t;
    }
    const out = {
      name: v.name || [v.given, v.family].filter(Boolean).join(' '),
      email: v.email, phone: v.tel, address1: v.address1, address2: v.address2, city: v.city,
      state: v.state && PM.normState(v.state), zip: v.zip, country: v.country && PM.normCountry(v.country),
    };
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }

  // ---- Capture ----

  document.addEventListener('change', (e) => {
    if (!classify(e.composedPath()[0])) return;
    const fields = PM.profileFields();
    if (fields.length) PM.send({ type: 'PROFILE_FIELDS', fields: readProfile(fields) });
  }, true);

  function submitted() {
    const fields = PM.profileFields();
    if (fields.length || window === top) PM.send({ type: 'PROFILE_SUBMIT', fields: fields.length ? readProfile(fields) : {} });
  }
  document.addEventListener('submit', submitted, true);
  document.addEventListener('click', (e) => {
    const btn = e.composedPath().find((el) => el.nodeType === 1 && el.matches?.('button, input[type=submit], input[type=button], [role=button], a'));
    if (btn && CONTINUE_RE.test(PM.buttonLabel(btn))) submitted();
  }, true);

  // ---- Fill ----

  // A dropdown drawn by the page (Material UI and the like): a hidden input holds the value, and a
  // button next to it opens a listbox of options. Returns that button, or null for a real text box.
  const listboxButton = (el) => (el.getAttribute('aria-hidden') === 'true' || el.tabIndex < 0)
    && el.parentElement?.querySelector('[aria-haspopup="listbox"], [role="combobox"]:not(input)');

  async function pickFromListbox(button, match) {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button.click();
    let options = [];
    for (let i = 0; i < 20 && !options.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      options = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    }
    const option = options.find((o) => match({ value: o.dataset.value ?? '', textContent: o.textContent }));
    if (option) option.click();
    else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Fills this frame's profile fields. The country goes first, since changing it often redraws the
  // state and ZIP fields; text boxes that already have something in them are left alone.
  PM.fillProfile = async (p) => {
    const { given, family } = PM.splitName(p.name);
    const value = {
      name: p.name, given, family, email: p.email, tel: p.phone, address1: p.address1, address2: p.address2,
      city: p.city, state: p.state, zip: p.zip, country: p.country,
    };
    const fill = async ({ el, role }) => {
      if (!value[role]) return;
      const match = role === 'state' ? (o) => PM.stateMatches(value.state, o.value) || PM.stateMatches(value.state, o.textContent)
        : role === 'country' ? (o) => PM.countryMatches(value.country, o.value) || PM.countryMatches(value.country, o.textContent)
          : (o) => o.value === value[role] || o.textContent.trim() === value[role];
      const button = !isSelect(el) && listboxButton(el);
      if (isSelect(el)) PM.setSelectOption(el, match);
      else if (button) { if (!el.value) await pickFromListbox(button, match); }
      else if (!PM.fieldValue(el)) PM.setFieldValue(el, value[role]);
    };
    // Filling focuses each field in turn; don't reopen our menu on each one, and blur at the end so the
    // site's own address suggestions close too.
    PM.fillingProfile = true;
    try {
      const country = PM.profileFields().filter((f) => f.role === 'country');
      for (const f of country) await fill(f);
      if (country.length) await new Promise((r) => setTimeout(r, 150));
      for (const f of PM.profileFields().filter((x) => x.role !== 'country')) await fill(f);
    } finally {
      PM.fillingProfile = false;
      document.activeElement?.blur?.();
      PM.hideMenu?.();
    }
  };

  PM.profileMenuItems = async ({ frameUrl } = {}) => {
    const res = await PM.send({ type: 'GET_PROFILES' });
    return (res?.profiles || []).map((p) => ({
      label: PM.profileLabel(p),
      sub: PM.profileSub(p),
      onPick: async () => {
        const full = await PM.send({ type: 'FILL_PROFILE', id: p.id, frameUrl });
        if (full?.profile) PM.fillProfile(full.profile);
      },
    }));
  };
})();
