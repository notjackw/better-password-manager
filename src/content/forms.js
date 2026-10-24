// Groups fields into a "login unit" (a <form>, or the nearest container on formless pages) and decides
// what that unit is for: login, signup, reset, change, or step one of a multi-step login.
(() => {
  const PM = (globalThis.PM ||= {});

  const BUTTON_SELECTOR = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  const LINK_ACTION_RE = /log ?in|sign ?in|sign ?up|register|continue|next|submit|create|join|save|update|reset|change|confirm/;
  const NON_SUBMIT_RE = /\b(show|hide|reveal|toggle|forgot|cancel|back|close|clear|help|eye|view)\b/;
  const WORDS = {
    login: /log ?in|sign ?in|logon|log on|welcome back|authenticate/,
    signup: /sign ?up|register|registration|create (an |your )?account|new account|join|get started|enroll|onboard/,
    reset: /reset|change (your )?password|forgot|recover|new password|update (your )?password|set (a |your )?password|choose (a )?new/,
  };

  // Tree-order query that also descends into open shadow roots.
  PM.deepQueryAll = (root, selector) => {
    const out = [];
    const visit = (node) => {
      for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
        if (el.matches(selector)) out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(root);
    return out;
  };

  // Parent element, stepping out of shadow roots to their host.
  const parentAcross = (node) => {
    const p = node.parentNode;
    if (p?.nodeType === 11) return p.host || null;
    return p?.nodeType === 1 ? p : null;
  };

  const buttonLabel = (b) => PM.norm([
    b.textContent,
    b.tagName === 'INPUT' ? b.value : '',
    b.getAttribute('aria-label'),
    b.getAttribute('title'),
  ].join(' '));

  PM.isButtonLike = (el) => el?.nodeType === 1
    && (el.matches(BUTTON_SELECTOR) || (el.tagName === 'A' && LINK_ACTION_RE.test(buttonLabel(el))));

  PM.isNonSubmitButton = (b) => {
    if (b.getAttribute('type') === 'reset') return true;
    const label = buttonLabel(b);
    if (NON_SUBMIT_RE.test(label)) return true;
    // Icon-only type=button elements next to fields are almost always "show password" toggles.
    return !label && b.tagName === 'BUTTON' && b.getAttribute('type') === 'button';
  };

  const hasSubmitButton = (node) => PM.deepQueryAll(node, BUTTON_SELECTOR).some((b) => !PM.isNonSubmitButton(b));

  // The container that holds this field's credential set.
  PM.findRoot = (el) => {
    if (el.form) return el.form;
    for (let node = parentAcross(el); node; node = parentAcross(node)) {
      if (node === document.body || node === document.documentElement) break;
      if (PM.deepQueryAll(node, 'input').some(PM.isPasswordField) && hasSubmitButton(node)) return node;
    }
    return document.body || document.documentElement;
  };

  // The container a clicked button submits, or null if it isn't near any credential field.
  PM.findRootForButton = (btn) => {
    if (btn.form) return btn.form;
    for (let node = parentAcross(btn); node; node = parentAcross(node)) {
      const inputs = PM.deepQueryAll(node, 'input');
      const pw = inputs.find(PM.isPasswordField);
      if (pw) return PM.findRoot(pw);
      const user = inputs.find((i) => PM.classifyField(i)?.role === 'username' && PM.isVisible(i));
      if (user) return PM.findRoot(user);
      if (node === document.body) break;
    }
    return null;
  };

  function contextScores(root) {
    const strong = [location.hostname, location.pathname, location.hash];
    const weak = [document.title];
    if (root.tagName === 'FORM') strong.push(...['id', 'name', 'action', 'class'].map((a) => root.getAttribute(a)));
    for (const b of PM.deepQueryAll(root, BUTTON_SELECTOR)) if (!PM.isNonSubmitButton(b)) strong.push(buttonLabel(b));
    let headings = PM.deepQueryAll(root, 'h1, h2, h3, legend, [role="heading"]');
    if (!headings.length) headings = [...document.querySelectorAll('h1, h2')].slice(0, 3);
    weak.push(...headings.map((h) => h.textContent));
    const count = (texts, re) => texts.filter((t) => re.test(PM.norm(t))).length;
    const score = {};
    for (const [k, re] of Object.entries(WORDS)) score[k] = 2 * count(strong, re) + count(weak, re);
    return score;
  }

  function collectFields(root) {
    const inputs = PM.deepQueryAll(root, 'input');
    if (root.tagName === 'FORM') {
      for (const el of root.elements) if (el.tagName === 'INPUT' && !inputs.includes(el)) inputs.push(el);
    }
    const fields = [];
    for (const el of inputs) {
      const c = PM.classifyField(el);
      if (c) fields.push({ el, ...c, index: fields.length, visible: PM.isVisible(el) });
    }
    return fields;
  }

  function assignPasswordSlots(pws, signupish, withValues) {
    const slots = { current: null, new: null, confirm: null };
    const unknown = [];
    for (const f of pws) {
      let k = f.pwKind;
      if (pws.length === 1 && k === 'confirm') k = 'new';
      // Sites often put autocomplete="new-password" on login forms just to block autofill.
      if (pws.length === 1 && f.pwKindFromAutocomplete) k = signupish ? 'new' : 'current';
      if (k && !slots[k]) slots[k] = f;
      else unknown.push(f);
    }
    let order;
    if (pws.length === 1) {
      order = [signupish ? 'new' : 'current'];
    } else if (pws.length === 2) {
      const [a, b] = pws.map((f) => PM.fieldValue(f.el));
      // Two unlabeled password boxes with different values on a non-signup page: old + new password.
      order = !signupish && withValues && a && b && a !== b ? ['current', 'new', 'confirm'] : ['new', 'confirm', 'current'];
    } else {
      order = ['current', 'new', 'confirm'];
    }
    for (const f of unknown) {
      const k = order.find((slot) => !slots[slot]);
      if (k) slots[k] = f;
    }
    return slots;
  }

  function pickUsername(fields, firstPw, withValues) {
    const val = (f) => PM.fieldValue(f.el).trim();
    const usable = (f) => f.visible || (withValues && val(f) && (!f.hidden || f.acUser || PM.EMAIL_RE.test(val(f))));
    let cands = fields.filter((f) => f.role === 'username' && usable(f));
    if (!cands.length && firstPw) cands = fields.filter((f) => f.role === 'text' && f.visible && f.index < firstPw.index);
    if (withValues) {
      const filled = cands.filter(val);
      if (filled.length) cands = filled;
    }
    if (!cands.length) return null;
    const rank = (f) => f.score
      + (withValues && PM.EMAIL_RE.test(val(f)) ? 1 : 0)
      + (firstPw && f.index < firstPw.index ? 0.5 : 0);
    // Ties go to the later candidate, i.e. the one closest above the password field.
    return cands.reduce((best, f) => (rank(f) >= rank(best) ? f : best));
  }

  // Describes the credential unit rooted at `root`. With `withValues`, fields hidden after a submit
  // still count if they hold a value, and typed values help decide ambiguous password roles.
  PM.analyzeGroup = (root, { withValues = false } = {}) => {
    const fields = collectFields(root);
    const usable = (f) => f.visible || (withValues && PM.fieldValue(f.el));
    const pws = fields.filter((f) => f.role === 'password' && usable(f));
    const ctx = contextScores(root);
    const signupish = ctx.signup > ctx.login || ctx.reset > ctx.login;
    const slots = assignPasswordSlots(pws, signupish, withValues);
    const user = pickUsername(fields, pws[0], withValues);
    const otp = fields.find((f) => f.role === 'otp' && f.visible);

    let kind = null;
    if (slots.current && slots.new) kind = 'change';
    else if (slots.new) kind = user && !(ctx.reset > ctx.signup) ? 'signup' : 'reset';
    else if (slots.current) kind = 'login';
    else if (otp) kind = 'otp';
    else if (user && ctx.reset === 0 && (ctx.login > 0 || user.acUser)) kind = 'username-step';

    return {
      root,
      kind,
      username: user?.el || null,
      current: slots.current?.el || null,
      new: slots.new?.el || null,
      confirm: slots.confirm?.el || null,
      otp: otp?.el || null,
      fields,
    };
  };
})();
