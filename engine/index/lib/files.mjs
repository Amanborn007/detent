import { isSafePath } from "./sanitize.mjs";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 5000;

const SECRET_BASENAME = /^(id_[^/]*|\.env(\..*)?|credentials.*)$/i;
const SECRET_EXT = /\.(pem|key|p12)$/i;

export function pathExcluded(path) {
  if (path === ".detent" || path.startsWith(".detent/")) return true;
  if (!isSafePath(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (SECRET_BASENAME.test(base) || SECRET_EXT.test(base)) return true;
  return path.split("/").slice(0, -1).includes("secrets");
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
