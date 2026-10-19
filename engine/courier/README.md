# reads — the connector-read courier

Interactive-only claude.ai connectors (Figma, Google Drive, Gmail, Slack, Jira) are
NOT reachable from background subagents or headless/cron runs. The courier lets an agent
that CAN'T reach a connector get the data from a context that CAN — without storing tokens.

Two transports:
1. **In-session (subagent → main):** the subagent asks the main session (which holds the
   connectors) via SendMessage; the main session reads and replies with the data.
2. **Durable queue (this CLI):** for deferred / cross-restart requests.
   - `reads request --source gmail --query "..." [--for owl]` → enqueues a request.
   - `reads list` → pending requests (a capable session polls this).
   - `reads fulfill <id> --result-file <f>` → a capable session (human, OR a spawned
     `claude -p` sub-session if it has connector access — see OPEN QUESTION) writes the result.
   - `reads await <id>` → the requester blocks (durably; result never lost) until fulfilled.

State: `${DETENT_COURIER_DIR:-$DETENT_ROOT/.local/reads}` (gitignored).

## OPEN QUESTION (unverified): can a spawned `claude -p` auto-fulfill?
If a freshly-spawned `claude -p` process inherits the account's claude.ai connector access
(plausible — the grants are account/config-level, unlike Agent-tool subagents), then the
fulfiller can be an auto-spawned sub-session instead of a human, and crons become viable
while tokens are fresh. Verify with: `claude -p "list one Google Drive file or say NO_CONNECTOR_ACCESS"`.
