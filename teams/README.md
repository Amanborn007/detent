# teams/ — team profiles are local, never committed

clerk (`skills/clerk/`) can use per-team operational notes — timezones, intake
channels, ticket conventions, cycle times — when it scores approaches and
produces estimates. Those notes describe colleagues, so they are kept out of
this repo. This directory holds only this README.

## Where profiles live

```
${DETENT_TEAM_PROFILES:-<detent-clone>/.local/team-profiles}/<team-slug>.md
```

- **Default:** `.local/team-profiles/` inside your detent clone. The root
  `.gitignore` ignores `/.local/`; confirm with
  `git -C <detent-clone> check-ignore -q .local/team-profiles` before writing one.
- **Override:** set `DETENT_TEAM_PROFILES`. The path must be un-committable:
  either outside every git worktree or provably ignored.

## What goes in a profile

Facts you read in a message or ticket: channel functions, cadence, naming
conventions, roles as roles (lead, triager), observed response times, workflow
states. Rosters, timezones and service ownership change, so clerk looks those
up at run time and never stores them.

Never write a judgment about a person's performance or a team's culture, and
never paste profile text into a commit, PR body or Jira ticket.

## Schema

- [`skills/clerk/templates/TEAM-PROFILE-TEMPLATE.md`](../skills/clerk/templates/TEAM-PROFILE-TEMPLATE.md) — profile fields
- [`skills/clerk/templates/NEW-TEAM-ONBOARDING.md`](../skills/clerk/templates/NEW-TEAM-ONBOARDING.md) — how to build a profile for a team you have not worked with
- [`skills/clerk/templates/HOW-PROFILES-FEED-ESTIMATES.md`](../skills/clerk/templates/HOW-PROFILES-FEED-ESTIMATES.md) — how profile facts change an estimate
