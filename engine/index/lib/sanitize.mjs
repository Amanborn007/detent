// Everything written to the index is read later by an agent, so repo text is
// reduced to printable characters and short, identifier-shaped tokens first.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
const IDENT = /^[A-Za-z0-9_$./-]{1,120}$/;
const SAFE_PATH = /^[A-Za-z0-9_$./@+~-]{1,200}$/;

export function clean(s, max = 160) {
  return String(s).replace(/[\r\n\t]+/g, " ").replace(NON_PRINTABLE, "").replace(/ +/g, " ").trim().slice(0, max);
}
export const isIdent = (s) => IDENT.test(s);
export const isSafePath = (s) => SAFE_PATH.test(s);
