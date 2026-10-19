# Per-medium formatting (Layer B — pure markup syntax)

Read before drafting. **This file is syntax only.** Register, length, and structure live in
`profiles.md` (Layer C); *what to say / what not to say* lives in SKILL.md step 4 (Layer A).
Formatting never contests content — it just makes the text render correctly for the medium.

## Slack (mrkdwn — NOT standard markdown)
- Bold `*text*` (single asterisk) · italic `_text_` · strike `~text~` · code `` `code` `` · block ```` ```code``` ````
- Quote `> line` · bullets `• ` or `- ` · numbered `1. `
- Link `<https://url|label>` (NOT `[label](url)`) · channel `<#CID>` · user `<@UID>`
- NO `#`/`##` headers, NO `**bold**` — both render as literal characters. Emphasis via `*bold*` + line breaks.
- Reply in-thread (`thread_ts`); don't broadcast to the channel unless asked.

## Email
- Plain text by default; HTML only if requested (then real `<b>`, `<ul><li>`, `<a href>`).
- Subject only when starting a new thread; on a reply keep the existing subject.
- No Slack/Jira/Confluence markup — standard prose.

## Jira comment (wiki markup / ADF)
- Headers `h3.` · bold `*text*` · italic `_text_` · monospace `{{text}}` · code `{code:java}...{code}`
- Bullets `* ` / `** ` nested · numbered `# ` · link `[label|https://url]` · mention `[~accountid]`
- Panels `{panel}...{panel}`, quotes `{quote}...{quote}` · status/checkmarks `(/)` `(x)`
- Reference issues by key (ABC-123) — Jira auto-links them.

## GitHub (PR / issue comment — GitHub-flavored markdown)
- Standard markdown, the OPPOSITE of Slack: `#`/`##` headers, `**bold**`, `_italic_`, `` `code` ``,
  ```` ```lang fences ````, `[label](url)` links, `> quote`, `- `/`1. ` bullets, task lists `- [ ]`,
  tables, `@login` mentions, `#123` issue/PR refs, and ```` ```suggestion ```` blocks are all valid.

## Confluence (page COMMENTS only — inline + footer; NOT page authoring)
- scribe is a *reply* tool: it writes **comments** on a page, never new pages or page bodies.
- Markup is the Jira wiki/ADF family: `h3.` headers · `*bold*` · `_italic_` · `{{mono}}` ·
  `{code}...{code}` · bullets `* ` / nested `** ` · numbered `# ` · link `[label|https://url]` ·
  mention `[~accountid]` · `{quote}...{quote}` · status glyph `(/)` `(x)`.
- Two comment kinds: **inline** (anchored to a selected passage) and **footer** (page-level).

## Cross-cutting (Layer B only)
- Draft/post mechanics per medium (which draft tool, paste-ready vs native, explicit-approval
  posting) are owned by **SKILL.md step 6** — the single source of truth; not duplicated here.
- Never invent facts; cite the PR/ticket/doc/page when relevant; flag unknowns (grounding detail
  in SKILL.md step 3).
