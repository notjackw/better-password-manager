// Payment card helpers shared by the content scripts, the background and tests: card number checks,
// brand, and turning whatever a page shows for an expiry ("04/28", "April", "2028") into { month, year }.
(() => {
  const PM = (globalThis.PM ||= {});

  PM.cardDigits = (s) => String(s || '').replace(/[\s-]/g, '');

  // Luhn checksum: catches typos and anything that isn't a card number.
  PM.luhnOk = (num) => {
    const d = PM.cardDigits(num);
    if (!/^\d{12,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    return sum % 10 === 0;
  };

  PM.cardBrand = (num) => {
    const d = PM.cardDigits(num);
    if (/^4/.test(d)) return 'Visa';
    if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(d)) return 'Mastercard';
    if (/^3[47]/.test(d)) return 'Amex';
    if (/^(6011|65|64[4-9])/.test(d)) return 'Discover';
    if (/^(36|38|30[0-5])/.test(d)) return 'Diners Club';
    if (/^35(2[89]|[3-8]\d)/.test(d)) return 'JCB';
    return 'Card';
  };

  PM.cardLabel = (c) => `${c.brand || PM.cardBrand(c.number)} •••• ${PM.cardDigits(c.number).slice(-4)}`;

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // "4", "04", "April", "Apr", "04 - April" -> "04"
  PM.normMonth = (s) => {
    const t = String(s || '').trim().toLowerCase();
    const n = t.match(/^(\d{1,2})\b/);
    if (n) return Number(n[1]) >= 1 && Number(n[1]) <= 12 ? n[1].padStart(2, '0') : '';
    const i = MONTHS.findIndex((m) => t.startsWith(m));
    return i === -1 ? '' : String(i + 1).padStart(2, '0');
  };

  // "2028", "28" -> "2028"
  PM.normYear = (s) => {
    const t = String(s || '').trim();
    const four = t.match(/\b(20\d\d)\b/);
    if (four) return four[1];
    return /^\d{2}$/.test(t) ? `20${t}` : '';
  };

  // "04/28", "4 / 2028", "0428" -> { month: '04', year: '2028' }
  PM.parseExpiry = (s) => {
    const m = String(s || '').match(/^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{4}|\d{2})\s*$/);
    if (!m) return null;
    const month = PM.normMonth(m[1]);
    return month ? { month, year: m[2].length === 2 ? `20${m[2]}` : m[2] } : null;
  };
})();
