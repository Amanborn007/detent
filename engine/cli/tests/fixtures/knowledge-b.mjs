// Fixture knowledge provider "b".
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = input.trim() ? JSON.parse(input) : {};
  process.stdout.write(JSON.stringify({
    provider: "b",
    query: req.query || "",
    results: [
      { source: "docs/shared.md:5", excerpt: "shared source, high-confidence copy", confidence: 0.8 },
      { source: "docs/y.md:3", excerpt: "second provider hit", confidence: 0.7 },
    ],
    next_step: "read the highest-confidence sources in full",
  }) + "\n");
});
