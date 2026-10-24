import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ URL });
for (const f of ['src/shared/domain.js', 'src/shared/csv.js']) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), context);
}
const { PM } = context;
// Values built inside the vm sandbox have its own Array/Object prototypes; compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('parses quoted fields with commas, quotes and newlines', () => {
  const rows = PM.parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\n');
  assert.deepEqual(plain(rows), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
});

test('reads a Chrome export and files logins under the registrable domain', () => {
  const csv = '﻿name,url,username,password,note\n'
    + 'accounts.google.com,https://accounts.google.com/signin,me@gmail.com,"p,w""1",\n'
    + 'Some app,android://hash@com.example.app/,me,pw2,\n'
    + 'empty,https://example.com/,me,,\n'
    + 'bbc,https://www.bbc.co.uk/login,me@x.com,pw3,a note\n';
  const { creds, skipped } = PM.credentialsFromCsv(csv);
  assert.equal(skipped, 2);
  assert.deepEqual(plain(creds), [
    { site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com', password: 'p,w"1' },
    { site: 'bbc.co.uk', origin: 'https://www.bbc.co.uk', username: 'me@x.com', password: 'pw3' },
  ]);
});

test('reads a Safari / Apple Passwords export (capitalized headers, extra columns)', () => {
  const csv = 'Title,URL,Username,Password,Notes,OTPAuth\nMLB,https://www.mlb.com/,fan@x.com,go-team,,\n';
  assert.equal(PM.credentialsFromCsv(csv).creds[0].site, 'mlb.com');
});

test('rejects a file without url/password columns', () => {
  assert.throws(() => PM.credentialsFromCsv('first,last\nJack,W\n'), /url.*password/);
});
