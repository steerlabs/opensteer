import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "../packages/harness-claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { managedClaudeSettings } from "../packages/harness-claude/src/claude-driver.js";

// Invokes the shipped Agent SDK and Claude Code; run deliberately, since it
// makes one live model request to exercise a real sandboxed Bash tool call.
if (process.platform !== "darwin") throw new Error("This probe requires macOS sandbox-exec");
const root = mkdtempSync(join(tmpdir(), "opensteer-claude-attachment-"));
const cacheRoot = join(root, "cache");
const currentThread = join(cacheRoot, "current");
const siblingThread = join(cacheRoot, "sibling");
const privateRoot = join(root, "private");
for (const path of [cacheRoot, currentThread, siblingThread, privateRoot]) mkdirSync(path);
const currentFile = join(currentThread, "input.txt");
const siblingFile = join(siblingThread, "secret.txt");
const privateFile = join(privateRoot, "identity.txt");
const linkedSibling = join(currentThread, "sibling-link");
writeFileSync(currentFile, "CURRENT_MARKER\n");
writeFileSync(siblingFile, "SIBLING_MARKER\n");
writeFileSync(privateFile, "PRIVATE_MARKER\n");
symlinkSync(siblingFile, linkedSibling);
const settings = managedClaudeSettings({
  attachmentDirectory: currentThread,
  attachmentRoot: cacheRoot,
  machineAccessPlatform: "darwin",
  machineAccessRelaySocket: undefined,
  providerState: {
    continuationKey: "probe",
    kind: "ambient",
    privateStateRoot: privateRoot,
    providerHomeDirectory: undefined,
    store: { directory: join(privateRoot, "store"), id: "probe" },
  },
  runtimeBoundary: { kind: "isolated-service" },
});
const command = [
  `for p in '${currentFile}' '${siblingFile}' '${linkedSibling}' '${privateFile}'; do /bin/cat "$p" 2>&1; done`,
  `printf changed >> '${currentFile}'`,
].join("; ");
const abortController = new AbortController();
const timer = setTimeout(
  () => abortController.abort(new Error("Claude sandbox probe timed out")),
  90_000,
);
let toolCommand: string | undefined;
let toolResult = "";
let cliVersion: string | undefined;
try {
  const messages = query({
    prompt: `Use the Bash tool exactly once to execute this command without changing it: ${command}`,
    options: {
      abortController,
      additionalDirectories: [currentThread],
      allowedTools: ["Bash"],
      allowDangerouslySkipPermissions: true,
      cwd: root,
      managedSettings: settings,
      maxTurns: 2,
      model: "claude-haiku-4-5",
      pathToClaudeCodeExecutable: process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude",
      permissionMode: "bypassPermissions",
      persistSession: false,
      settingSources: [],
    },
  });
  for await (const message of messages) {
    if (message.type === "system" && message.subtype === "init")
      cliVersion = message.claude_code_version;
    if (message.type === "assistant") {
      for (const part of message.message.content) {
        if (part.type === "tool_use" && part.name === "Bash")
          toolCommand = String(part.input.command);
      }
    }
    if (message.type === "user") {
      for (const part of message.message.content) {
        if (part.type === "tool_result") toolResult += String(part.content);
      }
    }
  }
  assert.equal(toolCommand, command, "Claude did not execute the exact sandbox probe");
  assert.match(toolResult, /CURRENT_MARKER/);
  assert.doesNotMatch(toolResult, /SIBLING_MARKER|PRIVATE_MARKER/);
  assert.ok((toolResult.match(/operation not permitted/gi) ?? []).length >= 4, toolResult);
  assert.equal(readFileSync(currentFile, "utf8"), "CURRENT_MARKER\n");
  const artifact = {
    cliVersion,
    currentRead: true,
    siblingRead: false,
    linkedSiblingRead: false,
    privateRead: false,
    currentWrite: false,
    platform: process.platform,
    resultSha256: createHash("sha256").update(toolResult).digest("hex"),
  };
  const output =
    process.env.OPENSTEER_CLAUDE_SANDBOX_ARTIFACT ??
    join(tmpdir(), "opensteer-claude-attachment-sandbox-e2e.json");
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
} finally {
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
}
