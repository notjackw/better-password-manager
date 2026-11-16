// SQLite storage (Node's built-in node:sqlite, so no native dependency). The server only ever stores
// what the client sends it: a login hash (re-hashed here) and an encrypted vault it cannot read.
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      auth_hash  TEXT NOT NULL,  -- scrypt(client login hash), so a stolen DB can't be used to log in
      auth_salt  TEXT NOT NULL,
      kdf        TEXT NOT NULL,  -- JSON {salt, iterations}: what a new device needs to rebuild its keys
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,  -- sha256 of the bearer token; the token itself is never stored
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vaults (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision   INTEGER NOT NULL,  -- bumped on every save; used to reject uploads based on stale data
      data       TEXT NOT NULL,     -- opaque encrypted blob from the extension
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}
