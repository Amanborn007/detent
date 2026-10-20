#!/usr/bin/env bash
# Sourced by demo.tape. Builds a throwaway work repo and detent home, then defines `detent`.
DEMO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
DEMO_TMP="${DEMO_TMP:-$(mktemp -d)}"
[ -n "$DEMO_TMP" ] || return 1
export DEMO_TMP
mkdir -p "$DEMO_TMP"
git init -q "$DEMO_TMP/repo"
git -C "$DEMO_TMP/repo" -c user.email=demo@example.com -c user.name=demo commit -q --allow-empty -m init
export DETENT_ROOT="$DEMO_TMP/home"
mkdir -p "$DETENT_ROOT"
detent() { node "$DEMO_SRC/engine/cli/engine.mjs" --repo "$DEMO_TMP/repo" "$@"; }
# Engine prints one JSON line; show the three fields a human needs, with the temp path shortened.
pj() {
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s), tmp = process.env.DEMO_TMP;
      const cut = (v, n) => { const t = String(v).split(tmp).join("~"); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
      const o = { ok: j.ok };
      if (j.run_id) o.run_id = j.run_id;
      if (j.stage) o.stage = j.stage;
      if (j.reason) o.reason = cut(String(j.reason).replace(/^illegal transition: /, "").replace(/\s*\(expected.*$/, ""), 72);
      o.next_step = cut(j.next_step, 72);
      console.log(JSON.stringify(o, null, 1));
    });'
}
# Provider/lens ON-OFF table from `detent pack validate`.
packs() {
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      for (const x of [...j.providers, ...j.lenses])
        console.log(x.id.padEnd(14), x.kind.padEnd(8), x.state, x.reason ? "(" + x.reason + ")" : "");
    });'
}
brief() { echo "# Brief: $1" > "$(echo "$DETENT_ROOT"/.sdlc/*)/brief.md"; }
export PS1='$ '
cd "$DEMO_SRC" || return 1
clear
