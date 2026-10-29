// A stand-in for `pi --mode rpc`, speaking exactly the JSONL protocol the Pi
// driver uses (pi-facts §2). It also plays the part of the Opensteer extension
// Pi would have loaded, because the extension's observable behaviour on the
// wire — the handshake notify, the approval and tool `input` dialogs — is what
// the driver actually talks to.
//
//   --scenario=<name>            which script to play
//   FAKE_PI_CAPTURE_PATH         JSONL file every inbound message is appended to
//   FAKE_PI_VERSION              what `--version` prints instead of the installed
//                                Pi release, to play a release nothing pins
//
// Framing is strict LF, and one scenario deliberately puts U+2028 inside a JSON
// string to prove the driver does not use `readline`.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const scenarioArgument = argv.find((argument) => argument.startsWith("--scenario="));
const scenario =
  scenarioArgument?.slice("--scenario=".length) ?? process.env.FAKE_PI_SCENARIO ?? "happy";
const capturePath = process.env.FAKE_PI_CAPTURE_PATH;

function capture(entry) {
  if (capturePath) appendFileSync(capturePath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? installedPiVersion()}\n`);
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "check") {
  const provider = argv[argv.indexOf("--provider") + 1];
  capture({ authCheck: provider, environment: environmentSnapshot() });
  if (process.env.FAKE_PI_AUTH_READY === "0") {
    process.stdout.write(
      `${JSON.stringify({ provider, reason: "credentials_not_configured", status: "not_ready" })}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ authType: "api_key", provider, status: "ready" })}\n`);
  process.exit(0);
}

function environmentSnapshot() {
  // Everything the driver's own launch could have put here. The "no secret in
  // the environment" test reads this back: Pi hands its whole environment to
  // every command the model runs (pi-facts §11).
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.startsWith("PI_") || name.startsWith("OPENSTEER_"),
    ),
  );
}

const optionValue = (flag) => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};

if (argv.includes("--print")) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  capture({ fakePiNaming: { argv, prompt } });
  process.stdout.write("Support migration\nheadphones");
  process.exit(0);
}

const extensionPath = optionValue("--extension");
const sessionArgument = optionValue("--session");
const instructionsPath = optionValue("--append-system-prompt");
const sessionDirectory = process.env.FAKE_PI_SESSION_DIR ?? join(process.cwd(), ".fake-pi");
const sessionPath = sessionArgument ?? join(sessionDirectory, "session.jsonl");
let sessionId = process.env.FAKE_PI_SESSION_ID ?? "01a0ae39-e96f-70ab-b1c9-0faf62275432";

capture({
  fakePiProcess: {
    argv,
    cwd: process.cwd(),
    environment: environmentSnapshot(),
    extension: extensionPath ? readFileSync(extensionPath, "utf8") : null,
    instructions: instructionsPath ? readFileSync(instructionsPath, "utf8") : null,
  },
});

// A process that ignores SIGTERM and leaves a grandchild behind, so the
// supervisor's process-group kill is the only thing that can end the tree.
if (scenario === "ignore-termination") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  capture({ fakeGrandchildPid: grandchild.pid });
  process.on("SIGTERM", () => undefined);
}

// Pi's one silent failure: pointed at a session recorded elsewhere it prints a
// y/N fork prompt on stderr and exits 0 with no protocol output (pi-facts §1).
if (scenario === "cwd-mismatch") {
  process.stderr.write(`Session found in different project: ${process.cwd()}\n`);
  process.stderr.write("Fork this session into current directory? [y/N]\nAborted.\n");
  process.exit(0);
}

let model = { id: "mock-1", provider: "mocklocal" };
let thinkingLevel = "off";
const requestedModel = optionValue("--model");
if (requestedModel) model = { ...model, id: requestedModel };
const requestedThinking = optionValue("--thinking");
if (requestedThinking) thinkingLevel = requestedThinking === "xhigh" ? "high" : requestedThinking;

const handshakeNonce = extensionPath
  ? /"handshakeNonce":\s*"([^"]+)"/u.exec(readFileSync(extensionPath, "utf8"))?.[1]
  : undefined;
const extensionTools = extensionPath
  ? [
      ...readFileSync(extensionPath, "utf8").matchAll(/"name":\s*"([a-z0-9_]+)",\n\s*"server"/gu),
    ].map((match) => match[1])
  : [];

// A session_start handler that throws means the handshake never happens; Pi
// reports only `extension_error` and carries on ungated (measured).
if (scenario !== "no-handshake" && scenario !== "extension-error") {
  send({
    id: "ui-handshake",
    message: `opensteer-extension-ready:${JSON.stringify({
      hasUi: scenario !== "no-ui",
      nonce: scenario === "stale-extension" ? "stale-nonce" : handshakeNonce,
      tools: extensionTools,
    })}`,
    method: "notify",
    notifyType: "info",
    type: "extension_ui_request",
  });
}
if (scenario === "extension-error") {
  send({
    error: "Cannot find module 'typebox'",
    event: "session_start",
    extensionPath,
    type: "extension_error",
  });
}

let buffered = Buffer.alloc(0);
let queue = [];
let streaming = false;
let pendingUi = new Map();
// `late-steer`: a steer the driver sent during the turn reaches Pi only after
// Pi has made its last queue check and settled.
let lateAnswerSteerArrived;
const lateAnswerSteer = new Promise((resolveSteer) => {
  lateAnswerSteerArrived = resolveSteer;
});
let lateCommand;
let lateCommandArrived;
const lateCommandSeen = new Promise((resolveSeen) => {
  lateCommandArrived = resolveSeen;
});

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  let index;
  while ((index = buffered.indexOf(0x0a)) >= 0) {
    const line = buffered.subarray(0, index).toString("utf8");
    buffered = buffered.subarray(index + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (scenario === "ignore-termination") setInterval(() => undefined, 1_000);
  // Let Node drain stdout before exiting. Large catalog responses exceed the
  // pipe's synchronous buffer and would otherwise be cut off mid-frame.
  else process.exitCode = 0;
});

function respond(message, extra = {}) {
  send({ command: message.type, id: message.id, success: true, type: "response", ...extra });
}

function handle(message) {
  capture(message);
  dispatch(message);
}

function dispatch(message) {
  switch (message.type) {
    case "get_state":
      respond(message, {
        data: {
          autoCompactionEnabled: true,
          isCompacting: false,
          isStreaming: streaming,
          messageCount: sessionArgument ? 2 : 0,
          model: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            contextWindow: 128_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: model.id,
            input: ["text"],
            maxTokens: 4_096,
            name: model.id,
            provider: model.provider,
            reasoning: false,
          },
          pendingMessageCount: 0,
          sessionFile: scenario === "wrong-session" ? `${sessionPath}.other` : sessionPath,
          sessionId:
            scenario === "wrong-session-id" ? "01a0ae00-0000-7000-8000-000000000000" : sessionId,
          thinkingLevel,
        },
      });
      break;
    case "set_model":
      if (scenario === "model-missing") {
        send({
          command: "set_model",
          error: `Model not found: ${message.provider}/${message.modelId}`,
          id: message.id,
          success: false,
          type: "response",
        });
        break;
      }
      model = { id: message.modelId, provider: message.provider };
      respond(message, { data: { id: model.id, provider: model.provider } });
      break;
    case "set_thinking_level":
      // Pi clamps silently to what the model supports (pi-facts §2), which is
      // why the driver reads the level back instead of trusting the success.
      thinkingLevel =
        scenario === "thinking-clamped" || message.level === "xhigh" ? "high" : message.level;
      respond(message);
      break;
    case "get_available_models":
      respond(message, { data: { models: availableModels() } });
      break;
    case "get_entries":
      respond(message, {
        data: {
          entries: message.since ? [] : [{ id: "d365b735", parentId: null, type: "message" }],
          leafId: "d365b735",
        },
      });
      break;
    case "prompt":
      if (scenario === "prompt-refused") {
        send({
          command: "prompt",
          error: "No API key found for the selected model.",
          id: message.id,
          success: false,
          type: "response",
        });
        break;
      }
      if (message.streamingBehavior && scenario === "late-steer" && lateCommand === undefined) {
        lateCommand = message;
        lateCommandArrived();
        break;
      }
      // While a run streams, a prompt with a streaming behavior is queued as
      // that kind of message; without one Pi refuses it. When idle it starts
      // a run of its own.
      if (streaming) {
        if (!message.streamingBehavior) {
          send({
            command: "prompt",
            error:
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
            id: message.id,
            success: false,
            type: "response",
          });
          break;
        }
        queue.push(message.message);
        send({ followUp: [], steering: queue, type: "queue_update" });
        respond(message);
        lateAnswerSteerArrived();
        break;
      }
      respond(message);
      void runTurn(message.message);
      break;
    case "steer":
    case "follow_up":
      if (scenario === "late-steer" && lateCommand === undefined) {
        lateCommand = message;
        lateCommandArrived();
        break;
      }
      // Pi queues these whether or not a run is streaming (pi-facts §2); a
      // message queued while idle waits for whatever runs next.
      queue.push(message.message);
      send({ followUp: [], steering: queue, type: "queue_update" });
      respond(message);
      break;
    case "clear_queue":
      queue = [];
      respond(message, { data: { followUp: [], steering: [] } });
      break;
    case "abort":
      aborted = true;
      // Pi answers `abort` only once the session is fully idle, and answers at
      // once when it already is (both measured; pi-facts §2).
      if (streaming) pendingAbort = message;
      else respond(message);
      break;
    case "extension_ui_response": {
      const resolve = pendingUi.get(message.id);
      pendingUi.delete(message.id);
      if (resolve) resolve(message.cancelled === true ? undefined : message.value);
      break;
    }
    default:
      respond(message);
      break;
  }
}

function availableModels() {
  if (scenario === "large-catalog" || scenario === "oversized-catalog") {
    const count = scenario === "large-catalog" ? 300 : 8_193;
    return Array.from({ length: count }, (_, index) => ({
      id: `gpt-test-${String(index).padStart(4, "0")}`,
      name: `GPT Test ${index}`,
      provider: "openai",
      reasoning: false,
    }));
  }
  return [
    {
      contextWindow: 200_000,
      id: "claude-opus-4-8",
      input: ["text", "image"],
      maxTokens: 64_000,
      name: "Claude Opus 4.8",
      provider: "anthropic",
      reasoning: true,
      thinkingLevelMap: {
        high: "high",
        low: "low",
        max: null,
        medium: "medium",
        minimal: "minimal",
        off: "off",
        xhigh: null,
      },
    },
    {
      contextWindow: 200_000,
      id: "claude-haiku-4-5",
      input: ["text"],
      maxTokens: 64_000,
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      reasoning: false,
    },
    {
      contextWindow: 128_000,
      id: "anthropic/claude-opus-4.8:free",
      maxTokens: 8_192,
      name: "Claude Opus 4.8 (free)",
      provider: "openrouter",
      reasoning: false,
    },
    {
      contextWindow: 128_000,
      id: "kimi-k2.6",
      maxTokens: 8_192,
      name: "Kimi K2.6",
      provider: "opencode-go",
      reasoning: false,
    },
    {
      contextWindow: 128_000,
      id: "gpt-5.5",
      maxTokens: 8_192,
      name: "GPT-5.5",
      provider: "openai",
      reasoning: false,
    },
  ];
}

let aborted = false;
let pendingAbort;

function ask(request) {
  const id = `ui-${pendingUi.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    pendingUi.set(id, resolve);
    send({
      id,
      method: "input",
      title: JSON.stringify({ ...request, v: 1 }),
      type: "extension_ui_request",
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(prompt) {
  streaming = true;
  aborted = false;
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    message: { content: [{ text: prompt, type: "text" }], role: "user", timestamp: 1 },
    type: "message_start",
  });

  if (scenario === "thinking") {
    send({
      assistantMessageEvent: { contentIndex: 0, type: "thinking_start" },
      type: "message_update",
    });
    send({
      assistantMessageEvent: { contentIndex: 0, delta: "weighing it up", type: "thinking_delta" },
      type: "message_update",
    });
    send({
      assistantMessageEvent: { content: "weighing it up", contentIndex: 0, type: "thinking_end" },
      type: "message_update",
    });
  }

  send({ assistantMessageEvent: { contentIndex: 0, type: "text_start" }, type: "message_update" });
  // A legal unescaped U+2028 inside a JSON string: Node's readline would split
  // here and lose the frame (pi-facts §2, docs/rpc.md:28-38).
  const text = scenario === "line-separator" ? "before\u2028after" : "All done.";
  send({
    assistantMessageEvent: { contentIndex: 0, delta: text, type: "text_delta" },
    type: "message_update",
  });

  if (scenario === "die-during-approval") {
    send({
      args: { command: "rm -rf /tmp/scratch" },
      toolCallId: "call_1",
      toolName: "bash",
      type: "tool_execution_start",
    });
    void ask({
      input: { command: "rm -rf /tmp/scratch" },
      kind: "command",
      toolCallId: "call_1",
      toolName: "bash",
    });
    // The process dies while the person is still looking at the approval.
    setTimeout(() => process.exit(9), 60);
    return;
  }

  if (scenario === "settle-with-approval-pending") {
    send({
      args: { command: "rm -rf /tmp/scratch" },
      toolCallId: "call_1",
      toolName: "bash",
      type: "tool_execution_start",
    });
    void ask({
      input: { command: "rm -rf /tmp/scratch" },
      kind: "command",
      toolCallId: "call_1",
      toolName: "bash",
    });
    // Pi settles while the approval is still open — a retry that gave up, or a
    // model that stopped asking.
    setTimeout(() => {
      streaming = false;
      writeSessionFile();
      send({ type: "agent_settled" });
    }, 60);
    return;
  }

  if (scenario === "approval" || scenario === "approval-file" || scenario === "approval-pending") {
    const command = scenario === "approval-file" ? undefined : "rm -rf /tmp/scratch";
    send({
      args: command ? { command } : { edits: [{ newText: "b", oldText: "a" }], path: "/w/app.ts" },
      toolCallId: "call_1",
      toolName: command ? "bash" : "edit",
      type: "tool_execution_start",
    });
    const answer = await ask(
      command
        ? { input: { command }, kind: "command", toolCallId: "call_1", toolName: "bash" }
        : {
            input: { edits: [{ newText: "b", oldText: "a" }], path: "/w/app.ts" },
            kind: "file-change",
            toolCallId: "call_1",
            toolName: "edit",
          },
    );
    const decision = answer ? JSON.parse(answer) : undefined;
    const allowed = decision?.decision === "allow";
    send({
      isError: !allowed,
      result: {
        content: [
          {
            text: allowed
              ? "ok"
              : (decision?.note ?? "Opensteer cancelled this approval before it was answered."),
            type: "text",
          },
        ],
      },
      toolCallId: "call_1",
      toolName: command ? "bash" : "edit",
      type: "tool_execution_end",
    });
  }

  if (scenario === "tool-during-approval") {
    // An approval and an Opensteer tool call in flight at once: the driver has
    // one channel for both and must not let either block the other.
    send({
      args: { command: "sleep 1" },
      toolCallId: "call_a",
      toolName: "bash",
      type: "tool_execution_start",
    });
    const approval = ask({
      input: { command: "sleep 1" },
      kind: "command",
      toolCallId: "call_a",
      toolName: "bash",
    });
    const name = extensionTools[0] ?? "thread_read";
    send({
      args: { query: "recent" },
      toolCallId: "call_b",
      toolName: name,
      type: "tool_execution_start",
    });
    const toolAnswer = JSON.parse(
      (await ask({
        arguments: { query: "recent" },
        kind: "tool",
        name,
        server: "opensteer",
        toolCallId: "call_b",
      })) ?? '{"content":[],"isError":true}',
    );
    send({
      isError: toolAnswer.isError === true,
      result: { content: toolAnswer.content ?? [] },
      toolCallId: "call_b",
      toolName: name,
      type: "tool_execution_end",
    });
    const decision = JSON.parse((await approval) ?? '{"decision":"deny"}');
    send({
      isError: decision.decision !== "allow",
      result: {
        content: [{ text: decision.decision === "allow" ? "ok" : "denied", type: "text" }],
      },
      toolCallId: "call_a",
      toolName: "bash",
      type: "tool_execution_end",
    });
  }

  if (scenario === "opensteer-tool" || scenario === "opensteer-tool-error") {
    const name = extensionTools[0] ?? "thread_read";
    send({
      args: { query: "recent" },
      toolCallId: "call_2",
      toolName: name,
      type: "tool_execution_start",
    });
    const answer = await ask({
      arguments: { query: "recent" },
      kind: "tool",
      name,
      server: "opensteer",
      toolCallId: "call_2",
    });
    const parsed = answer ? JSON.parse(answer) : { content: [], isError: true };
    send({
      isError: parsed.isError === true,
      result: { content: parsed.content ?? [] },
      toolCallId: "call_2",
      toolName: name,
      type: "tool_execution_end",
    });
  }

  if (scenario === "long-tool") {
    send({
      args: { command: "sleep 60" },
      toolCallId: "call_3",
      toolName: "bash",
      type: "tool_execution_start",
    });
    for (let tick = 0; tick < 200 && !aborted; tick += 1) await delay(20);
    send({
      isError: true,
      result: { content: [{ text: "Command aborted", type: "text" }] },
      toolCallId: "call_3",
      toolName: "bash",
      type: "tool_execution_end",
    });
    // Pi hands a steer queued during the tool to the model with its result,
    // before the model's next call (pi-facts §2).
    if (!aborted && queue.length > 0) {
      const next = queue.shift();
      send({ followUp: [], steering: queue, type: "queue_update" });
      send({
        message: { content: [{ text: next, type: "text" }], role: "user", timestamp: 2 },
        type: "message_start",
      });
    }
  }
  // `late-answer`: the model is writing its final answer when the steer arrives.
  if (scenario === "late-answer") await lateAnswerSteer;

  if (scenario === "retry") {
    send({
      attempt: 1,
      delayMs: 10,
      errorMessage: "529 overloaded",
      maxAttempts: 3,
      type: "auto_retry_start",
    });
    send({ attempt: 1, success: true, type: "auto_retry_end" });
  }

  if (scenario === "die-mid-turn") {
    process.exit(7);
  }

  const failing =
    scenario === "limit-error" || scenario === "auth-error" || scenario === "plain-error";
  send({
    message: {
      api: "openai-completions",
      content: failing ? [] : [{ text, type: "text" }],
      model: model.id,
      provider: model.provider,
      role: "assistant",
      stopReason: failing ? "error" : "stop",
      ...(failing
        ? {
            errorMessage:
              scenario === "limit-error"
                ? '429 {"error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}'
                : scenario === "auth-error"
                  ? '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}'
                  : "503 service unavailable",
          }
        : {}),
      timestamp: 2,
      // `input` is exclusive of cache reads (pi-facts §9).
      usage: {
        cacheRead: 1_000,
        cacheWrite: 25,
        cost: {
          cacheRead: 0.0001,
          cacheWrite: 0,
          input: 0.000234,
          output: 0.000112,
          total: 0.000446,
        },
        input: 234,
        output: 56,
        reasoning: 7,
        totalTokens: 1_315,
      },
    },
    type: "message_end",
  });
  send({ type: "turn_end" });
  send({ messages: [], type: "agent_end", willRetry: false });

  if (scenario === "late-steer") await lateCommandSeen;
  // Pi drains the queue after an abort unless it was cleared first (pi-facts §2).
  if (queue.length > 0) {
    const next = queue.shift();
    send({ followUp: [], steering: queue, type: "queue_update" });
    send({ type: "agent_start" });
    send({
      message: { content: [{ text: next, type: "text" }], role: "user", timestamp: 3 },
      type: "message_start",
    });
    send({
      message: {
        content: [{ text: `steered: ${next}`, type: "text" }],
        role: "assistant",
        stopReason: "stop",
        timestamp: 3,
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.0001 },
          input: 10,
          output: 2,
          reasoning: 0,
          totalTokens: 12,
        },
      },
      type: "message_end",
    });
    send({ messages: [], type: "agent_end", willRetry: false });
  }

  streaming = false;
  writeSessionFile();
  send({ type: "agent_settled" });
  if (pendingAbort) {
    respond(pendingAbort);
    pendingAbort = undefined;
  }
  if (lateCommand !== undefined && lateCommand !== null) {
    const late = lateCommand;
    lateCommand = null;
    dispatch(late);
  }
}

/** Pi writes the session file lazily, on the first message (pi-facts §3). */
function writeSessionFile() {
  if (scenario === "no-session-file") return;
  mkdirSync(dirname(sessionPath), { recursive: true });
  if (sessionArgument) return;
  writeFileSync(
    sessionPath,
    `${JSON.stringify({ cwd: process.cwd(), id: sessionId, timestamp: "2026-09-17T00:00:00.000Z", type: "session", version: 3 })}\n`,
  );
}

/**
 * The Pi release this tree installs. Its package exports no `package.json`,
 * so the manifest is read beside the entry the driver itself resolves.
 */
function installedPiVersion() {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
  let directory = dirname(entry);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return manifest.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Pi's package manifest is not above its entry");
    directory = parent;
  }
}
