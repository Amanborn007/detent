// Fixture exec socket: emits a fixed ticket, or fails with the exit code in payload.fail.
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const payload = input.trim() ? JSON.parse(input) : {};
  if (payload.fail) {
    process.stderr.write("fixture: simulated provider failure\n");
    process.exit(payload.fail);
  }
  process.stdout.write(JSON.stringify({
    id: "octo/repo#1",
    title: "Fixture ticket",
    status: "open",
    body_excerpt: "A fixture ticket body. Echo of ticket_ref: " + (payload.ticket_ref || "(none)"),
    url: "https://example.invalid/octo/repo/issues/1",
    next_step: "feed this ticket JSON to the intake stage",
  }) + "\n");
});
