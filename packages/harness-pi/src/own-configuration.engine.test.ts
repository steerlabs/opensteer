import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelectionSchema } from "@opensteer/core";
import { afterEach, expect, it } from "vitest";
import { packagedPiExecutable } from "./executable.js";
import { piAgentDirectoryForOthersTasks, piProcessArguments } from "./pi-driver.js";

/**
 * The shipped Pi, launched with the driver's own arguments and agent folder in
 * a temporary home and project against a local stand-in for an
 * OpenAI-compatible endpoint: nothing reads or writes the computer's own Pi
 * configuration.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * One of each kind of the person's own Pi configuration Pi loads: a shell
 * command prefix in their settings and in the project's, `SYSTEM.md`,
 * `APPEND_SYSTEM.md` and `AGENTS.md` of theirs and the project's, a prompt
 * template; and their sign-in (`models.json`, `auth.json`), which stays.
 */
async function piRun(own: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-pi-own-")));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const agentDirectory = join(home, ".pi", "agent");
  const project = join(root, "agent-home");
  const userPrefixRan = join(root, "user-prefix-ran");
  const projectPrefixRan = join(root, "project-prefix-ran");
  await mkdir(join(agentDirectory, "prompts"), { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
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
      const answered = text.includes('"role":"tool"');
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
      if (answered) {
        chunk({ content: "done", role: "assistant" }, null);
        chunk({}, "stop");
      } else {
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: JSON.stringify({ command: "touch ran.txt" }), name: "bash" },
                id: "call_1",
                index: 0,
                type: "function",
              },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
      }
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
  await writeFile(join(agentDirectory, "auth.json"), "{}");
  await writeFile(
    join(agentDirectory, "settings.json"),
    JSON.stringify({ shellCommandPrefix: `touch "${userPrefixRan}";` }),
  );
  await writeFile(join(agentDirectory, "SYSTEM.md"), "PERSON-SYSTEM-MD-MARKER");
  await writeFile(join(agentDirectory, "APPEND_SYSTEM.md"), "PERSON-APPEND-MARKER");
  await writeFile(join(agentDirectory, "AGENTS.md"), "PERSON-AGENTS-MARKER");
  await writeFile(join(agentDirectory, "prompts", "person-prompt.md"), "PERSON-PROMPT-MARKER");
  await writeFile(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ shellCommandPrefix: `touch "${projectPrefixRan}";` }),
  );
  await writeFile(join(project, ".pi", "SYSTEM.md"), "PROJECT-SYSTEM-MD-MARKER");
  await writeFile(join(project, "AGENTS.md"), "PROJECT-AGENTS-MARKER");
  const instructions = join(root, "opensteer-instructions.md");
  await writeFile(instructions, "OPENSTEER-INSTRUCTIONS-MARKER");
  const environment = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  const args = piProcessArguments({
    context: {
      modelSelection: ModelSelectionSchema.parse({
        modelId: "stub/model",
        options: {},
        providerId: "stub",
      }),
      personalContext: true,
      personLineage: own,
    },
    extensionPath: join(root, "unused-extension.js"),
    instructionsPath: instructions,
  });
  // The extension serves the Run's tools over RPC; a print-mode probe has none.
  const at = args.indexOf("--extension");
  const launch = [...args.slice(0, at), ...args.slice(at + 2), "--print", "Do it."];
  const child = spawn(process.execPath, [packagedPiExecutable(), ...launch], {
    cwd: project,
    env: own
      ? environment
      : {
          ...environment,
          PI_CODING_AGENT_DIR: await piAgentDirectoryForOthersTasks(
            environment,
            join(root, "state", "pi-agent"),
          ),
        },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  expect(code, output).toBe(0);
  return {
    body,
    commandRan: await exists(join(project, "ran.txt")),
    projectPrefixRan: await exists(projectPrefixRan),
    userPrefixRan: await exists(userPrefixRan),
  };
}

it("starts a task a connected agent or a chat started with none of the person's Pi configuration", async () => {
  const run = await piRun(false);
  // It signed in through the person's own models.json, and the command ran.
  expect(run.commandRan).toBe(true);
  // (B) No shell prefix of theirs or the project's wrapped it.
  expect(run.userPrefixRan).toBe(false);
  expect(run.projectPrefixRan).toBe(false);
  // (C) None of their instructions: Pi's own prompt and Opensteer's instructions only.
  for (const marker of [
    "PERSON-SYSTEM-MD-MARKER",
    "PERSON-APPEND-MARKER",
    "PERSON-AGENTS-MARKER",
    "PERSON-PROMPT-MARKER",
    "PROJECT-SYSTEM-MD-MARKER",
    "PROJECT-AGENTS-MARKER",
  ])
    expect(run.body).not.toContain(marker);
  expect(run.body).toContain("You are an expert coding assistant operating inside pi");
  expect(run.body).toContain("OPENSTEER-INSTRUCTIONS-MARKER");
}, 120_000);

it("still reads the person's own configuration in their own task, as Pi did before", async () => {
  const run = await piRun(true);
  expect(run.commandRan).toBe(true);
  expect(run.userPrefixRan).toBe(true);
  expect(run.body).toContain("PERSON-SYSTEM-MD-MARKER");
}, 120_000);
