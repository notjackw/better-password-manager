// Decides whether a submitted login/signup/reset worked by watching the page that follows it.
(() => {
  const PM = (globalThis.PM ||= {});

  const ERROR_SELECTOR = '[role="alert"], [aria-live], [class*="error" i], [class*="alert" i], [class*="invalid" i], '
    + '[class*="danger" i], [class*="warning" i], [id*="error" i]';
  const ERROR_RE = /incorrect|invalid|wrong|failed|not recogni|not found|doesn t match|does not match|didn t match|don t match|try again|unable to|locked|too many|couldn t|could not|no account|isn t right|not valid|already (in use|exists|registered|taken)|too (short|weak|common)|must (contain|be|include|have)|required/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Normalized text of every visible error message, plus fields the page marked invalid.
  PM.visibleErrors = () => {
    const out = new Set();
    for (const el of PM.deepQueryAll(document, ERROR_SELECTOR)) {
      const text = PM.norm(el.textContent);
      if (text.length > 2 && text.length < 300 && ERROR_RE.test(text) && PM.isVisible(el)) out.add(text);
    }
    for (const el of PM.deepQueryAll(document, 'input[aria-invalid="true"]')) {
      if (PM.isVisible(el)) out.add(`invalid:${el.name || el.id}`);
    }
    return out;
  };

  // `baseline` holds errors that were already on screen before the submit, so they don't count.
  PM.pageState = (baseline = new Set()) => {
    const inputs = PM.deepQueryAll(document, 'input').filter(PM.isVisible);
    return {
      password: inputs.some(PM.isPasswordField),
      otp: inputs.some((el) => PM.classifyField(el)?.role === 'otp'),
      newError: [...PM.visibleErrors()].some((t) => !baseline.has(t)),
    };
  };

  // Resolves to 'success', 'failure' or 'unknown' (null if a newer attempt took over).
  //  - success: password fields stay gone, or a 2FA/one-time-code step appears
  //  - failure: a new error message shows up while a password field is still there
  //  - unknown: nothing conclusive before the deadline; the background puts it up for review
  PM.watchOutcome = async ({ navigated = false, baseline = new Set(), isCurrent = () => true } = {}) => {
    const deadline = Date.now() + (navigated ? 10000 : 15000);
    const stableFor = navigated ? 2000 : 1200;
    let goneSince = null;
    await sleep(navigated ? 800 : 400);
    while (Date.now() < deadline) {
      if (!isCurrent()) return null;
      const s = PM.pageState(baseline);
      if (s.newError && s.password) return 'failure';
      if (s.otp) return 'success';
      if (s.password) {
        goneSince = null;
      } else {
        goneSince ??= Date.now();
        if (Date.now() - goneSince >= stableFor && document.readyState !== 'loading') return 'success';
      }
      await sleep(400);
    }
    return 'unknown';
  };
})();
