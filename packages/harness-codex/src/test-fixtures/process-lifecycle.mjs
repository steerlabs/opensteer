import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_PROCESS_SCENARIO ?? "timeout";
const lines = readline.createInterface({ input: process.stdin });

// Diagnostic production is gated separately from the timed request, so a
// scheduled-out child cannot masquerade as missing diagnostic capture.
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (scenario !== "exit" && request.method !== "test/diagnostic") return;
  process.stderr.write(`HEAD-${"x".repeat(2_048)}\n`);
  process.stderr.write(`${process.env.OPENSTEER_AGENT_TOOLS_TOKEN}\n`);
  process.stderr.write(
    `Codex provider startup blocked; Bearer bearer-secret; os_secret_session; api key ${process.env.OPENSTEER_TEST_API_KEY}\n`,
  );
  if (scenario === "exit") setTimeout(() => process.exit(23), 10);
});

lines.on("close", () => process.exit(0));
