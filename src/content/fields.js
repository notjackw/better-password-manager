// Field-level heuristics: decides what role a single <input> plays (username, password, one-time code).
(() => {
  const PM = (globalThis.PM ||= {});

  // All patterns run against normalized text: lowercase words separated by single spaces.
  const RE = {
    email: /e ?mail/,
    username: /user|login|log ?in|sign ?in|logon|account|acct|identifier|\buid\b|member|phone|mobile|handle|nick/,
    notUsername: /search|\bquery\b|^q$|coupon|promo|voucher|captcha|\bzip|postal|address|street|\bcity\b|first ?name|last ?name|full ?name|given ?name|family ?name|company|\bcard\b|\bcvv|\bcvc|\bcode\b|token|newsletter|subscribe|comment|message/,
    otp: /\botp\b|one ?time|\b2fa\b|two ?factor|\bmfa\b|totp|verification ?code|verify ?code|auth(entication)? ?code|security ?code|passcode|sms ?code|authenticator/,
    confirmPw: /confirm|repeat|retype|re ?type|again|verify|re ?enter|second|\b(pw|pwd|pass|password) ?2\b|match/,
    currentPw: /current|\bold\b|existing|previous/,
    newPw: /\bnew|create|choose|set ?up|\bset\b/,
    hiddenUser: /user|e ?mail|login|identifier|account/,
  };
  PM.EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const SKIP_TYPES = new Set([
    'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color',
    'date', 'datetime-local', 'month', 'week', 'time', 'search',
  ]);

  // Inputs we have ever seen as type=password, so "show password" toggles (type -> text) keep their role.
  const seenPassword = new WeakSet();

  PM.norm = (s) => String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  PM.fieldValue ||= (el) => el.value || '';

  PM.isVisible = (el) => {
    if (!el.isConnected || el.type === 'hidden') return false;
    // Opacity doesn't count: some sites (Airbnb) keep a field transparent until it's focused.
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const acTokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);

  function labelText(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const root = el.getRootNode();
      for (const id of ids.split(/\s+/)) parts.push(root.getElementById?.(id)?.textContent);
    }
    return parts.join(' ');
  }

  function signals(el) {
    const attrs = ['name', 'id', 'placeholder', 'aria-label', 'title', 'data-testid', 'data-test', 'data-qa'];
    return PM.norm([...attrs.map((a) => el.getAttribute(a)), labelText(el)].join(' '));
  }

  PM.isPasswordField = (el) => {
    if (el.tagName !== 'INPUT') return false;
    if (el.type === 'password') {
      seenPassword.add(el);
      return true;
    }
    if (seenPassword.has(el)) return true;
    const ac = acTokens(el);
    return el.type !== 'hidden' && (ac.includes('current-password') || ac.includes('new-password'));
  };

  // Returns { kind: 'current' | 'new' | 'confirm' | null, fromAutocomplete }.
  function passwordKind(el) {
    const ac = acTokens(el);
    const sig = signals(el);
    // An explicit current-password beats the field's name: TurboTax's login box is id="…password-confirmation…".
    // (new-password isn't trusted the same way; sites put it on login forms to block autofill.)
    if (ac.includes('current-password') && !RE.newPw.test(sig)) return { kind: 'current', fromAutocomplete: true };
    if (RE.confirmPw.test(sig)) return { kind: 'confirm', fromAutocomplete: false };
    if (RE.currentPw.test(sig)) return { kind: 'current', fromAutocomplete: false };
    if (RE.newPw.test(sig)) return { kind: 'new', fromAutocomplete: false };
    if (ac.includes('current-password')) return { kind: 'current', fromAutocomplete: true };
    if (ac.includes('new-password')) return { kind: 'new', fromAutocomplete: true };
    return { kind: null, fromAutocomplete: false };
  }

  // Returns null for inputs that can't be part of a credential, otherwise
  // { role: 'password' | 'username' | 'otp' | 'text', score, ... }.
  // 'text' is a generic text box, used as the username only when nothing better exists.
  PM.classifyField = (el) => {
    if (el?.tagName !== 'INPUT') return null;
    if (PM.isPasswordField(el)) {
      const { kind, fromAutocomplete } = passwordKind(el);
      return { role: 'password', pwKind: kind, pwKindFromAutocomplete: fromAutocomplete, score: 3 };
    }
    const ac = acTokens(el);
    const sig = signals(el);
    if (el.type === 'hidden') {
      const acUser = ac.includes('username') || ac.includes('email');
      return acUser || RE.hiddenUser.test(PM.norm(`${el.name} ${el.id}`))
        ? { role: 'username', score: 1, hidden: true, acUser }
        : null;
    }
    if (SKIP_TYPES.has(el.type)) return null;
    if (ac.includes('one-time-code') || RE.otp.test(sig)) return { role: 'otp', score: 3 };
    if (ac.includes('username') || ac.includes('email')) return { role: 'username', score: 3, acUser: true };
    if (el.type === 'email') return { role: 'username', score: 3 };
    if (RE.email.test(sig)) return { role: 'username', score: 2.5 };
    if (RE.notUsername.test(sig)) return null;
    if (RE.username.test(sig)) return { role: 'username', score: 2 };
    if (el.type === 'tel') return { role: 'username', score: 1 };
    return { role: 'text', score: 0 };
  };
})();
