// Reads password-manager CSV exports. Chrome (name,url,username,password,note), Safari/Apple Passwords
// (Title,URL,Username,Password,...) and Firefox (url,username,password,...) all share the
// url/username/password columns, so one reader handles them.
(() => {
  const PM = (globalThis.PM ||= {});

  // RFC 4180: quoted fields may contain commas, newlines and doubled quotes ("").
  PM.parseCsv = (text) => {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((cell) => cell.trim()));
  };

  // Returns { creds: [{ site, origin, username, password }], skipped } or throws if the columns are wrong.
  PM.credentialsFromCsv = (text) => {
    const [header = [], ...rows] = PM.parseCsv(text);
    const cols = header.map((h) => h.trim().toLowerCase());
    const col = { url: cols.indexOf('url'), username: cols.indexOf('username'), password: cols.indexOf('password') };
    if (col.url < 0 || col.password < 0) {
      throw new Error('This file doesn\'t look like a password export. It needs "url" and "password" columns.');
    }
    const creds = [];
    let skipped = 0;
    for (const r of rows) {
      const password = r[col.password] || '';
      let url = null;
      try {
        url = new URL(r[col.url].trim());
      } catch {}
      // Android app logins (android://...) and rows without a password can't be used on websites.
      if (!password || !url || !/^https?:$/.test(url.protocol)) {
        skipped++;
        continue;
      }
      creds.push({
        site: PM.siteKey(url.hostname),
        origin: url.origin,
        username: col.username >= 0 ? (r[col.username] || '').trim() : '',
        password,
      });
    }
    return { creds, skipped };
  };
})();
