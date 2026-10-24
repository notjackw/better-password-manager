// Watches for credential submissions and reports them to the background, which saves them once the
// sign-in is confirmed. Triggers, strongest first: form submit, submit-like click, Enter in a field.
// Fallbacks for sites that slip past those: the page unloading, or a filled password field being
// removed from the page. Fallback captures always go to "Needs review" instead of saving outright.
(() => {
  const PM = (globalThis.PM ||= {});

  // Last value typed into each input. Many sites clear the password field on submit, before we look.
  const lastValues = new WeakMap();
  const rootOf = new WeakMap();
  const filledPasswords = new Set();
  let lastSentKey = '';
  let lastSentAt = 0;
  let watchGeneration = 0;
  let activeWatch = null; // { id, gen } while the page is being watched after a submit

  PM.fieldValue = (el) => el.value || lastValues.get(el) || '';

  PM.send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this page's script is orphaned
    }
  };

  function recordValue(e) {
    const el = e.composedPath()[0];
    if (el?.tagName !== 'INPUT') return;
    lastValues.set(el, el.value);
    if (!PM.isPasswordField(el)) return;
    if (el.value) {
      filledPasswords.add(el);
      if (!rootOf.has(el)) rootOf.set(el, PM.findRoot(el));
    } else {
      filledPasswords.delete(el);
    }
  }
  document.addEventListener('input', recordValue, true);
  document.addEventListener('change', recordValue, true);

  PM.credentialsFrom = (g) => {
    const v = (el) => (el ? PM.fieldValue(el) : '');
    const current = v(g.current);
    return {
      kind: g.kind,
      username: v(g.username).trim(),
      password: g.kind === 'login' ? current : v(g.new),
      currentPassword: g.kind === 'change' ? current : '',
      site: PM.siteKey(location.hostname),
      origin: location.origin,
      url: location.href,
    };
  };

  function attempt(root, trigger) {
    if (!root) return;
    const g = PM.analyzeGroup(root, { withValues: true });
    if (g.kind === 'username-step') {
      const username = PM.fieldValue(g.username).trim();
      if (username) PM.send({ type: 'STEP_USERNAME', username, site: PM.siteKey(location.hostname) });
      return;
    }
    if (!['login', 'signup', 'reset', 'change'].includes(g.kind)) return;
    const creds = PM.credentialsFrom(g);
    if (!creds.password) return;

    // submit + click + Enter usually all fire for one submission; report it once.
    const key = [creds.site, creds.username, creds.password].join('\n');
    const fallback = trigger === 'unload' || trigger === 'removed';
    if (key === lastSentKey && (fallback || Date.now() - lastSentAt < 1500)) return;
    lastSentKey = key;
    lastSentAt = Date.now();

    const baseline = PM.visibleErrors();
    const gen = ++watchGeneration;
    PM.send({ type: 'ATTEMPT', attempt: { ...creds, trigger } }).then(async (res) => {
      if (!res?.id) return;
      activeWatch = { id: res.id, gen };
      const outcome = await PM.watchOutcome({ baseline, isCurrent: () => gen === watchGeneration });
      if (activeWatch?.gen === gen) activeWatch = null;
      if (outcome) PM.send({ type: 'OUTCOME', id: res.id, outcome });
    });
  }

  document.addEventListener('submit', (e) => {
    const form = e.composedPath()[0];
    if (form?.tagName === 'FORM') attempt(form, 'submit');
  }, true);

  document.addEventListener('click', (e) => {
    const btn = e.composedPath().find(PM.isButtonLike);
    if (btn && !PM.isNonSubmitButton(btn)) attempt(PM.findRootForButton(btn), 'click');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const el = e.composedPath()[0];
    const role = PM.classifyField(el)?.role;
    if (role === 'password' || role === 'username' || role === 'text') attempt(PM.findRoot(el), 'enter');
  }, true);

  window.addEventListener('pagehide', () => {
    // A login frame embedded in another site (e.g. Disney's on espn.com) that closes while we're
    // still watching, without having shown an error, is the site dismissing it after a good login.
    if (window !== top && activeWatch) {
      PM.send({ type: 'OUTCOME', id: activeWatch.id, outcome: 'success' });
      activeWatch = null;
    }
    for (const el of filledPasswords) attempt(el.isConnected ? PM.findRoot(el) : rootOf.get(el), 'unload');
  });

  new MutationObserver(() => {
    for (const el of filledPasswords) {
      if (el.isConnected) continue;
      filledPasswords.delete(el);
      attempt(rootOf.get(el), 'removed');
    }
  }).observe(document, { childList: true, subtree: true });
})();
