# Socket: skills-pack

## Purpose
How a domain team extends the pipeline **without forking the engine**. A
skills pack is a versioned directory a team ships (e.g. the deliveries team's
extra audit-logging stage, a mobile team's screenshot-diff stage). `stack.yaml`
lists the installed packs; at pipeline assembly the engine invokes each pack's
manifest command to learn what stages/skills it contributes and where they
splice in.

## Consumed by
**Pipeline assembly** (before stage 1 runs). Pack-contributed stages then
execute at their declared insertion points like native stages.

## Invocation
Each pack provides a `manifest` command (declared in the pack's entry in
`stack.yaml`). One JSON request on stdin, one JSON response on stdout.

Exit codes: `0` success · `1` pack failure (engine refuses to run the pipeline
with a broken pack rather than silently skipping it) · `2` contract violation.

## Request schema
```json
{
  "engine_version": "string — contract version the engine speaks",
  "repo_path": "string — absolute path of the target checkout",
  "ticket_id": "optional string — lets a pack opt out for irrelevant tickets"
}
```

## Response schema
```json
{
  "pack": "string — pack name, must match stack.yaml",
  "version": "string — pack version (semver)",
  "stages": [
    {
      "name": "string — stage identifier, namespaced by pack",
      "insert": "after:research | after:plan | after:implement | after:review | after:pr",
      "command": "string — command implementing the stage (same stdin/stdout/exit contract as sockets)",
      "optional": "boolean — false means pipeline fails if this stage fails"
    }
  ],
  "next_step": "string — hint for the calling agent"
}
```

An empty `stages` array means the pack has nothing to add for this ticket —
valid and common.

## Example exchange
Request:
```json
{"engine_version": "1", "repo_path": "/work/deliveries", "ticket_id": "acmeco/deliveries#482"}
```
Response (exit 0):
```json
{
  "pack": "deliveries-pack",
  "version": "2.0.0",
  "stages": [
    {
      "name": "deliveries-pack/event-log-impact-analysis",
      "insert": "after:plan",
      "command": "acme-deliveries-pack event-log-impact",
      "optional": false
    }
  ],
  "next_step": "splice the listed stages into the pipeline at their insertion points before starting intake"
}
```
