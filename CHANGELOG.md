# Changelog

Detent has no release tags, and `.claude-plugin/plugin.json` has said 0.11.0 since the first commit (7a10349). Entries are by the date a PR merged. PR numbers are on GitHub at `Amanborn007/detent`.

## 2026-11-09 and 2026-11-10

- Gate pages and curator: readable gate pages (#44), labelled options and a recommendation on every decision (#47), curator answers no longer lost (#39), `last_seen_at` counts only live tabs (#48), no second tab when one is live (#42).
- Tests and drive: a hung test now fails after five minutes (#43). Drive lists every input in `step.json` (#45).
- `drive --implement` (#41), with docs in #49 and #50. It is experimental, macOS only, and not exercised live yet.

## 2026-11-05

- Tests no longer open a browser or leave a curator daemon behind (#35). Drive host box for the commands drive runs itself (#36). Curator decision pages lead with a brief (#37, #38, landed by #40).

## 2026-10-22

- `openai-compatible` runtime for the reviewer and the judge (#32). The implement child stays out of Claude's per-uid tmp directory (#33).

## 2026-10-21

- Workflow and CLI: gate collect, generated gate pages and curator drain (#5), `detent setup` (#7), fixes from the first end-to-end run (#10), built-in reviewer and verifier adapters with the worked example (#11, #13, landed by #14), friendly verbs `start`, `status`, `continue`, `decide`, `approve`, `revise` and `doctor` (#24).
- Drive: first version with permission scoping (#8), replaced by the contained version (#17). Sandbox probes, bundle import, egress proxy, implement profile and a model-free self-probe gate (#20, #23, #25, #26, #29).
- Curator, index, runtime and demos: curator authentication (#21), markdown on gate pages (#28), `detent index` (#22), runtime port (#27), slash commands with terminal and Claude Code demos (#30), `doctor` shows the index tagger (#31), a real drive run in the README (#18). Smaller fixes: #6, #9, #12, #15, #16, #19.

## 2026-10-20

- Architecture diagrams and README (#1), a shorter README with the manual moved to `docs/REFERENCE.md` (#3), quickstart, demo GIF and test workflow (#2), the engineer's-day README (#4).

## 2026-10-19

- Initial public release (7a10349) and the eval baseline (1018897).
