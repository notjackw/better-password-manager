// Address profiles (name, email, phone, postal address) shared by the content scripts, the background
// and tests: splitting names, and matching US states and countries however a form spells them.
(() => {
  const PM = (globalThis.PM ||= {});

  const STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };
  const COUNTRY_NAMES = { US: ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a'], CA: ['canada', 'ca'] };

  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // "MA", "Mass.", "massachusetts" -> "MA"; anything else (non-US regions) is kept as typed.
  PM.normState = (s) => {
    const t = String(s || '').trim();
    if (STATES[t.toUpperCase()]) return t.toUpperCase();
    const w = words(t);
    const code = Object.keys(STATES).find((k) => words(STATES[k]) === w);
    return code || t;
  };

  PM.normCountry = (s) => {
    const w = words(s);
    const code = Object.keys(COUNTRY_NAMES).find((k) => COUNTRY_NAMES[k].includes(w));
    return code || String(s || '').trim();
  };

  // Does a <select> option (value or text) mean this state / country?
  PM.stateMatches = (code, text) => {
    const w = words(text);
    return Boolean(code) && (w === words(code) || w === words(STATES[code] || '') || PM.normState(text) === code);
  };
  PM.countryMatches = (code, text) => Boolean(code) && PM.normCountry(text) === code;

  // "Jack R Williams" -> { given: 'Jack R', family: 'Williams' }
  PM.splitName = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { given: parts[0] || '', family: '' };
    return { given: parts.slice(0, -1).join(' '), family: parts.at(-1) };
  };

  PM.profileLabel = (p) => p.name || p.email || p.address1 || 'Profile';
  PM.profileSub = (p) => [p.address1, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || p.email || '';
})();
