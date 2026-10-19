// Fixture knowledge provider that always fails (exit 1 = provider failure).
process.stderr.write("fixture: knowledge provider down\n");
process.exit(1);
