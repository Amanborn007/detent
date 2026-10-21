// Credentials shared by the curator server and CLI: the state directory checks,
// the server secret, and the keys derived from it. No node_modules, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class AuthSetupError extends Error {
  constructor(message, nextStep) {
    super(message);
    this.next_step = nextStep;
  }
}

// detent keeps its own curator state inside the clone, never in a shared ~/.curator.
export function resolveStateDir(env = process.env) {
  if (env.CURATOR_STATE_DIR) return env.CURATOR_STATE_DIR;
  return path.join(env.DETENT_ROOT || path.resolve(MODULE_DIR, '..', '..'), '.local', 'curator');
}

// Returns false when the directory does not exist yet. Refuses anything another
// user could have prepared; merely readable directories are tightened to 0700.
export function checkStateDir(dir) {
  checkAncestors(dir);
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
  const fix = `Remove it or point CURATOR_STATE_DIR at a directory you own, then run: curator open <file.html>`;
  if (st.isSymbolicLink()) throw new AuthSetupError(`curator state dir ${dir} is a symlink`, fix);
  if (!st.isDirectory()) throw new AuthSetupError(`curator state dir ${dir} is not a directory`, fix);
  if (st.uid !== process.getuid()) throw new AuthSetupError(`curator state dir ${dir} is owned by another user`, fix);
  if (st.mode & 0o022) {
    throw new AuthSetupError(`curator state dir ${dir} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`,
      `Run: chmod 700 ${dir} and check nobody else has changed what is inside it. Then run: curator open <file.html>`);
  }
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return true;
}

// Whoever can rename a parent directory can swap the state dir. Walk up to the first of HOME or this clone.
function checkAncestors(dir) {
  const abs = path.resolve(dir);
  const root = [os.homedir(), path.resolve(MODULE_DIR, '..', '..')]
    .map((r) => path.resolve(r))
    .find((r) => abs.startsWith(r + path.sep));
  if (!root) return;
  for (let d = path.dirname(abs); d.length >= root.length; d = path.dirname(d)) {
    const st = fs.statSync(d);
    const fix = `Fix the permissions of ${d} (chmod go-w), or point CURATOR_STATE_DIR somewhere you own, then run: curator open <file.html>`;
    if (st.uid !== process.getuid()) throw new AuthSetupError(`${d}, a parent of the curator state dir ${dir}, is owned by another user`, fix);
    if (st.mode & 0o022) throw new AuthSetupError(`${d}, a parent of the curator state dir ${dir}, is writable by group or others`, fix);
    if (d === root) break;
  }
}

export const secretPath = (dir) => path.join(dir, 'secret');

// Returns the secret, or null when there is none. Refuses a secret anyone else could read or have replaced.
export function readSecret(dir) {
  const file = secretPath(dir);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw new AuthSetupError(`curator secret ${file} is a symlink`, `Delete it, stop the curator server, then run: curator open <file.html>`);
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    const fix = `Run: chmod 600 ${file} (or delete it and stop the server so a new one is created), then run: curator open <file.html>`;
    if (!st.isFile()) throw new AuthSetupError(`curator secret ${file} is not a regular file`, fix);
    if (st.uid !== process.getuid()) throw new AuthSetupError(`curator secret ${file} is owned by another user`, fix);
    if (st.mode & 0o077) throw new AuthSetupError(`curator secret ${file} is readable by group or others (mode ${(st.mode & 0o777).toString(8)})`, fix);
    const text = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new AuthSetupError(`curator secret ${file} is not 64 hex characters`, fix);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

// Never replaces an existing secret: a bad one is an error for the user to resolve.
export function loadOrCreateSecret(dir) {
  const existing = readSecret(dir);
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath(dir), secret, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return readSecret(dir); // another server won the race to create it
  }
  return secret;
}

export function ensureGitignore(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { mode: 0o600 });
      return;
    }
    if (path.dirname(d) === d) return;
  }
}

const mac = (secret, label) => crypto.createHmac('sha256', secret).update(label).digest('hex');
// `boot` is the id one server process makes at start, so keys die with the server that issued them.
export const healthProof = (secret, nonce) => mac(secret, `curator-healthz:${nonce}`);
export const artifactKey = (secret, boot, id) => mac(secret, `curator-artifact:${boot}:${id}`);
export const sessionKey = (secret, boot, id) => mac(secret, `curator-session:${boot}:${id}`);

const HEX64 = /^[0-9a-f]{64}$/;

// Every credential is 64 lowercase hex characters, so anything else is a mismatch before timingSafeEqual can throw.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX64.test(a) || !HEX64.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function browserUrl(port, id, secret, boot) {
  return `http://127.0.0.1:${port}/s/${id}#c=${sessionKey(secret, boot, id)}&r=${artifactKey(secret, boot, id)}`;
}
