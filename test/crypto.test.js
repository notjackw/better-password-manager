import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, String, JSON });
vm.runInContext(readFileSync(new URL('../src/shared/vault-crypto.js', import.meta.url), 'utf8'), context);
const { PM } = context;
const fast = (kdf) => ({ ...kdf, iterations: 1000 }); // keep the test quick

test('vault round-trips through encryption and the ciphertext hides the password', async () => {
  const kdf = fast(PM.newKdfParams());
  const key = await PM.deriveKey('master pw', kdf);
  const vault = [{ site: 'example.com', username: 'me@x.com', password: 'hunter2' }];
  const blob = await PM.encryptJson(key, vault);
  assert.equal(PM.isEncrypted(blob), true);
  assert.ok(!JSON.stringify(blob).includes('hunter2'));
  const again = await PM.deriveKey('master pw', kdf);
  assert.equal(JSON.stringify(await PM.decryptJson(again, blob)), JSON.stringify(vault));
  const jwkKey = await PM.importKey(await PM.exportKey(key));
  assert.equal(JSON.stringify(await PM.decryptJson(jwkKey, blob)), JSON.stringify(vault));
});

test('wrong master password fails to decrypt', async () => {
  const kdf = fast(PM.newKdfParams());
  const blob = await PM.encryptJson(await PM.deriveKey('right', kdf), [1, 2, 3]);
  await assert.rejects(PM.decryptJson(await PM.deriveKey('wrong', kdf), blob));
});
