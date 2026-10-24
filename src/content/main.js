// Content script entry: answers the popup/background, and on page load checks whether this page
// is the result of a login we captured on the previous page.
(() => {
  const PM = (globalThis.PM ||= {});

  // Something the user can save from this page right now, even if nothing was submitted.
  function grabFromPage() {
    const inputs = PM.deepQueryAll(document, 'input');
    const anchor = inputs.find((el) => PM.isPasswordField(el) && PM.fieldValue(el))
      || inputs.find((el) => PM.classifyField(el)?.role === 'username' && PM.fieldValue(el));
    if (!anchor) return null;
    const g = PM.analyzeGroup(PM.findRoot(anchor), { withValues: true });
    const creds = PM.credentialsFrom(g);
    creds.password ||= PM.isPasswordField(anchor) ? PM.fieldValue(anchor) : '';
    return creds;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'FILL_BEST':
        PM.fillBest().then((filled) => filled && sendResponse({ filled }));
        return true;
      case 'CAPTURE_PAGE': {
        const creds = grabFromPage();
        if (creds) sendResponse({ creds });
        return false;
      }
      case 'TOGGLE_DEBUG': {
        const enabled = PM.toggleDebug();
        if (window === top) sendResponse({ enabled });
        return false;
      }
      case 'TOAST':
        if (window === top) {
          PM.showToast({
            text: msg.text,
            actionLabel: msg.undo ? 'Undo' : '',
            onAction: () => PM.send({ type: 'UNDO', undo: msg.undo }),
          });
        }
        return false;
      default:
        return false;
    }
  });

  async function checkPreviousAttempt() {
    const res = await PM.send({ type: 'HELLO' });
    if (!res?.evaluate) return;
    const outcome = await PM.watchOutcome({ navigated: true });
    if (outcome) PM.send({ type: 'OUTCOME', id: res.evaluate, outcome });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkPreviousAttempt, { once: true });
  } else {
    checkPreviousAttempt();
  }
})();
