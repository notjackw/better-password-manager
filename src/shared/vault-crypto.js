// Master-password encryption for the vault: PBKDF2-SHA256 turns the password into an AES-256-GCM key.
// Encrypted values are stored as { enc: 1, iv, data } (base64). Works in the service worker and in Node.
(() => {
  const PM = (globalThis.PM ||= {});
  const subtle = globalThis.crypto.subtle;
  const ITERATIONS = 600000; // OWASP's 2023 recommendation for PBKDF2-SHA256

  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  PM.newKdfParams = () => ({ salt: toB64(crypto.getRandomValues(new Uint8Array(16))), iterations: ITERATIONS });

  PM.deriveKey = async (password, { salt, iterations }) => {
    const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(salt), iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      true, // exportable, so the unlocked key can be kept in memory-only session storage
      ['encrypt', 'decrypt'],
    );
  };

  PM.exportKey = (key) => subtle.exportKey('jwk', key);
  PM.importKey = (jwk) => subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

  PM.isEncrypted = (value) => value?.enc === 1;

  PM.encryptJson = async (key, value) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    return { enc: 1, iv: toB64(iv), data: toB64(data) };
  };

  // Throws if the key is wrong (AES-GCM authentication fails).
  PM.decryptJson = async (key, { iv, data }) => {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data));
    return JSON.parse(new TextDecoder().decode(plain));
  };
})();
