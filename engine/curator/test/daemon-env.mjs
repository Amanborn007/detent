// Imported for its effect by the tests that start a real daemon: opts in, and ties the daemon's life to this test process.
process.env.CURATOR_ALLOW_DAEMON = "1";
process.env.CURATOR_OWNER_PID = String(process.pid);
