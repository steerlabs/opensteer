import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
/**
 * A fake `opencode serve`.
 *
 * It speaks exactly the v1 routes the driver uses, in the shapes the real
 * server was observed to use, and records what it saw — argv, its own
 * environment, the configuration file the driver wrote, and every request — to
 * the file named by `--capture=` or `FAKE_OPENCODE_CAPTURE_PATH` so a test can
 * assert on it.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const scenarioArgument = process.argv.find((argument) => argument.startsWith("--scenario="));
const scenario =
  scenarioArgument?.slice("--scenario=".length) ?? process.env.FAKE_OPENCODE_SCENARIO ?? "happy";
const capturePath =
  process.argv.find((argument) => argument.startsWith("--capture="))?.slice("--capture=".length) ??
  process.env.FAKE_OPENCODE_CAPTURE_PATH;
// The fake answers as the OpenCode release this tree installs, so a version
// bump never has to edit it.
const version = createRequire(import.meta.url)("opencode-ai/package.json").version;
const password = process.env.OPENCODE_SERVER_PASSWORD;

if (process.argv.includes("run")) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  capture({ kind: "naming", prompt, pid: process.pid });
  process.stdout.write(
    JSON.stringify({ type: "text", part: { text: "Support migration\nheadphones" } }) + "\n",
  );
  process.exit(0);
}

const sessionId = "ses_fake000000000000000000001";
const assistantMessageId = "msg_fake00000000000000000001";
const knownSessions = new Set([sessionId]);
/** Sessions this fixture pretends already exist, for the resume scenarios. */
if (process.env.FAKE_OPENCODE_EXISTING_SESSION) {
  knownSessions.add(process.env.FAKE_OPENCODE_EXISTING_SESSION);
}

let savedPermissions =
  scenario === "saved-permissions"
    ? [
        { id: "psv_fake1", action: "external_directory", resource: "/private/etc/*" },
        { id: "psv_fake2", action: "bash", resource: "rm *" },
      ]
    : [];
/** @type {import("node:http").ServerResponse[]} */
const streams = [];
let created = 0;
let replyRefused = false;
/** How long an abort takes to wind the turn down, for `steer-restart`. */
const abortDelayMs = Number(
  process.argv.find((argument) => argument.startsWith("--abort-delay-ms="))?.slice(17) ?? 5,
);
/** When set, a held `steer-restart` turn finishes by itself after this long. */
const holdMs = Number(
  process.argv.find((argument) => argument.startsWith("--hold-ms="))?.slice(10) ?? 0,
);
/** How long a `steer-restart` turn that is not held takes to answer. */
const answerDelayMs = Number(
  process.argv.find((argument) => argument.startsWith("--answer-delay-ms="))?.slice(18) ?? 0,
);
/** @type {NodeJS.Timeout | undefined} */
let heldTurn;

capture({ kind: "process", argv: process.argv.slice(2), environment: { ...process.env } });
capture({ kind: "config", config: readConfiguration(), configMode: configurationMode() });

if (scenario === "spawn-failure") {
  process.stderr.write("fake opencode: database is locked\n");
  process.exit(3);
}

const server = createServer((request, response) => {
  if (
    ignoreForeignTestRequest(
      request,
      response,
      (path) =>
        ["/global/health", "/api/permission/saved", "/provider", "/session", "/event"].includes(
          path,
        ) ||
        path.startsWith("/api/permission/saved/") ||
        path.startsWith("/session/"),
    )
  )
    return;
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    capture({
      kind: "request",
      method: request.method,
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      authorized: Boolean(request.headers.authorization),
      body: body || undefined,
    });
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    route(url, request, response, body ? JSON.parse(body) : undefined);
  });
});

server.listen(0, "127.0.0.1", () => {
  void probeTestServer(server).then(() => {
    const address = server.address();
    const announce = () =>
      process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
    if (scenario === "slow-start") setTimeout(announce, 2_000);
    else announce();
  });
});

function route(url, request, response, payload) {
  const path = url.pathname;
  if (path === "/global/health") {
    json(response, {
      healthy: true,
      version: scenario === "version-mismatch" ? "0.0.0" : version,
    });
    return;
  }
  if (path === "/api/permission/saved" && request.method === "GET") {
    if (scenario === "saved-permissions-failure") {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({}));
      return;
    }
    json(response, { data: savedPermissions });
    return;
  }
  if (path.startsWith("/api/permission/saved/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/permission/saved/".length));
    savedPermissions = savedPermissions.filter((row) => row.id !== id);
    response.writeHead(204).end();
    return;
  }
  if (path === "/provider") {
    if (scenario === "oversized-body") {
      json(response, { all: [], connected: [], default: {}, padding: "x".repeat(256 * 1024) });
      return;
    }
    json(response, providerList());
    return;
  }
  if (path === "/session" && request.method === "POST") {
    created += 1;
    const id = created === 1 ? sessionId : `${sessionId}${created}`;
    knownSessions.add(id);
    json(response, { id, directory: url.searchParams.get("directory"), title: "" });
    return;
  }
  if (path === "/event") {
    // A server that accepts the connection and never answers: the driver's
    // handshake deadline is the only thing that can end this.
    if (scenario === "no-sse") return;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    // The real server sends `server.connected` the moment the stream opens,
    // which is also what flushes the response headers to the client.
    response.write(
      `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", properties: {} })}\n\n`,
    );
    streams.push(response);
    // The response, not the request: a body-less GET's request object closes
    // as soon as it is read, while the stream stays open.
    response.on("close", () => {
      const index = streams.indexOf(response);
      if (index >= 0) streams.splice(index, 1);
    });
    return;
  }
  const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/u.exec(path);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const suffix = sessionMatch[2] ?? "";
    if (!knownSessions.has(id)) {
      response
        .writeHead(404, { "content-type": "application/json" })
        .end(
          JSON.stringify({ name: "NotFoundError", data: { message: `Session not found: ${id}` } }),
        );
      return;
    }
    if (suffix === "") {
      json(response, { id, directory: url.searchParams.get("directory") });
      return;
    }
    if (suffix === "/prompt_async") {
      response.writeHead(204).end();
      setTimeout(() => runScenario(id, payload), 5);
      return;
    }
    if (suffix === "/abort") {
      clearTimeout(heldTurn);
      if (scenario === "subagents-hold" && id === sessionId) {
        // The task tool cancels its child when its parent is aborted.
        emit("session.error", {
          sessionID: childSessionId,
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        });
        emit("session.idle", { sessionID: childSessionId });
        rootTaskPart("call_task_1", "error", { error: "Task cancelled" });
      }
      if (scenario === "interrupt-delayed-idle") {
        // The turn winds down, but not instantly: the driver must stop waiting
        // when it settles rather than at its deadline.
        json(response, true);
        setTimeout(() => emit("session.idle", { sessionID: id }), 400);
        return;
      }
      if (scenario === "interrupt-blocked-approval") {
        // A real abort does not answer the row the model is blocked on, so the
        // turn cannot reach idle until something else does.
        json(response, true);
        return;
      }
      setTimeout(
        () => {
          emit("session.error", {
            sessionID: id,
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          });
          emit("session.idle", { sessionID: id });
        },
        scenario === "steer-restart" ? abortDelayMs : 5,
      );
      json(response, true);
      return;
    }
  }
  const permissionMatch = /^\/permission\/([^/]+)\/reply$/u.exec(path);
  if (permissionMatch) {
    const id = decodeURIComponent(permissionMatch[1]);
    // The first reply is refused; a retry of the same Request is accepted.
    if (scenario === "reply-failure" && !replyRefused) {
      replyRefused = true;
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ name: "UnknownError", data: { message: "reply exploded" } }));
      return;
    }
    if (id === "per_child1") {
      emit("permission.replied", {
        sessionID: childSessionId,
        requestID: id,
        reply: payload.reply,
      });
      setTimeout(finishSubagents, 5);
      json(response, true);
      return;
    }
    emit("permission.replied", { sessionID: sessionId, requestID: id, reply: payload.reply });
    setTimeout(() => finishAfterApproval(payload), 5);
    json(response, true);
    return;
  }
  const questionRejectMatch = /^\/question\/([^/]+)\/reject$/u.exec(path);
  if (questionRejectMatch) {
    json(response, true);
    return;
  }
  const questionMatch = /^\/question\/([^/]+)\/reply$/u.exec(path);
  if (questionMatch) {
    const id = decodeURIComponent(questionMatch[1]);
    if (scenario === "question-reply-failure" && !replyRefused) {
      replyRefused = true;
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ name: "UnknownError", data: { message: "reply exploded" } }));
      return;
    }
    emit("question.replied", {
      sessionID: sessionId,
      requestID: id,
      answers: payload.answers,
    });
    setTimeout(() => {
      toolPart("que_call_1", "question", "completed", {
        input: { questions: [] },
        output: `User has answered your questions: ${JSON.stringify(payload.answers)}`,
      });
      step({ input: 20, output: 5 }, 0);
      emit("session.idle", { sessionID: sessionId });
    }, 5);
    json(response, true);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({}));
}

function runScenario(id, payload) {
  capture({ kind: "prompt", pid: process.pid, sessionID: id, payload });
  assistantMessage();
  switch (scenario) {
    case "subagents":
    case "subagents-early-ask":
    case "subagents-hold":
    case "subagents-resume-early": {
      knownSessions.add(childSessionId);
      emit("session.created", {
        sessionID: childSessionId,
        info: {
          id: childSessionId,
          parentID: id,
          title: "Research release notes (@general subagent)",
        },
      });
      // A child's ask can arrive before the task call names its session.
      if (scenario === "subagents-early-ask" || scenario === "subagents-resume-early") childAsk();
      rootTaskPart("call_task_1", "running");
      emit("message.updated", {
        info: {
          id: "msg_child1",
          modelID: "union-alpha",
          providerID: "opencode",
          role: "assistant",
          sessionID: childSessionId,
        },
      });
      childToolPart("running", {});
      if (scenario === "subagents") childAsk();
      return;
    }
    case "steer-restart": {
      // A turn asked to hold works until it is aborted; any other answers
      // with exactly what it was asked, so a restart's input is observable.
      const asked = (payload.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" | ");
      if (asked.includes("[hold]")) {
        textPart("Working on the original request.");
        step({ input: 40, output: 9 }, 0.01);
        if (holdMs > 0) {
          heldTurn = setTimeout(() => emit("session.idle", { sessionID: id }), holdMs);
        }
        return;
      }
      setTimeout(() => {
        textPart(`Answered: ${asked}`);
        step({ input: 30, output: 8 }, 0.02);
        emit("session.idle", { sessionID: id });
      }, answerDelayMs);
      return;
    }
    case "approval":
    case "interrupt-pending-approval":
    case "interrupt-blocked-approval":
      emit("permission.asked", {
        id: "per_fake1",
        sessionID: id,
        permission: "bash",
        patterns: ["echo hi"],
        metadata: { command: "echo hi" },
        always: ["echo *"],
        tool: { messageID: assistantMessageId, callID: "call_fake_1" },
      });
      return;
    case "file-approval":
      emit("permission.asked", {
        id: "per_fake_file",
        sessionID: id,
        permission: "edit",
        patterns: ["notes.txt"],
        metadata: { filepath: "/workspace/notes.txt", diff: "--- a\n+++ b\n+HELLO" },
        always: [],
        tool: { messageID: assistantMessageId, callID: "call_fake_edit" },
      });
      return;
    case "question":
    case "question-reply-failure":
      emit("question.asked", {
        id: "que_fake1",
        sessionID: id,
        questions: [
          {
            question: "Deploy where?",
            header: "Deploy",
            options: [
              { label: "Staging", description: "Deploy to staging" },
              { label: "Production", description: "Deploy to production" },
            ],
          },
        ],
        tool: { messageID: assistantMessageId, callID: "que_call_1" },
      });
      return;
    case "interrupt":
    case "interrupt-delayed-idle":
      // The turn never settles on its own; only an abort ends it.
      return;
    case "usage-limit":
      emit("session.error", {
        sessionID: id,
        error: {
          name: "APIError",
          data: {
            message: "Rate limit reached for the account.",
            statusCode: 429,
            isRetryable: true,
          },
        },
      });
      step({ input: 11, output: 3 }, 0);
      emit("session.idle", { sessionID: id });
      return;
    case "message-error":
      // An error on the assistant message, then the ordinary idle. The Run must
      // not read that idle as a completion.
      step({ input: 7, output: 1 }, 0);
      emit("message.updated", {
        info: {
          ...assistantInfo(),
          finish: "error",
          error: { name: "UnknownError", data: { message: "the model exploded" } },
        },
      });
      emit("session.idle", { sessionID: id });
      return;
    case "retry":
      emit("session.status", {
        sessionID: id,
        status: { type: "retry", attempt: 1, message: "Upstream is busy", next: 0 },
      });
      textPart("Recovered.");
      step({ input: 5, output: 2 }, 0);
      emit("session.idle", { sessionID: id });
      return;
    case "reasoning":
      reasoningPart("Weighing the options");
      textPart("Done.");
      step({ input: 9, output: 4 }, 0);
      emit("session.idle", { sessionID: id });
      return;
    case "post-terminal-content":
      // The turn ends, and only then does more of it arrive: a late part
      // snapshot, a late delta, a late tool result, and a permission nobody can
      // answer any more.
      textPart("Finished.");
      step({ input: 3, output: 1 }, 0);
      emit("session.idle", { sessionID: id });
      setTimeout(() => {
        emit("message.part.updated", {
          sessionID: id,
          time: 3,
          part: {
            id: "prt_text_late",
            sessionID: id,
            messageID: assistantMessageId,
            type: "text",
            text: "LATE TEXT",
            time: { start: 3, end: 4 },
          },
        });
        emit("message.part.delta", {
          sessionID: id,
          messageID: assistantMessageId,
          partID: "prt_text_late",
          field: "text",
          delta: "LATE DELTA",
        });
        toolPart("call_late", "bash", "completed", {
          input: { command: "echo late" },
          output: "late",
        });
        emit("permission.asked", {
          id: "per_orphan",
          sessionID: id,
          permission: "bash",
          patterns: ["echo orphan"],
          metadata: { command: "echo orphan" },
          always: [],
          tool: { messageID: assistantMessageId, callID: "call_orphan" },
        });
      }, 20);
      return;
    case "unknown-ask":
      // A blocking ask this driver does not know: the model is stuck inside
      // OpenCode and `session.idle` will never arrive.
      emit("question.v2.asked", {
        id: "per_v2",
        sessionID: id,
        questions: [{ question: "Deploy where?", header: "Deploy", options: [] }],
      });
      return;
    case "oversized-line":
      emit("noop", { sessionID: id, padding: "x".repeat(64 * 1024) });
      return;
    case "oversized-padded-line":
      // A short event whose line is padded past the limit with whitespace, in
      // one write so it arrives as a single complete line: trimming before
      // measuring would hide it.
      for (const stream of streams) {
        stream.write(
          `data: ${JSON.stringify({ id: "evt_pad", type: "noop", properties: {} })}${" ".repeat(20 * 1024)}\n\n`,
        );
      }
      return;
    case "reply-failure":
      emit("permission.asked", {
        id: "per_fake1",
        sessionID: id,
        permission: "bash",
        patterns: ["echo hi"],
        metadata: { command: "echo hi" },
        always: [],
        tool: { messageID: assistantMessageId, callID: "call_fake_1" },
      });
      return;
    case "stream-drop":
      for (const stream of streams.splice(0)) stream.destroy();
      return;
    case "two-steps":
      toolPart("call_fake_1", "opensteer_thread_read", "running", { input: { threadId: "t1" } });
      toolPart("call_fake_1", "opensteer_thread_read", "completed", {
        input: { threadId: "t1" },
        output: "OPENSTEER_TOOL_OK",
      });
      step({ input: 100, output: 10, reasoning: 2, cache: { read: 4, write: 6 } }, 0.25);
      textPart("All done.");
      step({ input: 50, output: 20, reasoning: 0, cache: { read: 8, write: 0 } }, 0.5);
      emit("session.idle", { sessionID: id });
      return;
    case "streamed-tool-arguments":
      toolPart("call_gateway", "opensteer_integrations_integration_call", "running", {
        input: {},
      });
      toolPart("call_gateway", "opensteer_integrations_integration_call", "completed", {
        input: { toolRef: "igr_grant.itl_tool.digest", arguments: { query: "hello" } },
        output: "done",
      });
      toolPart("call_gateway", "opensteer_integrations_integration_call", "completed", {
        output: "done",
      });
      toolPart("call_bash", "bash", "running", {
        input: { command: "echo hi", description: "A full input" },
      });
      toolPart("call_bash", "bash", "completed", {
        output: "hi",
      });
      step({ input: 10, output: 4 }, 0);
      emit("session.idle", { sessionID: id });
      return;
    default:
      toolPart("call_fake_1", "bash", "running", { input: { command: "echo hi" } });
      toolPart("call_fake_1", "bash", "completed", {
        input: { command: "echo hi" },
        output: "hi",
      });
      textPart("Completed by OpenCode.");
      step({ input: 12, output: 6 }, 0);
      emit("session.idle", { sessionID: id });
      return;
  }
}

function finishAfterApproval(payload) {
  if (scenario === "interrupt-pending-approval") return;
  if (scenario === "interrupt-blocked-approval") {
    // Only answering the permission releases this turn, which is what makes
    // the driver's ordering observable.
    emit("session.idle", { sessionID: sessionId });
    return;
  }
  toolPart(
    "call_fake_1",
    scenario === "file-approval" ? "write" : "bash",
    payload.reply === "reject" ? "error" : "completed",
    payload.reply === "reject"
      ? {
          input: { command: "echo hi" },
          error: `The user rejected permission to use this specific tool call with the following feedback: ${payload.message ?? ""}`,
        }
      : { input: { command: "echo hi" }, output: "hi" },
  );
  textPart("Understood.");
  step({ input: 30, output: 9 }, 0);
  emit("session.idle", { sessionID: sessionId });
}

function providerList() {
  if (scenario === "cold-catalog") return { all: [], connected: [], default: {} };
  if (scenario === "large-catalog" || scenario === "oversized-catalog") {
    const count = scenario === "large-catalog" ? 300 : 8_193;
    const models = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const id = `claude-test-${String(index).padStart(4, "0")}`;
        return [id, { id, name: `Claude Test ${index}` }];
      }),
    );
    return {
      all: [{ id: "anthropic", name: "Anthropic", models }],
      connected: ["anthropic"],
      default: { anthropic: "claude-test-0000" },
    };
  }
  if (scenario === "default-alias") {
    return {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "openai/gpt-5.5": { id: "openai/gpt-5.5", name: "GPT 5.5 routed" },
            "gpt-5.5": { id: "gpt-5.5", name: "GPT 5.5 default" },
          },
        },
      ],
      connected: ["openrouter"],
      default: { openrouter: "gpt-5.5" },
    };
  }
  if (scenario === "zen-free" || scenario === "steer-restart" || scenario.startsWith("subagents")) {
    return {
      all: [
        {
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            "union-alpha": {
              id: "union-alpha",
              // The shape `GET /provider` serves: OpenCode's own capabilities,
              // built from the models.dev row, not the row's `modalities`.
              capabilities: { input: { image: false, pdf: false, text: true } },
              name: "Union Alpha Free",
              variants: {},
            },
            // No capabilities at all, so this one declares nothing.
            "ling-3.0-flash-fin-free": {
              id: "ling-3.0-flash-fin-free",
              name: "Ling 3.0 Flash Fin Free",
              variants: { low: {}, medium: {}, high: {} },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { opencode: "union-alpha" },
    };
  }
  if (scenario === "no-default") {
    // OpenCode names a default its own model list does not contain.
    return {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
            "claude-haiku-4-6": { id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
          },
        },
      ],
      connected: ["anthropic"],
      default: { anthropic: "claude-opus-4-6" },
    };
  }
  if (scenario === "not-connected") {
    return {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6" } },
        },
      ],
      connected: [],
      default: {},
    };
  }
  if (scenario === "openrouter-catalog") {
    return {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "google/gemma-4-31b-it:free": {
              id: "google/gemma-4-31b-it:free",
              name: "Gemma 4 31B (free)",
              variants: {},
            },
            "nvidia/nemotron-3-ultra:free": {
              id: "nvidia/nemotron-3-ultra:free",
              name: "Nemotron 3 Ultra (free)",
              variants: {},
            },
          },
        },
      ],
      connected: ["openrouter"],
      default: { openrouter: "google/gemma-4-31b-it:free" },
    };
  }
  if (scenario === "go-catalog") {
    return {
      all: [
        {
          id: "opencode-go",
          name: "OpenCode Go",
          models: {
            "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", variants: { low: {}, high: {}, max: {} } },
            "kimi-k3": { id: "kimi-k3", name: "Kimi K3" },
          },
        },
      ],
      connected: ["opencode-go"],
      default: { "opencode-go": "glm-5.3" },
    };
  }
  if (scenario === "compatible") {
    return {
      all: [{ id: "opensteer", name: "Lab endpoint", models: {} }],
      connected: ["opensteer"],
      default: {},
    };
  }
  return {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            capabilities: { input: { image: true, pdf: true, text: true } },
            name: "Claude Sonnet 4.6",
            variants: { low: {}, medium: {}, high: {}, max: {} },
          },
        },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "claude-sonnet-4-6" },
  };
}

function assistantInfo() {
  return {
    id: assistantMessageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_user_1",
    modelID: "union-alpha",
    providerID: "opencode",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function assistantMessage() {
  emit("message.updated", { info: assistantInfo() });
  // A user-message part must never be mistaken for the assistant's own.
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 1,
    part: {
      id: "prt_user_1",
      sessionID: sessionId,
      messageID: "msg_user_1",
      type: "text",
      text: "the person's own prompt",
      time: { start: 1, end: 2 },
    },
  });
}

function textPart(text) {
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 1,
    part: {
      id: "prt_text_1",
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "text",
      text: "",
      time: { start: 1 },
    },
  });
  const half = Math.ceil(text.length / 2);
  for (const delta of [text.slice(0, half), text.slice(half)]) {
    emit("message.part.delta", {
      sessionID: sessionId,
      messageID: assistantMessageId,
      partID: "prt_text_1",
      field: "text",
      delta,
    });
  }
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 2,
    part: {
      id: "prt_text_1",
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "text",
      text,
      time: { start: 1, end: 2 },
    },
  });
}

function reasoningPart(text) {
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 1,
    part: {
      id: "prt_reasoning_1",
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "reasoning",
      text: "",
      time: { start: 1 },
    },
  });
  emit("message.part.delta", {
    sessionID: sessionId,
    messageID: assistantMessageId,
    partID: "prt_reasoning_1",
    field: "text",
    delta: text,
  });
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 2,
    part: {
      id: "prt_reasoning_1",
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "reasoning",
      text,
      time: { start: 1, end: 2 },
    },
  });
}

function toolPart(callId, tool, status, state) {
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 1,
    part: {
      id: `prt_tool_${callId}`,
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "tool",
      callID: callId,
      tool,
      state: { status, ...state, time: { start: 1, ...(status === "running" ? {} : { end: 2 }) } },
    },
  });
}

function step(tokens, cost) {
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 2,
    part: {
      id: `prt_step_${Math.random().toString(36).slice(2)}`,
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: "step-finish",
      reason: "stop",
      cost,
      tokens: { cache: { read: 0, write: 0 }, reasoning: 0, ...tokens },
    },
  });
}

function emit(type, properties) {
  const line = `data: ${JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, properties })}\n\n`;
  for (const stream of streams) stream.write(line);
}

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function authorized(request) {
  if (!password) return true;
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const [user, secret] = Buffer.from(header.slice("Basic ".length), "base64")
    .toString("utf8")
    .split(":");
  return user === "opencode" && secret === password;
}

function configurationPath() {
  return join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
}

function readConfiguration() {
  try {
    return JSON.parse(readFileSync(configurationPath(), "utf8"));
  } catch {
    return null;
  }
}

function configurationMode() {
  try {
    return statSync(configurationPath()).mode & 0o777;
  } catch {
    return null;
  }
}

function capture(entry) {
  if (capturePath) appendFileSync(capturePath, `${JSON.stringify(entry)}\n`);
}

const childSessionId = "ses_fakechild00000000000000001";

function rootTaskPart(callId, status, extra = {}) {
  emit("message.part.updated", {
    sessionID: sessionId,
    time: 1,
    part: {
      callID: callId,
      id: `prt_${callId}`,
      messageID: assistantMessageId,
      sessionID: sessionId,
      state: {
        input: {
          description: "Research release notes",
          prompt: "Look up the release notes",
          subagent_type: "general",
        },
        metadata: {
          model: { modelID: "union-alpha", providerID: "opencode" },
          sessionId: childSessionId,
        },
        status,
        time: { start: 1, ...(status === "running" ? {} : { end: 2 }) },
        title: "Research release notes",
        ...extra,
      },
      tool: "task",
      type: "tool",
    },
  });
}

function childToolPart(status, extra) {
  emit("message.part.updated", {
    sessionID: childSessionId,
    time: 1,
    part: {
      callID: "call_child_bash",
      id: "prt_child_bash",
      messageID: "msg_child1",
      sessionID: childSessionId,
      state: { input: { command: "cat NOTES.md" }, status, time: { start: 1 }, ...extra },
      tool: "bash",
      type: "tool",
    },
  });
}

function childAsk() {
  emit("permission.asked", {
    always: [],
    id: "per_child1",
    metadata: { command: "cat NOTES.md" },
    patterns: ["cat NOTES.md"],
    permission: "bash",
    sessionID: childSessionId,
    tool: { callID: "call_child_bash", messageID: "msg_child1" },
  });
}

function childAnswer(messageId, text) {
  emit("message.updated", {
    info: {
      id: messageId,
      modelID: "union-alpha",
      providerID: "opencode",
      role: "assistant",
      sessionID: childSessionId,
    },
  });
  emit("message.part.updated", {
    sessionID: childSessionId,
    time: 2,
    part: {
      id: `prt_${messageId}_text`,
      messageID: messageId,
      sessionID: childSessionId,
      text,
      time: { start: 1, end: 2 },
      type: "text",
    },
  });
  emit("message.part.updated", {
    sessionID: childSessionId,
    time: 2,
    part: {
      cost: 0,
      id: `prt_${messageId}_step`,
      messageID: messageId,
      reason: "stop",
      sessionID: childSessionId,
      tokens: { cache: { read: 0, write: 0 }, input: 20, output: 5, reasoning: 0 },
      type: "step-finish",
    },
  });
  emit("session.idle", { sessionID: childSessionId });
}

/**
 * The child finishes, is resumed by a second task call, and the root answers.
 * In `subagents-resume-early` the resumed child speaks before the call that
 * resumed it names its session, as its first invocation asked before its own.
 */
function finishSubagents() {
  childToolPart("completed", { output: "v2 ships Friday", time: { start: 1, end: 2 } });
  childAnswer("msg_child1", "The release notes say v2 ships Friday.");
  rootTaskPart("call_task_1", "completed", {
    output: `<task id="${childSessionId}" state="completed">\n<task_result>The release notes say v2 ships Friday.</task_result>\n</task>`,
  });
  if (scenario === "subagents-resume-early") {
    childAnswer("msg_child2", "Confirmed: Friday.");
    rootTaskPart("call_task_2", "running");
  } else {
    rootTaskPart("call_task_2", "running");
    childAnswer("msg_child2", "Confirmed: Friday.");
  }
  rootTaskPart("call_task_2", "completed", {
    output: `<task id="${childSessionId}" state="completed">\n<task_result>Confirmed: Friday.</task_result>\n</task>`,
  });
  textPart("The researcher confirmed Friday.");
  step({ input: 30, output: 8 }, 0);
  emit("session.idle", { sessionID: sessionId });
}
