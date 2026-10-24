// Turns a hostname into the "site" key credentials are filed under (the registrable domain),
// so login.example.com and www.example.com share the same saved logins.
(() => {
  const PM = (globalThis.PM ||= {});

  // Small stand-in for the Public Suffix List: the multi-part suffixes people actually hit.
  const MULTI_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
    'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
    'com.br', 'com.mx', 'com.ar', 'com.co', 'co.in', 'net.in', 'org.in',
    'com.cn', 'com.hk', 'com.sg', 'com.my', 'com.tw', 'com.tr', 'co.za', 'co.il',
  ]);

  PM.siteKey = (hostname) => {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    const n = parts.length >= 3 && MULTI_PART_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
    return parts.slice(-n).join('.');
  };
})();
