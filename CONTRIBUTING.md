# Contributing

Thanks for helping. This page lists what to run before you open a pull request.

## Setup

You need Node.js 20, `bash`, `git`, and the GitHub CLI (`gh`). Clone the repo and install the shell-level pieces:

```sh
git clone https://github.com/Amanborn007/detent && cd detent
scripts/detent-install.sh
```

## Run the tests

Run these from the repo root. All of them should pass before you push.

```sh
node --test engine/*/test engine/cli/tests
bash engine/owl/test/run-tests.sh
for f in hooks/tests/*.sh scripts/tests/*.sh engine/scripts/tests/*.sh engine/adapters/tests/*.sh; do bash "$f" || echo "FAILED: $f"; done
```

Some curator tests start a local server, so they need permission to bind a port on `127.0.0.1`. The `gh-ticket` and `gh-bot-comments` adapter smoke tests call the live GitHub API, so they need a signed-in `gh` and network access.

## Check the eval suites

```sh
node engine/cli/engine.mjs eval --changed --no-judge
```

This scores the suites your change touches against `evals/baseline.json`. A `DEGRADE` verdict fails CI once the gate is armed. If your change moves a score on purpose, run `engine eval --rebaseline --no-judge` and commit the new baseline in the same pull request, with a line in the description saying why.

## Validate the plugin

```sh
claude plugin validate --strict .
```

Run this after any change to `.claude-plugin/`, `hooks/hooks.json` or a skill's frontmatter.

## The leak gate

This repo must not contain names, hostnames, ticket keys or other identifying strings from the organization you work for. CI checks every pull request against a private list. You can run the same check locally with your own list:

```sh
mkdir -p engine/.local
printf '%s\n' 'YourCompany' 'yourcompany.internal' > engine/.local/denylist.txt   # one fixed string per line
bash engine/scripts/company-strings-check.sh --repo --paths-only
```

`engine/.local/` is gitignored. Do not commit your list. Exit 0 means clean, 1 means a hit (the output names the file and line), 2 means the list is missing or empty. Use placeholders such as `AcmeCo` and `your-org` in examples.

## Style

- Keep `engine/` generic. Anything specific to one company belongs in a provider pack or in your own repo.
- Code comments say why, and only when the reason is not obvious. A comment block is at most three lines.
- Docs use plain words and short sentences. State the mechanism. Skip marketing language.
- A change to behavior needs a test. Write the failing test first when you can.
- Commit messages use the imperative mood and name the area, for example `sentinel: skip resolved threads`.

## Pull requests

Describe what changed and how you checked it. Paste the command you ran and its result. Keep the change small enough to review in one sitting. Never push to the default branch directly.

## Reporting security problems

Use the private process in [SECURITY.md](SECURITY.md), not an issue.

## License

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the same as the rest of the project.
