// Exits 2 (contract violation) with a JSON reason on stdout and nothing on stderr.
process.stdout.write(JSON.stringify({ error: "envelope has no string .result" }));
process.exit(2);
