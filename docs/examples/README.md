# Worked examples

This folder holds one real run of Detent. It went through all seven stages on [Amanborn007/detent-demo#1](https://github.com/Amanborn007/detent-demo/issues/1), and it ended in [PR #2](https://github.com/Amanborn007/detent-demo/pull/2).

The run folder `2026-10-20-amanborn007-detent-demo-1/` has the brief, the research, the plan, the decisions that were answered through curator, the recheck, and the ship evidence. The curator pages are in its `plans/` folder.

The git worktree is left out, because the code lives in the demo PR. Local paths, the username and the hostname are replaced, so you will see `$DETENT_ROOT`, `~`, `<user>` and `<host>` in the files. Apart from the next sentence, nothing else was edited in the export. [PR #16](https://github.com/Amanborn007/detent/pull/16) added `decision-rationale.jsonl`, regenerated the handoffs and appended 11 `decision_rationale_recorded` lines to `events.jsonl`. The stage times in `events.jsonl` are unchanged. The recorded reasons for D-004 and D-005 date from 2026-10-21 07:58, after respond ended at 07:28, and nothing in the repo says who wrote them.

D-004 to D-006 have `blocks: ["pr"]`, a stage name the CLI does not have. The stage is `ship`, and the stage-name fix landed in #10 after this run. Those three decisions did not block `ship` in code.

What the run does and does not show:

- `benchmark.json` is a partial checkpoint taken when the plan gate opened. It covers 3m34s of agent time through intake, research and the plan draft. It does not cover implement, recheck, ship or respond. `events.jsonl` has those stage times, for example ship from 2026-10-21 06:42 to 07:25 across three reviewer rounds and the verifier.
- The plan stage began 2026-10-20 15:12 and ended 2026-10-21 06:33, which is the wait for the answers to D-001, D-002 and D-003.
- `recheck.md` says "clean". It also says commit order is not proof the tests were seen failing.
- `verify/commits.txt` lists 9 commits at first ship evidence. The merged PR has 13 commits.
- The verifier passed with `npm test` at 13 passed and 0 failed.

To see where the run stopped and asked, read `decisions.json` from D-004 to D-007 first, then `plans/*-ship.html`.

`scripts/export-example.sh` makes a folder like this from any run directory.
