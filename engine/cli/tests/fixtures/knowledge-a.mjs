// Fixture knowledge provider "a".
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = input.trim() ? JSON.parse(input) : {};
  process.stdout.write(JSON.stringify({
    provider: "a",
    query: req.query || "",
    results: [
      { source: "docs/x.md:1", excerpt: "top hit from a", confidence: 0.9 },
      { source: "docs/shared.md:5", excerpt: "shared source, low-confidence copy", confidence: 0.5 },
      { source: "docs/low.md:2", excerpt: "noise below threshold", confidence: 0.1 },
    ],
    next_step: "read the highest-confidence sources in full",
  }) + "\n");
});
