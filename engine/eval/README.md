# engine/eval — the offline `engine eval` harness

Scores a change against a committed baseline so a regression in agent-facing
behavior (skill frontmatter, hook kill switches, curator self-containment,
sentinel's PR-comment triage logic, ...) shows up as a number, not a vibe.
Zero network by construction — every deterministic check is a pure read of
the repo (plus one sandboxed `engine dashboard` spawn); the optional judge
tier is the only thing that can ever call out, and only when explicitly
enabled and available.

## Architecture

```
engine/eval/
  eval.mjs                the runner + CLI (dual module/CLI, same pattern as engine/bench/bench.mjs)
  render.mjs              pure human renderer: renderHuman(result) + renderRebaseline(result) — no I/O
  verdict.mjs             pure math: deltas, band rules, k-median/spread — no file I/O except loadBaseline
  select.mjs               changed-path -> suite selection (globs) + the one git spawn (changedPathsFromGit)
  graders/deterministic.mjs  the deterministic check library (CHECKS map + gradeCase)
  graders/judge.mjs          the optional LLM-judge tier (judgeCase/runJudgeCase + claudeOnPath)
  test/                    node:test suites, one per module above, all hermetic
evals/
  config.yaml              band, k, judge_max_cases, suites -> {select globs, cases_dir}
  baseline.json            committed baseline, written ONLY by --rebaseline
  cases/<suite>/*.json     case specs ({id, check, params} or {id, grader:"judge", prompt|prompt_path+include, anchors?})
  calibration/<dim>/anchors.json  judge calibration anchors (output-slop, clerk, scout, referee), see evals/calibration/README.md
```

`engine.mjs` wires this in as `engine eval` (`detent eval` for free via the detent
umbrella router). See the CLI's own `--help` / `engine help` for the flag
reference; the full contract lives in the BUILD SPEC this harness was built
from (§2 of the eval-harness build spec, kept in the PR description).

## How to run it

```sh
engine eval                          # every suite in evals/config.yaml
engine eval --suite context-adherence
engine eval --changed                # suites touched by the current branch's diff vs origin/main (falls back to main)
engine eval --no-judge                # force deterministic-only (skip the judge tier even if `claude` is on PATH)
engine eval --k 3                     # judge cases only: 3 runs per case, median + spread
engine eval --rebaseline --no-judge   # run everything, atomically rewrite evals/baseline.json (refuses if combined with --suite/--changed; always pair with --no-judge, see "Rebaseline procedure")
engine eval --quiet                   # suppress the stderr human report; stdout's JSON line is unaffected
```

Every invocation prints exactly one JSON line to stdout (the engine
convention — this IS the machine channel; CI's `tee eval.json` parses it,
and there is no separate `--json` flag) and, unless `--quiet` is given, a
plain-English human report to stderr (`render.mjs`'s `renderHuman` — see
"Human report (stderr)" below). Exit codes: `0` = ran
(UPGRADE/NEUTRAL/DEGRADE are all advisory and exit 0 unless the gate is
**blocking and armed** — see "Gate promotion & burn-in" below — in which case
a DEGRADE exits 2), `1` = environment failure, `2` = refusal (unknown
suite, missing/corrupt baseline, `--rebaseline` + a selector, malformed
`evals/config.yaml`, including an invalid `gate.mode`/`gate.burn_in_prs`).

## Human report (stderr)

`render.mjs` exports two pure functions (no I/O — unit-tested directly in
`test/render.test.mjs`) that turn the result object into stderr text:

- `renderHuman(result)` — the default report on every non-rebaseline run
  (suppress with `--quiet`). One plain-English verdict line first (for a
  first-time contributor), the exact suite/delta table after (for a
  veteran), then a regressions block, the gate line, and a footer explaining
  what to do next and where the machine-readable result lives. Honesty
  rules: a `null` suite score is **never** rendered as `0` — it says "not
  scored yet" (or "no baseline" for the baseline column), always with its
  `note` alongside; every currently-failing deterministic case's exact
  `checks[].detail` is printed verbatim, so the fix is named, not implied.
- `renderRebaseline(result)` — a one-line confirmation after `--rebaseline`
  ("baseline rewritten — commit evals/baseline.json; this resets gate
  burn-in by design").

Both respect `--quiet` (silence stderr entirely; stdout's JSON line is
unaffected either way — `--quiet` never touches stdout).

The result JSON also carries `selection: {mode: "all"|"suite"|"changed",
suites: [...]}` — which suites ran and why (explicit `--suite`, `--changed`'s
diff match, or every suite by default). `renderHuman` surfaces this as one
line ("Suite(s) selected because this PR's diff touches their files: ..." vs
"Every suite in evals/config.yaml ran ...") — the visible half of PR binding,
see "How eval binds to your PR" below for the rest of it.

## What a verdict means

Each suite's score is the mean of its case scores (deterministic cases are
binary: `pass ? 1 : 0`). Delta = `current − baseline` for that suite, computed
over the **intersection of case IDs that carry a numeric score on BOTH
sides** — this is stricter than "present on both sides": a case added or
removed since the baseline was cut (a new case, a dropped/renamed one, a case
that silently failed to load) is excluded and reported in `added`/`removed`,
and a case present on both sides but recorded (numeric score) on only ONE of
them — e.g. a judge case that was `--no-judge` rebaselined (`score:null` in
the baseline) and is recorded on a later run — is ALSO excluded from the mean
on both sides, silently (it isn't an ID-set difference, so it never shows up
in `added`/`removed`). Filtering each side independently, instead of on the
same shared ID set, would let that judge case enter `curMean` while staying
absent from `baseMean` — an asymmetric mean that manufactures a delta out of
nothing but a recording-status change (`verdict.mjs`'s `computeDeltas` has a
regression test for exactly this). Never folded into a naive whole-suite-mean
comparison that could manufacture a DEGRADE purely from case-set drift or
asymmetric recording. A suite absent from the baseline gets `delta: null` and
is excluded — it can never manufacture a verdict on its own; run
`--rebaseline` to bring it in.

Rules, in order (see `verdict.mjs` for the exact math):

1. **Any deterministic pass→fail flip vs baseline ⇒ DEGRADE.** Flips are
   noise-free; the variance band never excuses one. This also fires when a
   case the baseline knows about is entirely MISSING from the current run
   (a dropped case file, a typo'd `check`/`grader` that stopped it from
   being recognized as a case at all, ...) — a silently-dropped case is
   treated exactly like a flip (`eval.mjs`'s `findMissingBaselineCases`),
   loud on stderr, never a quiet pass.
2. Else if any suite's delta is below `-band` (default `0.05`) ⇒ **DEGRADE**.
3. Else if any suite's delta is above `+band` (and none below `-band`) ⇒
   **UPGRADE**.
4. Else **NEUTRAL**.

The band exists to absorb judge-tier noise, not deterministic noise — the
deterministic checks in this repo are exact reads with no inherent variance,
so in practice only flips move them.

## Cost tiers

**Deterministic tier** — free. Sub-second, zero network, runs on every
`engine eval` invocation and in CI on every PR. This is the tier the seed
baseline is built from (all deterministic cases pass at HEAD by construction —
tests enforce it, see `test/deterministic.test.mjs`).

**Judge tier** — optional, off unless a case spec explicitly opts in
(`grader:"judge"` instead of `check`). Each judge case shells `claude -p
<prompt>` through an injectable executor (`graders/judge.mjs`), `--k` times
(default from `evals/config.yaml`'s `k`, default `1`), aggregated by **median**
with **spread** (max − min across the k runs) reported as a disagreement
signal. A vote the judge itself flags `uncertain: true` (it "genuinely cannot
place this output against the anchors") is excluded from that median/spread
entirely — recorded, but never silently averaged in as if confident; if
EVERY vote in the panel is uncertain, the whole case degrades to
`{recorded:false}` rather than fabricating a score. A case whose spec names
an `anchors` dimension gets its recorded score classified into an RYG `band`
(`green`/`yellow`/`red`/`null` for a gap — see `evals/calibration/README.md`);
a case with no `anchors` never gets a `band` key at all. `judge_max_cases` in
`evals/config.yaml` caps how many judge cases a suite may declare — bump it
deliberately, don't silently let a suite grow an expensive sweep.

The judge tier **never participates in the verdict as a hard gate** in this
version — it can flag `judge_flaky` (spread > 2×band) as data for tuning the
band, but a DEGRADE always comes from the deterministic tier or a
deterministic-comparable delta. This is deliberate: same-input LLM scores
drift, and gating on that drift before there's real spread data in the ledger
would just be noise wearing a number.

## Honesty rules (mirrors `engine/bench`'s `computeTokens`)

- No baseline entry for a suite ⇒ `delta: null`, excluded — never a
  fabricated 0.
- Judge tier off (`--no-judge`), `claude` missing, or the executor throwing ⇒
  `{recorded: false, note: "..."}` **plus a loud stderr line**
  (`eval: judge tier skipped — <why>; deterministic tier only`) — never a
  silent downgrade, never a guessed score.
- An unrecorded judge case is dropped from its suite's mean (never scored 0) —
  see `aggregateSuite` in `verdict.mjs`.
- `git_sha` unavailable (no git) ⇒ `null`, never a guess.

## Per-skill suites (clerk / scout / referee / scribe)

Four suites — `clerk`, `scout`, `referee`, `scribe` — pair a deterministic
`doc-invariants` case (pins doctrine-critical phrases in the skill's
`SKILL.md`, e.g. "PENDING-EXTERNAL" for clerk, "AUTHOR mode"/"REVIEWER mode"
for referee) with judge-graded rubric cases scoring the skill against its own
doctrine, at TWO levels:

- **J1 — doc quality.** Scores the skill's own `SKILL.md` prose against its
  doctrine (e.g. "does clerk's text still require both gates before any Jira
  write"). Honest framing: this is a **judge-graded rubric case with a
  live-file include**, not a live agentic rollout — nothing here spawns
  `claude` to actually RUN a skill and grade a transcript (that's explicitly
  deferred, see "Known limitations" below). The `include` mechanism is what
  keeps a static-fixture judge case from measuring pure rubric/judge
  stability: editing `SKILL.md` changes the graded input on the next run.
- **J2 — output quality.** Scores a static, hand-authored FIXTURE OUTPUT
  (a ticket draft for clerk, a research brief for scout, a findings set for
  referee) against a per-skill calibration dimension (`evals/calibration/
  {clerk,scout,referee}/anchors.json`, see `evals/calibration/README.md`),
  via the case spec's `"anchors": "<dimension>"` field. This is the case that
  actually grades what the skill PRODUCES, as opposed to J1's doc-quality
  check — the two are deliberately distinct and never conflated.

Every judge case that carries `anchors` gets its recorded score classified
into an RYG `band` (`graders/judge.mjs`'s `classifyBand`, never invented for
a band-less case) — see "The judge tier" flag reference and `render.mjs`'s
human report.

`referee`'s suite also selects `skills/deslop/**` (the deslop lens is a thin
alias over referee's doctrine, so a change there is graded the same way) and
`evals/calibration/referee/**`. `scout` and `clerk` similarly select their own
`evals/calibration/<suite>/**`. `scribe`'s suite selects the whole
`evals/calibration/**` tree (it predates the per-suite split).

### The output-slop dimension (`SCRIBE-SLOP-1`)

`evals/cases/scribe/case-scribe-slop-1.json` grades a fixed fixture reply (NOT
`SKILL.md` prose) against the deslop-lens + scribe-Layer-A slop patterns,
calibrated against `evals/calibration/output-slop/anchors.json`'s RYG anchors
via `"anchors": "output-slop"` (see `evals/calibration/README.md` for the
anchor-set convention and the mechanical injection that replaced the old
hand-quoted anchor block in `slop-rubric.md`). Slop **is** the score of this
case — 1.0 means zero slop, independent of whether the graded reply is
factually correct. This dimension is documented as applying to scribe AND
herald output; a herald-specific case is deferred (below).
`graders/judge.mjs`'s `parseJudgeOutput` only ever extracts a single `score`
field, so this stays a dedicated case rather than a multi-dimension score
object (`{"slop": ...}` parsing is also deferred).

## Adding a suite or case

1. Add the suite to `evals/config.yaml` (`select:` globs + `cases_dir`).
2. Drop case-spec JSON files under that `cases_dir`:
   - Deterministic: `{id, suite, check: "<name in CHECKS>", params}` — add the
     check function + `CHECKS` entry in `graders/deterministic.mjs` if it's a
     new check. Generic, reusable checks worth reaching for before writing a
     bespoke one: `doc-invariants` (`params: {file|files, must_match?,
     must_not_match?}` — `files` accepts either bare paths sharing the
     top-level phrase lists, or `{file, must_match?, must_not_match?}`
     objects for independent phrase sets per file) and `json-shape`
     (`params: {file, schema?, required_keys?}` — file exists, parses as
     JSON, optional schema string match, optional required top-level keys;
     generic enough for `baseline.json`, `hooks.json`, or any future
     committed JSON shape). `calibration-anchors-valid` (no params) is a
     one-off for `evals/calibration/`.
     `harness-degradation-selftest` (no params, pure — imports
     `computeVerdict`/`computeDeltas`/`aggregateSuite`/`countGreenBaselines`
     from `verdict.mjs` and asserts fixed degradation/edge-case truths
     in-process) is the harness grading itself: any weakening of
     `verdict.mjs`'s math flips this case, so the harness DEGRADEs on itself.
     `self-feedback-roundtrip` (no params; spawns `engine/self-feedback/feedback.mjs`
     against a scratch `DETENT_ROOT`, same sandbox idiom as
     `curator-self-containment`) is behavioral, not prose-only. See each
     check's doc comment in `graders/deterministic.mjs` for the exact
     contract.
   - Judge: either `{id, suite, grader: "judge", prompt: "..."}` (inline
     prompt) or `{id, suite, grader: "judge", prompt_path: "<repo-relative
     .md path>", include?: ["<repo-relative path>", ...], anchors?:
     "<calibration dimension>"}` — the per-skill suites use the latter shape.
     `eval.mjs`'s `resolveJudgeCase` reads `prompt_path` relative to
     `detentRoot`, then — when `anchors` names a dimension — loads
     `evals/calibration/<dimension>/anchors.json` (`graders/judge.mjs`'s
     `loadAnchors`) and mechanically appends its formatted block
     (`formatAnchorsBlock`) to the prompt, THEN appends each `include` file's
     content under a `\n\n--- <repo-relative path> ---\n` header, all BEFORE
     calling `runJudgeCase`. An unreadable `prompt_path`/`include`, or an
     invalid/missing `anchors` dimension, is a hard throw (same as a
     malformed case spec), never a silent `{recorded:false}` (that honesty
     path is reserved for `--no-judge`/missing-`claude`/executor failure,
     which only apply once the prompt itself is known-good). A case with no
     `anchors` field never gets a `band` — bands are only ever printed when
     classifiable from a committed anchors doc. Either shape's prompt should
     ask the model to end its answer with a `{"score": <0..1>, "reasoning":
     "..."}` JSON object (that's what `graders/judge.mjs` parses back out; it
     scans for the LAST such object in stdout, so a "final answer" JSON line
     at the end wins over any scratch reasoning that mentions a score-shaped
     object earlier) — optionally `{"score": ..., "uncertain": true,
     "reasoning": "..."}` when the judge genuinely cannot place the output
     against its anchors; an uncertain vote is excluded from that case's
     k-median/spread, and a panel where ALL k votes are uncertain degrades
     the whole case to `{recorded:false}` rather than fabricating a score.
3. Non-case JSON files may sit alongside case specs in a `cases_dir`, but only
   under the `expected-*.json` naming convention (e.g. `expected-work-order.json`
   next to `sentinel-golden`'s `case.json`) — those are silently not cases.
   Anything else that fails to shape-match a case (`check` or
   `grader:"judge"` present) is treated as a likely typo/corruption, not a
   silent no-op: it's warned to stderr (`eval: <path> is neither a check
   case, a judge case, nor a known support file ...`), and if its case ID
   is known to the committed baseline, the missing case counts as a
   regression (see MEDIUM-3 / "gate-evasion" below) — a one-character typo
   in `check`/`grader` can never silently neutralize a case.
4. Run `engine eval --suite <name> --no-judge` and confirm it's green before
   committing — a new case should be green at HEAD, same as every existing
   one (the whole point of the seed baseline is "1.0 across the board").

## Rebaseline procedure

The committed `evals/baseline.json` is the verdict authority, **not** the
ledger (the ledger is a trend record — see below). Whenever a change
deliberately moves a suite's score (a new case, a tightened invariant, a fixed
regression), rebaseline and commit the result — via one of TWO named modes:

**(a) Routine deterministic rebaseline (the default, what CI's baseline
reflects today):**

```sh
engine eval --rebaseline --no-judge   # exit 0, writes evals/baseline.json atomically (temp+rename)
git add evals/baseline.json
git commit -m "..."
```

`--no-judge` makes every judge-graded case land in the baseline as
`{score: null, pass: null, recorded: false, note: "--no-judge set (case
<id>)"}` (a stable string, no machine-varying path) rather than baking a
live, possibly noisy `claude -p` score into the committed baseline. This is
the right default for almost every rebaseline (new deterministic case, doc
tightened, invariant fixed) — judge cases simply stay advisory-until-seeded
(below) until someone deliberately seeds them.

**(b) Judged seeding** — deliberate, on `main`, on a machine with `claude` on
PATH and credentials configured:

```sh
engine eval --rebaseline --k 3   # k=3 panel per judge case, real claude -p calls
git add evals/baseline.json
git commit -m "..."
```

This bakes each judge case's actually-recorded panel score into the committed
baseline. Until (b) is run for a given judge case, it stays `{recorded:
false}` in the baseline, and `verdict.mjs`'s `computeDeltas` numeric-on-both-
sides intersection keeps it out of every delta on every later run — advisory
by construction, not by policy alone. After (b), that case's judge deltas
DO participate in the verdict on any run where the judge actually ran and
recorded a score (see the integration tests' "seeded direction" case) — but
the CI merge gate (`.github/workflows/eval.yml`'s `eval` job) always runs
`--no-judge`, so a seeded judge case can still never fail the merge gate
regardless of its score. The advisory guarantee is therefore BOTH
process-level (the gate job never runs the judge) AND math-level (the
intersection excludes unseeded cases) — see "How eval binds to your PR"
below for the separate advisory `judge` CI job that DOES run judge cases
(and never fails the build either way).

**Never fabricate a baseline.** No baseline change should ever be committed
beyond what `--rebaseline` actually regenerates for the current case set —
e.g. a brand-new judge case (like the `*-J2` cases added alongside this
section) that's absent from an OLDER committed baseline can't trip
`findMissingBaselineCases` (that check only looks baseline->current, never
the reverse), but it DOES need its own deterministic rebaseline commit so it
doesn't linger forever as `added` drift in every subsequent diff — run
`engine eval --rebaseline --no-judge` and commit, same as any other new case.

`--rebaseline` refuses (exit 2) if combined with `--suite`/`--changed`/`--pr`
— a partial baseline is a corrupt baseline (some suites would silently read as
"no baseline — excluded" until the next full rebaseline). PR branches compare
against the merge-base's committed baseline automatically, since it's already
in their tree.

## Ledger

Every non-rebaseline run appends one line to `benchmarks/ledger.jsonl`
(`schema:"detent-eval-v1"`, distinguishing it from bench's schema-less
lines — see `benchmarks/README.md` for the full field list and read
recipes). Nothing in the repo reads this file; it exists purely as a durable,
in-repo trend record across machines and clones, separate from the
authoritative `evals/baseline.json`. Same as `engine/bench`, this is a
committed, ever-growing ledger by design (LOW-6 in the PR #44 review) — a
local probe/dry-run of `engine eval` should be discarded with
`git checkout -- benchmarks/ledger.jsonl` rather than committed, exactly like
a local `engine bench` probe.

## Gate promotion & burn-in

`evals/config.yaml` carries a committed `gate:` block (roadmap [4/8], "eval
gate: advisory -> blocking after burn-in"):

```yaml
gate:
  mode: blocking      # advisory | blocking (env EVAL_BLOCKING=on|off overrides)
  burn_in_prs: 5      # green (NEUTRAL/UPGRADE) committed ledger entries vs the current baseline before blocking arms
```

Absent entirely, `gate` defaults to `{mode: "advisory", burn_in_prs: 0}` —
never blocking by silent default. An explicit but invalid `gate.mode` (not
`advisory`/`blocking`) or a non-integer/negative `burn_in_prs` is a loud
`EvalRefusal` (exit 2), never a silent fallback to the default.

**Precedence** (`verdict.mjs`'s `resolveGateMode`): `EVAL_BLOCKING=on` env ->
`"blocking"`, `EVAL_BLOCKING=off` env -> `"advisory"` — either env value is an
explicit CI/operator override and always wins over the config. Unset env ->
`evals/config.yaml`'s `gate.mode`.

**Burn-in** applies to a `gate.mode: blocking` config value with NO env
override, per run. `burn_in_prs: 0` arms blocking immediately — this is
the escape hatch if no demotion period is acceptable, and it's also why a
scratch/legacy config with no `gate:` block arms on the very first
blocking-intent run (it defaults to `burn_in_prs: 0`).

**Burn-in shields the judge tier only.** A deterministic signal — a
pass->fail flip vs baseline, or a baseline-known case missing from this
run — is noise-free, so under `gate.mode: blocking` it blocks immediately
(exit 2) from day 1, with no burn-in requirement. Burn-in exists to shield
judge/LLM scoring variance, which is the only tier that can false-positive;
it never delays enforcement of an unambiguous regression.

`EVAL_BLOCKING=on` is a separate, TRUE override: it always arms blocking
immediately, bypassing burn-in entirely regardless of `gate.burn_in_prs` —
this is the pre-existing `EVAL_BLOCKING=on` behavior (and its integration
test), unchanged. It is the only immediate-blocking escape hatch when the
committed config's `burn_in_prs` hasn't been satisfied yet (besides editing
`burn_in_prs` itself).

**Counting rule** (`verdict.mjs`'s `countGreenBaselines`): the green-baseline
count is the number of **distinct `git_sha` values** across
`benchmarks/ledger.jsonl` lines where `schema === "detent-eval-v1"` AND
`verdict` is `NEUTRAL` or `UPGRADE` AND `baseline_sha` on the line matches the
**current baseline's** `git_sha` (`evals/baseline.json`). Lines with
`git_sha: null` are skipped (can't attribute a green run to a commit —
honesty rule, never fabricated); unparsable lines are skipped with a loud
stderr warning rather than crashing the gate (ledger integrity itself is
separately covered by the `ledger-parseable` deterministic check). A line
whose `suites` map is empty or absent — a no-op run, e.g. `--changed` with
an empty diff — is also excluded: it satisfies every other filter but never
graded anything, so it must never mint free burn-in credit. A missing/empty
ledger counts as 0 green, never fabricated. The count is computed **before**
the current run's own line is appended to the ledger, so a run never counts
toward its own burn-in.

**Rebaseline resets burn-in.** Because the count requires `baseline_sha` to
match the *current* baseline's `git_sha`, cutting a new baseline
(`--rebaseline`) makes every prior green ledger line stop counting — a new
baseline must re-earn trust from zero. This is intended, if a little
surprising the first time you see burn-in "reset" after a routine rebaseline.

**Exit paths:**

| Verdict | Effective mode | Signal | Armed? | Result |
|---|---|---|---|---|
| DEGRADE | blocking | deterministic (flips>0 or missing>0) | yes (always, burn-in irrelevant) | exit 2, `next_step` starts `"blocked: ..."` |
| DEGRADE | blocking | judge-only delta, burn-in met | yes | exit 2, `next_step` starts `"blocked: ..."` |
| DEGRADE | blocking | judge-only delta, burn-in NOT met | no | exit 0, `next_step` matches `/burn-in/` |
| DEGRADE | advisory | any | no | exit 0, current advisory text |
| (refusal) | — | `--repo` passed | — | exit 2, `ok:false`, no verdict — see "One root" below |
| (refusal) | — | root names an **unrelated** checkout (not a worktree of cwd's repo) | — | exit 2, `ok:false`, no verdict |
| (refusal) | — | `--detent-root` passed with no value | — | exit 2, `ok:false`, no verdict |
| (any) | (any) | — | — | `gate: {mode, burn_in_prs, green_baselines, armed}` always present |

**One root, always.** An eval run grades exactly ONE detent checkout: the one
whose `evals/config.yaml`, case specs, `evals/baseline.json` and
`benchmarks/ledger.jsonl` it is reading. Root precedence is `--detent-root` >
`DETENT_ROOT` > the clone the CLI lives in.

There used to be a `--repo` flag that pointed the files-under-test at a
*different* checkout from the case specs. It is now refused, because every
deterministic check and every `select:` glob is detent-relative — so grading a
foreign tree against these specs produced a confidently clean verdict for a
tree the run never really evaluated, and the ledger line it appended carried
the foreign tree's `git_sha`, advancing this clone's burn-in with runs that
never graded this clone.

For the same reason, a root pointing at an **unrelated** detent clone than the
one you are working in is refused rather than honoured: otherwise a plain
`engine eval --changed` silently grades the other clone end to end. Pass
`--detent-root <path>` when the divergence is deliberate.

Two deliberate carve-outs, both about not refusing a tree that *is* yours:

- **Another `git worktree` of the same repository is used, not refused.** If cwd
  sits in a worktree of the root's repo (same `git rev-parse --git-common-dir`),
  eval grades **the worktree** — that is the tree you are editing and the one
  whose diff `--changed` reads. Refusing these would break the post-push
  eval-gate nudge and every engine-created `.sdlc/<run>/worktree`. Pointing
  `--detent-root` at the main clone instead would grade the tree you are *not*
  editing, which is the original bug wearing a flag.
- **Paths are compared by identity (`dev`+`ino`), not as strings.** `resolve()`
  normalizes `.`/`..` but canonicalizes neither symlinks nor filesystem case, so
  `/Users/x/code/...` and `/Users/x/Code/...` — one directory, one inode on a
  case-insensitive volume — must not read as two checkouts. Same for
  `/tmp` vs `/private/tmp`.

**Promotion runbook** — how burn-in actually advances: CI checks out a
throwaway clone per PR, so a CI-only run's ledger line is never committed and
never counts. To advance burn-in toward the configured `burn_in_prs`, run the
harness **locally on `main` after a merge** and commit the resulting ledger
line:

```sh
git checkout main && git pull
engine eval --no-judge                 # full run — NOT --changed: on a freshly-pulled
                                        # main, origin/main...HEAD is empty by
                                        # construction, so --changed selects zero
                                        # suites and mints a hollow, suites:{} NEUTRAL
                                        # that countGreenBaselines excludes (it never
                                        # advances burn-in)
git add benchmarks/ledger.jsonl
git commit -m "..."
```

Each such commit that lands a NEUTRAL/UPGRADE line against the current
baseline advances the green count by one (deduped by `git_sha`, so re-running
on the same commit doesn't double-count). Every run's result JSON and the CI
step summary surface `gate: <mode>, burn-in X/N, armed: <bool>` so the current
progress is always visible — this is the mitigation for the risk that burn-in
silently never arms if nobody commits green lines. Deferred: any
auto-commit/recording mechanism, and gh-API-based PR counting (both explicit
future work, not part of this MVP).

## How eval binds to your PR

Three separate bindings, each doing a different job:

1. **CI workflow — the per-PR check.** `.github/workflows/eval.yml` triggers
   `on: pull_request` for changes under `engine/**`, `skills/**`, `hooks/**`,
   `evals/**`, or `benchmarks/**`. Its `eval` job runs the unit tests, then
   `engine eval --changed --no-judge`, tees the JSON line to `eval.json`,
   writes the verdict + gate line to the step summary, and fails the check
   (exit 2) on a CONFIRMED DEGRADE once the gate is armed (see "Gate
   promotion & burn-in" above) — the actual enforcement point, and it never
   runs the judge tier at all. A separate `judge` job, gated to same-repo PRs
   only (`github.event.pull_request.head.repo.full_name ==
   github.repository` — fork PRs never get repo secrets on `pull_request`
   anyway, this makes the guard explicit) and `continue-on-error: true`, runs
   `engine eval --changed --k 3` with `ANTHROPIC_API_KEY` from a repo secret
   and writes each recorded judge case's score/band to the step summary —
   purely advisory, `exit 0` unconditionally, NEVER the merge gate. Absent
   the `ANTHROPIC_API_KEY` secret, the job honestly reports "skipped (no
   ANTHROPIC_API_KEY repo secret)" rather than silently doing nothing.
2. **`hooks/eval-gate.sh` — the local push-time nudge.** A `PostToolUse`
   hook (registered in `hooks/hooks.json`) that fires on `git push` / `gh pr
   create` when the merge-base diff touches an eval-relevant path (the same
   glob roots as `evals/config.yaml`'s suites, `engine/self-feedback/**`
   included). It NEVER runs eval itself and never blocks — it only emits a
   model-facing directive to run `engine eval --changed` and report the
   verdict, deduped once per (repo, head SHA). This is advisory-only,
   independent of whatever the CI job above ultimately decides.
3. **`--changed` suite selection.** Both the CI job and the local nudge
   point at `engine eval --changed`, which selects suites from the PR
   branch's merge-base diff (`origin/main...HEAD`, falling back to `main`)
   — never the whole corpus, so a doc-only PR that never touches
   `skills/scout/**` doesn't get graded against scout's suite.

**Caveat:** a PR that touches none of the CI workflow's `paths:` globs skips
the job entirely — no eval run, no check, nothing to fail. That absence IS
the binding working as intended: the check is scoped to PRs where the
harness has something eval-relevant to grade, not "every PR, whether or not
it's applicable."

## Known limitations (deliberate, not oversights)

- No cross-repo `--pr` resolution: `--pr` is an alias for `--changed` (the CI
  checkout of the PR branch makes them identical) — no `gh` call, zero
  network guarantee preserved.
- The judge tier ships as a seam (injectable executor + degrade path), not a
  gate. The per-skill suites (`clerk`/`scout`/`referee`/`scribe`) are the
  first `grader:"judge"` cases wired into committed suites — their `spread`
  should be watched in the ledger for a while before anyone considers letting
  a judge score affect a verdict.
- **"Agentic" here means judge-graded rubric cases with live-file `include`s,
  not live agentic rollouts.** The per-skill judge cases grade a rubric
  against a skill's own `SKILL.md` prose (optionally alongside a fixed
  fixture, as `SCRIBE-SLOP-1` does) — nothing in this repo spawns `claude` to
  actually RUN a skill and grades the resulting transcript. That's a real,
  deliberate scope cut (see "Deferred" in the eval-corpus-expansion BUILD
  SPEC), not an oversight: a static-fixture judge case measures rubric/judge
  stability more than it measures live skill-behavior regressions. The
  `include` mechanism partially mitigates this — editing the graded
  `SKILL.md` changes the case's input on the next run — but it is not a
  substitute for grading an actual transcript.
- Mixed deterministic + judge cases in the same suite, where a judge case was
  recorded in the baseline but is unrecorded on a later run (or vice versa),
  are handled the same way as any other case-set drift, PLUS one sharper
  rule: `computeDeltas` intersects on case IDs that are numeric on BOTH
  sides, not merely present on both sides (see "What a verdict means" above)
  — the unrecorded/absent side drops that case ID out of the delta's mean,
  never scored 0, and never asymmetrically counted on only one side.
- **Rubric↔anchor drift — now closed mechanically, not just documented.**
  Every judge case that opts into a calibration dimension does so via
  `anchors: "<dimension>"` on the case spec; `resolveJudgeCase` injects the
  anchors doc's formatted block into the prompt at grade time, so there is no
  hand-quoted copy in the rubric to drift out of sync (`SCRIBE-SLOP-1` was
  migrated off its old hand-quoted anchor block for exactly this reason).
  `--calibrate` (actually running the judge against the anchors themselves to
  self-check) is still deferred — see `evals/calibration/README.md`.
