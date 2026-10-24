// Offers saved logins when a login field is focused, and a generated password on signup/reset/change forms.
(() => {
  const PM = (globalThis.PM ||= {});

  let focusToken = null;

  // Sets a value the way typing would, so React/Vue/Angular state picks it up.
  PM.setFieldValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  PM.fillCredential = (g, cred) => {
    if (g.username && cred.username) PM.setFieldValue(g.username, cred.username);
    const pwField = g.current || (g.confirm ? null : g.new);
    if (pwField) PM.setFieldValue(pwField, cred.password);
  };

  PM.generatePassword = (length = 20) => {
    const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+?'];
    const all = sets.join('');
    const rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    const chars = sets.map((s) => s[rand(s.length)]);
    while (chars.length < length) chars.push(all[rand(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  };

  PM.getCredsForPage = async () => (await PM.send({ type: 'GET_CREDS' })) || { creds: [], hint: '' };

  // Saved logins for this site, the one matching the username typed on a previous step first.
  const orderCreds = ({ creds, hint }) => (hint
    ? [...creds].sort((a, b) => Number(b.username === hint) - Number(a.username === hint))
    : creds);

  // Fills the first visible login on the page. Returns true if anything was filled.
  PM.fillBest = async () => {
    const inputs = PM.deepQueryAll(document, 'input').filter(PM.isVisible);
    const anchor = inputs.find(PM.isPasswordField) || inputs.find((el) => PM.classifyField(el)?.role === 'username');
    if (!anchor) return false;
    const g = PM.analyzeGroup(PM.findRoot(anchor));
    if (!['login', 'username-step', 'change'].includes(g.kind)) return false;
    const [cred] = orderCreds(await PM.getCredsForPage());
    if (!cred) return false;
    PM.fillCredential(g, cred);
    return true;
  };

  function generatedItem(g) {
    return {
      label: 'Use a strong password',
      sub: 'Generated and kept in your vault right away',
      onPick: () => {
        const password = PM.generatePassword();
        for (const f of [g.new, g.confirm]) if (f) PM.setFieldValue(f, password);
        PM.send({
          type: 'GENERATED',
          password,
          username: g.username ? PM.fieldValue(g.username).trim() : '',
          kind: g.kind,
          site: PM.siteKey(location.hostname),
          origin: location.origin,
          url: location.href,
        });
      },
    };
  }

  document.addEventListener('focusin', async (e) => {
    const el = e.composedPath()[0];
    const role = PM.classifyField(el)?.role;
    if (role !== 'username' && role !== 'password') return;
    const token = (focusToken = {});
    const g = PM.analyzeGroup(PM.findRoot(el));
    const wantsSaved = el === g.current || (el === g.username && (g.kind === 'login' || g.kind === 'username-step'));
    const wantsGenerated = el === g.new || el === g.confirm;
    const items = [];
    if (wantsSaved) {
      for (const cred of orderCreds(await PM.getCredsForPage())) {
        items.push({
          label: cred.username || '(no username)',
          sub: 'Fill saved login',
          onPick: () => PM.fillCredential(PM.analyzeGroup(PM.findRoot(el)), cred),
        });
      }
    }
    if (wantsGenerated) items.push(generatedItem(g));
    if (token === focusToken && items.length) PM.showMenu(el, items);
  }, true);

  document.addEventListener('focusout', () => {
    focusToken = null;
    setTimeout(() => {
      if (!focusToken) PM.hideMenu();
    }, 150);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') PM.hideMenu();
  }, true);

  // Once the user starts typing they've chosen not to use the menu; get it out of the way of the
  // submit button. Our own fills dispatch untrusted events, so they don't count.
  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    focusToken = null;
    PM.hideMenu();
  }, true);
})();
