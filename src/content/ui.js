// In-page UI (autofill menu, toasts, debug layer), kept in a closed shadow root so page styles can't touch it.
(() => {
  const PM = (globalThis.PM ||= {});

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .menu {
      position: fixed; min-width: 220px; max-width: 360px; padding: 4px; border-radius: 8px;
      background: #fff; color: #111827; border: 1px solid #d1d5db; box-shadow: 0 8px 24px rgba(0,0,0,.18);
    }
    .item {
      display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px;
      background: transparent; color: inherit; cursor: pointer;
    }
    .item:hover, .item:focus-visible { background: #eef2ff; outline: none; }
    .item .sub { display: block; color: #6b7280; font-size: 12px; }
    .toast {
      position: fixed; right: 16px; bottom: 16px; display: flex; gap: 10px; align-items: center;
      max-width: calc(100vw - 32px); padding: 10px 12px; border-radius: 8px;
      background: #111827; color: #f9fafb; box-shadow: 0 8px 24px rgba(0,0,0,.25);
    }
    .toast button { border: 0; background: transparent; color: #a5b4fc; cursor: pointer; font-weight: 600; padding: 2px 4px; }
    .toast button.close { color: #9ca3af; }
    .box { position: fixed; border: 2px solid; border-radius: 3px; pointer-events: none; }
    .tag {
      position: absolute; left: -2px; bottom: 100%; padding: 1px 5px; border-radius: 3px 3px 0 0;
      color: #fff; font-size: 11px; white-space: nowrap;
    }
    @media (prefers-color-scheme: dark) {
      .menu { background: #1f2937; color: #f9fafb; border-color: #374151; }
      .item:hover, .item:focus-visible { background: #312e81; }
      .item .sub { color: #9ca3af; }
    }
  `;

  let host = null;
  let shadow = null;
  let menu = null;
  let menuAnchor = null;

  function root() {
    if (host?.isConnected) return shadow;
    host = document.createElement('pm-ui');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    document.documentElement.append(host);
    return shadow;
  }

  PM.uiLayer = () => {
    const s = root();
    let layer = s.querySelector('.layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'layer';
      s.append(layer);
    }
    return layer;
  };

  PM.showToast = ({ text, actionLabel, onAction, duration = 8000 }) => {
    const s = root();
    s.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    const msg = document.createElement('span');
    msg.textContent = text;
    toast.append(msg);
    if (actionLabel) {
      const action = document.createElement('button');
      action.textContent = actionLabel;
      action.addEventListener('click', () => {
        toast.remove();
        onAction();
      });
      toast.append(action);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => toast.remove());
    toast.append(close);
    s.append(toast);
    setTimeout(() => toast.remove(), duration);
  };

  function placeMenu() {
    if (!menu || !menuAnchor) return;
    if (!menuAnchor.isConnected) return PM.hideMenu();
    const r = menuAnchor.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 240))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.minWidth = `${Math.max(220, r.width)}px`;
  }

  // items: [{ label, sub, onPick }]
  PM.showMenu = (anchor, items) => {
    PM.hideMenu();
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'listbox');
    for (const { label, sub, onPick } of items) {
      const item = document.createElement('button');
      item.className = 'item';
      item.setAttribute('role', 'option');
      item.textContent = label;
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = sub;
        item.append(s);
      }
      // Keep focus in the page's field so the menu doesn't close itself on mousedown.
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        PM.hideMenu();
        onPick();
      });
      menu.append(item);
    }
    menuAnchor = anchor;
    root().append(menu);
    placeMenu();
  };

  PM.menuShown = () => Boolean(menu);

  PM.hideMenu = () => {
    menu?.remove();
    menu = null;
    menuAnchor = null;
  };

  window.addEventListener('scroll', placeMenu, true);
  window.addEventListener('resize', placeMenu);
})();
