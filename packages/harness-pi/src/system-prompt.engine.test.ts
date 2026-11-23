import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelectionSchema } from "@opensteer/core";
import { afterEach, expect, it } from "vitest";
import { packagedPiExecutable } from "./executable.js";
import { piProcessArguments } from "./pi-driver.js";

/**
 * The shipped Pi, launched with the driver's own arguments in a temporary home
 * and project against a local stand-in for an OpenAI-compatible endpoint:
 * nothing reads or writes the computer's own Pi configuration.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What Pi sent the model, with the person's own `SYSTEM.md` in place. */
async function systemPromptSent(own: boolean): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-pi-system-")));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const agentDirectory = join(home, ".pi", "agent");
  const project = join(root, "agent-home");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  let body = "";
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      if (!request.url?.includes("chat/completions")) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      body += text;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finish, index: 0 }],
            id: "stub",
            object: "chat.completion.chunk",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
      chunk({ content: "done", role: "assistant" }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => new Promise((resolveClose) => server.close(() => resolveClose())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stub address");
  await writeFile(
    join(agentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          api: "openai-completions",
          apiKey: "local-stub",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [{ id: "model", name: "model" }],
        },
      },
    }),
  );
  await writeFile(join(agentDirectory, "SYSTEM.md"), "PERSON-SYSTEM-MD-MARKER");
  const instructions = join(root, "opensteer-instructions.md");
  await writeFile(instructions, "OPENSTEER-INSTRUCTIONS-MARKER");
  const args = piProcessArguments({
    context: {
      modelSelection: ModelSelectionSchema.parse({
        modelId: "stub/model",
        options: {},
        providerId: "stub",
      }),
      personalContext: own,
      personLineage: own,
    },
    extensionPath: join(root, "unused-extension.js"),
    instructionsPath: instructions,
  });
  // The extension serves the Run's tools over RPC; a print-mode probe has none.
  const at = args.indexOf("--extension");
  const launch = [...args.slice(0, at), ...args.slice(at + 2), "--print", "Say done."];
  const child = spawn(process.execPath, [packagedPiExecutable(), ...launch], {
    cwd: project,
    env: { HOME: home, PATH: process.env.PATH ?? "", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  expect(code, output).toBe(0);
  return body;
}

it("keeps the person's own SYSTEM.md out of a task a connected agent or a chat started", async () => {
  const sent = await systemPromptSent(false);
  expect(sent).not.toContain("PERSON-SYSTEM-MD-MARKER");
  // Pi's own prompt and Opensteer's instructions remain.
  expect(sent).toContain("You are an expert coding assistant operating inside pi");
  expect(sent).toContain("OPENSTEER-INSTRUCTIONS-MARKER");
}, 120_000);

it("still reads it in the person's own task, as Pi did before", async () => {
  expect(await systemPromptSent(true)).toContain("PERSON-SYSTEM-MD-MARKER");
}, 120_000);
