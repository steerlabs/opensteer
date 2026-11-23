import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A validator's report is for the caller that sent the request, never for a person. The Host's
 * one HTTP mapping (`normalizeHostError`) marks every request it cannot read `reason:
 * "invalid-request"`, and the apps' `homeFailureText` never shows such a refusal's text. Any
 * other Host source that writes a validator's issues into text is listed here with the reason it
 * may: a new one fails this test until it is marked `invalid-request` or reviewed.
 */
const allowed: Readonly<Record<string, string>> = {
  "server/http-errors.ts": "The one HTTP mapping: it marks the refusal invalid-request.",
  "mcp/agent-tool-failure.ts": "Tool errors for a connected agent over MCP, never an app's screen.",
  "computer-use/computer-use-service.ts":
    "Tells a model which actions it sent wrong, never a person.",
  "computer-use/computer-repl/messages.ts":
    "Copies issues into another schema's issues; writes no text.",
  "local-servers/local-mcp-secrets.ts":
    "A secret's field by its title and the schema's own sentence for it (a person's field entry).",
  "mcp/opensteer-mcp-service.ts": "Names the result fields an engine got wrong, to the engine.",
  "mcp/connections/embedder-assertion.ts": "Reads an issue's code to decide; writes no text.",
  "plugins/engine-protocol.ts": "Reads issues to decide; writes no text.",
  "server.ts": "Logs the paths of a reply that failed its schema; nothing is sent.",
  "channels/channel-service.ts":
    "A messaging provider's inspection issues (sentences for the person), not a validator's.",
  "local-servers/local-server-registry.ts": "A plugin's own list of issues, not a validator's.",
};

it("writes a validator's issues into text only where each place says why it may", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const found = [...files(root)]
    .filter((file) => /formatIssues\(|\.issues\b/u.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file))
    .filter((file) => !(file in allowed));
  expect(found).toEqual([]);
});

function* files(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.name.endsWith(".ts") && !/\.test\.|test-support/u.test(entry.name)) yield full;
  }
}
