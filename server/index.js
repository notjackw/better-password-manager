// Sync server for the extension. Zero-knowledge: the client derives a vault key and a separate login
// hash from the master password, and only the login hash and the already-encrypted vault reach us.
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // from last use, so a device that keeps syncing stays signed in
const USERNAME_RE = /^[a-z0-9._-]{3,64}$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const scrypt = (authHash, salt) => scryptSync(authHash, salt, 32).toString('hex');

// `onVaultChange(userId, revision)` is called after every save, so other devices can be told.
export function createApp(db, onVaultChange = () => {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, auth_hash, auth_salt, kdf, created_at) VALUES (?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    vault: db.prepare('SELECT revision, data FROM vaults WHERE user_id = ?'),
    upsertVault: db.prepare(`INSERT INTO vaults (user_id, revision, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, data = excluded.data, updated_at = excluded.updated_at`),
  };

  const newSession = (userId) => {
    const token = randomBytes(32).toString('base64url');
    q.insertSession.run(sha256(token), userId, Date.now() + SESSION_MS);
    return token;
  };

  const readCreds = (body) => {
    const username = String(body?.username ?? '').trim().toLowerCase();
    const authHash = body?.authHash;
    if (!USERNAME_RE.test(username)) return { error: 'username must be 3-64 chars: a-z 0-9 . _ -' };
    if (typeof authHash !== 'string' || authHash.length < 16) return { error: 'authHash missing' };
    return { username, authHash };
  };

  app.post('/register', (req, res) => {
    const { username, authHash, error } = readCreds(req.body);
    const kdf = req.body?.kdf;
    if (error) return res.status(400).json({ error });
    if (typeof kdf?.salt !== 'string' || !Number.isInteger(kdf?.iterations)) return res.status(400).json({ error: 'kdf missing' });
    if (q.userByName.get(username)) return res.status(409).json({ error: 'username taken' });

    const salt = randomBytes(16).toString('hex');
    const { lastInsertRowid } = q.insertUser.run(username, scrypt(authHash, salt), salt,
      JSON.stringify({ salt: kdf.salt, iterations: kdf.iterations }), Date.now());
    res.status(201).json({ token: newSession(Number(lastInsertRowid)) });
  });

  // Step one of logging in on a new device: fetch the KDF salt so the client can derive its keys.
  // Note this reveals whether a username exists; acceptable for now.
  app.post('/prelogin', (req, res) => {
    const user = q.userByName.get(String(req.body?.username ?? '').trim().toLowerCase());
    if (!user) return res.status(404).json({ error: 'no such user' });
    res.json({ kdf: JSON.parse(user.kdf) });
  });

  app.post('/login', (req, res) => {
    const { username, authHash, error } = readCreds(req.body);
    if (error) return res.status(400).json({ error });
    const user = q.userByName.get(username);
    const ok = user && timingSafeEqual(Buffer.from(scrypt(authHash, user.auth_salt), 'hex'), Buffer.from(user.auth_hash, 'hex'));
    if (!ok) return res.status(401).json({ error: 'wrong username or password' });
    res.json({ token: newSession(user.id) });
  });

  // Returns the user id for a live session token (extending it), or null.
  const userForToken = (token) => {
    const session = typeof token === 'string' && q.session.get(sha256(token));
    if (!session || session.expires_at < Date.now()) return null;
    q.touchSession.run(Date.now() + SESSION_MS, sha256(token));
    return session.user_id;
  };
  app.locals.userForToken = userForToken;

  // Everything below needs `Authorization: Bearer <token>`.
  const auth = (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const userId = userForToken(token);
    if (userId == null) return res.status(401).json({ error: 'not logged in' });
    req.userId = userId;
    req.tokenHash = sha256(token);
    next();
  };

  app.post('/logout', auth, (req, res) => {
    q.deleteSession.run(req.tokenHash);
    res.status(204).end();
  });

  app.get('/vault', auth, (req, res) => {
    const row = q.vault.get(req.userId);
    res.json(row ? { revision: row.revision, data: JSON.parse(row.data) } : { revision: 0, data: null });
  });

  // The client sends the revision its changes are based on. If someone else saved in the meantime we
  // return 409 with the current vault, and the client merges and retries.
  app.put('/vault', auth, (req, res) => {
    const { revision, data } = req.body ?? {};
    if (!Number.isInteger(revision) || data == null) return res.status(400).json({ error: 'revision and data required' });
    const current = q.vault.get(req.userId);
    const currentRevision = current?.revision ?? 0;
    if (revision !== currentRevision) {
      return res.status(409).json({ revision: currentRevision, data: current ? JSON.parse(current.data) : null });
    }
    q.upsertVault.run(req.userId, currentRevision + 1, JSON.stringify(data), Date.now());
    res.json({ revision: currentRevision + 1 });
    onVaultChange(req.userId, currentRevision + 1);
  });

  return app;
}

// The HTTP API plus a WebSocket at /events. Each open extension connects, sends { type: 'auth', token },
// and is then sent { type: 'changed', revision } whenever any device saves that user's vault, so it can
// pull right away instead of waiting for its next scheduled sync.
export function createServer(db) {
  const sockets = new Map(); // user id -> Set of open sockets
  const app = createApp(db, (userId, revision) => {
    for (const ws of sockets.get(userId) || []) ws.send(JSON.stringify({ type: 'changed', revision }));
  });
  const server = http.createServer(app);
  new WebSocketServer({ server, path: '/events', maxPayload: 4096 }).on('connection', (ws) => {
    let userId = null;
    const authTimer = setTimeout(() => ws.close(4001, 'not logged in'), 10000);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return ws.close(4000, 'bad message');
      }
      if (msg.type !== 'auth' || userId != null) return; // anything else is the client's keepalive ping
      userId = app.locals.userForToken(msg.token);
      clearTimeout(authTimer);
      if (userId == null) return ws.close(4001, 'not logged in');
      if (!sockets.has(userId)) sockets.set(userId, new Set());
      sockets.get(userId).add(ws);
      ws.send(JSON.stringify({ type: 'ready' }));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      sockets.get(userId)?.delete(ws);
      if (!sockets.get(userId)?.size) sockets.delete(userId);
    });
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = fileURLToPath(new URL('./data/', import.meta.url));
  mkdirSync(dataDir, { recursive: true });
  const port = Number(process.env.PORT) || 8787;
  createServer(openDb(dataDir + 'vault.db')).listen(port, () => console.log(`sync server on http://localhost:${port}`));
}
