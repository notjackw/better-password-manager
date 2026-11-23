// Overlay for tuning detection: outlines every visible field with the role the heuristics gave it
// and the kind of form it belongs to. Toggled from the popup.
(() => {
  const PM = (globalThis.PM ||= {});

  const COLORS = {
    username: '#2563eb',
    current: '#16a34a',
    new: '#c026d3',
    confirm: '#7c3aed',
    otp: '#ea580c',
    address: '#0d9488',
    card: '#ca8a04',
    ignored: '#9ca3af',
  };

  let on = false;
  let frame = 0;

  function describe(el, g) {
    if (el === g.username) return 'username';
    if (el === g.current) return 'current';
    if (el === g.new) return 'new';
    if (el === g.confirm) return 'confirm';
    if (el === g.otp) return 'otp';
    return 'ignored';
  }

  function draw() {
    frame = 0;
    const layer = PM.uiLayer();
    layer.replaceChildren();
    if (!on) return;
    const groups = new Map();
    const profile = new Map(PM.profileFields().map((f) => [f.el, f.role]));
    for (const el of PM.deepQueryAll(document, 'input, select')) {
      if (!PM.isVisible(el)) continue;
      let role;
      let label;
      if (PM.cardRole(el)) {
        role = 'card';
        label = `card · ${PM.cardRole(el)}`;
      } else if (profile.has(el)) {
        role = 'address';
        label = `address · ${profile.get(el)}`;
      } else {
        if (el.tagName !== 'INPUT' || !PM.classifyField(el)) continue;
        const root = PM.findRoot(el);
        if (!groups.has(root)) groups.set(root, PM.analyzeGroup(root));
        const g = groups.get(root);
        role = describe(el, g);
        label = `${role} · ${g.kind || 'no form'}`;
      }
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'box';
      Object.assign(box.style, {
        left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`,
        borderColor: COLORS[role],
      });
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.style.background = COLORS[role];
      tag.textContent = label;
      box.append(tag);
      layer.append(box);
    }
  }

  const schedule = () => {
    if (on && !frame) frame = requestAnimationFrame(draw);
  };

  PM.toggleDebug = () => {
    on = !on;
    draw();
    return on;
  };

  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('input', schedule, true);
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true });
})();
