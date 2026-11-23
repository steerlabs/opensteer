import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const helper = "/app/native-fs-helper/opensteer-native-fs";
// The image puts no codex on PATH: the Runner resolves the Codex package it
// declares, so the smoke test resolves the same executable the same way.
const codexExecutable = (() => {
  const codexRequire = createRequire(
    createRequire("/app/package.json").resolve("@openai/codex/package.json"),
  );
  const platformManifest = codexRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`);
  const triple =
    process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  return join(dirname(platformManifest), "vendor", triple, "bin", "codex");
})();

function request(input) {
  const result = spawnSync(helper, [], {
    encoding: "utf8",
    timeout: 10_000,
    input: JSON.stringify({ ...input, root: "/workspace", rootPolicy: "isolated-mount" }),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? "Native filesystem helper failed",
    );
  }
  const response = JSON.parse(result.stdout);
  if (!response.ok) throw new Error(response.error?.message ?? "Native filesystem request failed");
  return response.result;
}

const probe = request({ operation: "probe" });
if (probe.containment !== "linux-openat2" || probe.platform !== "linux") {
  throw new Error("Runner native filesystem containment is unavailable");
}
const write = request({ content: "hello", operation: "write", path: "hello.txt" });
const read = request({ operation: "read", path: "hello.txt" });
const list = request({ maxDepth: 1, maxEntries: 10, operation: "list", path: "." });
if (
  write.bytesWritten !== 5 ||
  read.contentBase64 !== "aGVsbG8=" ||
  list.entries?.length !== 1 ||
  list.entries[0]?.path !== "hello.txt"
) {
  throw new Error("Runner native filesystem operations returned unexpected results");
}
const child = spawnSync("/bin/true", [], { timeout: 10_000 });
if (child.error || child.status !== 0) throw new Error("Runner Node child process failed");
const pidfdSignal = spawnSync(helper, ["--runtime-pidfd-signal-probe"], {
  encoding: "utf8",
  timeout: 10_000,
});
if (pidfdSignal.error || pidfdSignal.status !== 0) {
  throw new Error(
    pidfdSignal.error?.message ?? pidfdSignal.stderr.trim() ?? "Runner pidfd signal probe failed",
  );
}

// Codex's own sandbox, exactly as the Codex driver selects it for a Run: its
// bundled bubblewrap in the Runner container, under Codex's own sandbox modes.
const codexHome = "/workspace/codex-home";
const runWorkspace = "/workspace/run";
const otherDirectory = "/workspace/other";
for (const directory of [codexHome, runWorkspace, otherDirectory]) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
}
writeFileSync(`${codexHome}/auth.json`, "{}\n", { mode: 0o600 });

function runCodexSandbox(mode, command) {
  return spawnSync(
    codexExecutable,
    ["-c", `sandbox_mode=${JSON.stringify(mode)}`, "sandbox", "--", "/bin/sh", "-c", command],
    {
      cwd: runWorkspace,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 15_000,
    },
  );
}

function expectCodexSandbox(mode, label, command) {
  const result = runCodexSandbox(mode, command);
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${result.error?.message ?? result.stderr.trim() ?? "failed"}`);
  }
  return result.stdout;
}

expectCodexSandbox(
  "workspace-write",
  "Codex workspace-write must write its workspace and nothing outside it",
  `printf sandbox-ok > ${runWorkspace}/workspace-write.txt && ! touch ${otherDirectory}/escape.txt 2>/dev/null`,
);
if (readFileSync(`${runWorkspace}/workspace-write.txt`, "utf8") !== "sandbox-ok") {
  throw new Error("Codex workspace-write did not write its workspace");
}
if (existsSync(`${otherDirectory}/escape.txt`)) {
  throw new Error("Codex workspace-write wrote outside its workspace");
}
expectCodexSandbox(
  "read-only",
  "Codex read-only must read files and write nothing",
  `test "$(cat /workspace/hello.txt)" = hello && ! touch ${runWorkspace}/read-only.txt 2>/dev/null`,
);

// Machine access reaches another computer through a Unix socket; outside Full
// access Codex's sandbox denies it, which is why a Codex Run outside Full
// access is told it has no computers.
const launchDirectory = mkdtempSync("/tmp/opensteer-");
const relaySocket = `${launchDirectory}/relay.sock`;
const relay = spawn("socat", [`UNIX-LISTEN:${relaySocket},fork`, "SYSTEM:echo relay-ok"], {
  stdio: "ignore",
});
try {
  await waitForSocket(relaySocket);
  const blocked = runCodexSandbox("workspace-write", `echo | socat - UNIX-CONNECT:${relaySocket}`);
  if (blocked.status === 0 && blocked.stdout.trim() === "relay-ok") {
    throw new Error("Codex workspace-write must not reach the relay socket");
  }
} finally {
  relay.kill("SIGTERM");
}

// Stop reaps a Run's descendants with the Runner's own containment, the module
// that ships: one that left the process group, and one in a session of its own.
const { ExecutionContainment } = await import("/tmp/execution-containment.mjs");
mkdirSync("/workspace/runner-data", { mode: 0o700, recursive: true });
const containment = new ExecutionContainment({
  bootId: "rbt_smoke",
  dataDirectory: "/workspace/runner-data",
});
const launch = containment.wrap(
  "smoke-run",
  (input) => input,
)({
  args: ["-c", "sleep 300 & setsid sleep 301 & wait"],
  cwd: "/workspace",
  environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  executable: "/bin/sh",
});
const run = spawn(launch.executable, launch.args, {
  cwd: launch.cwd,
  env: launch.environment,
  stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 500));
if ((await containment.liveRoots("smoke-run")) < 1) {
  throw new Error("The smoke Run's processes did not carry its scope");
}
const termination = await containment.terminate("smoke-run", async () => {
  run.kill("SIGTERM");
});
if (termination !== "proven") {
  throw new Error(`Stop did not prove a Run's descendants gone: ${termination}`);
}
const survivors = spawnSync("/bin/sh", ["-c", "ps -eo args | grep -c '^sleep 30[01]$' || true"], {
  encoding: "utf8",
});
if (survivors.stdout.trim() !== "0") throw new Error("A Run's descendant outlived its Stop");

// Stop on the shared Codex app-server: turn/interrupt followed immediately by
// thread/unsubscribe closes the stopped conversation without touching a
// neighbour, whereas thread/unsubscribe alone does not close a turn in flight.
await verifyCodexAppServerStop();

console.log("Runner container runtime smoke passed");

async function verifyCodexAppServerStop() {
  const stopHome = "/workspace/codex-stop-home";
  mkdirSync(stopHome, { mode: 0o700, recursive: true });
  writeFileSync(`${stopHome}/auth.json`, "{}\n", { mode: 0o600 });

  const stub = await startCodexResponsesStub();
  writeFileSync(
    `${stopHome}/config.toml`,
    [
      'model = "gpt-5.4"',
      'model_provider = "loopback"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'cli_auth_credentials_store = "file"',
      "",
      "[model_providers.loopback]",
      'name = "Loopback stub"',
      `base_url = "http://127.0.0.1:${stub.port}/v1"`,
      'env_key = "OPENSTEER_SOURCE_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const server = spawn(
    codexExecutable,
    [
      "-c",
      'web_search="disabled"',
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "allow_login_shell=false",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "thread_unload_delay_secs=0",
      "app-server",
      "--stdio",
    ],
    {
      cwd: runWorkspace,
      env: {
        ...process.env,
        CODEX_HOME: stopHome,
        HOME: stopHome,
        OPENSTEER_SOURCE_API_KEY: "loopback-smoke-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stderrLines = [];
  const messages = [];
  const events = new EventEmitter();
  server.stdin.on("error", () => {});
  createInterface({ input: server.stdout }).on("line", (line) => {
    try {
      const parsed = JSON.parse(line);
      messages.push(parsed);
      events.emit("message", parsed);
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  });
  createInterface({ input: server.stderr }).on("line", (line) => {
    if (stderrLines.length < 40) stderrLines.push(line);
  });

  let nextId = 1;
  const send = (message) => {
    server.stdin.write(`${JSON.stringify(message)}\n`);
    return message;
  };
  const request = (method, params) => send({ id: nextId++, method, params });
  const waitFor = (predicate, timeoutMs, label) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off("message", onMessage);
        reject(
          new Error(
            `Codex app-server stop smoke timed out after ${timeoutMs}ms waiting for ${label}${
              stderrLines.length ? ` (stderr: ${stderrLines.slice(-5).join(" | ")})` : ""
            }`,
          ),
        );
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        events.off("message", onMessage);
        resolve(message);
      };
      events.on("message", onMessage);
    });
  };
  const response = async (sent, timeoutMs = 15_000) => {
    const reply = await waitFor(
      (message) => !message.method && message.id === sent.id,
      timeoutMs,
      sent.method,
    );
    if (reply.error) {
      throw new Error(`Codex ${sent.method} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.result;
  };
  const call = (method, params, timeoutMs = 15_000) => response(request(method, params), timeoutMs);
  const startThread = async () => {
    const result = await call("thread/start", {
      approvalPolicy: "never",
      cwd: runWorkspace,
      model: "gpt-5.4",
      sandbox: "read-only",
      serviceName: "opensteer",
    });
    return result.thread.id;
  };
  const startTurn = async (threadId, prompt) => {
    const result = await call("turn/start", {
      approvalPolicy: "never",
      cwd: runWorkspace,
      input: [{ text: prompt, text_elements: [], type: "text" }],
      model: "gpt-5.4",
      sandboxPolicy: { type: "dangerFullAccess" },
      threadId,
    });
    return result.turn.id;
  };

  try {
    await call("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
    });
    send({ method: "initialized", params: {} });

    // Positive: turn/interrupt followed immediately by thread/unsubscribe closes
    // thread A within 2 s and leaves neighbour thread B untouched on the same server.
    const threadA = await startThread();
    const threadB = await startThread();
    const turnA = await startTurn(threadA, "SMOKE_HOLD_A");
    await waitFor(
      (message) =>
        message.method === "item/agentMessage/delta" && message.params?.threadId === threadA,
      15_000,
      "thread A text delta",
    );
    const neighbourEventsBefore = messages.filter(
      (message) => message.method && message.params?.threadId === threadB,
    ).length;

    const closeDeadline = Date.now() + 2_000;
    request("turn/interrupt", { threadId: threadA, turnId: turnA });
    const unsubscribeA = request("thread/unsubscribe", { threadId: threadA });
    const unsubscribeAResult = await response(
      unsubscribeA,
      Math.max(1, closeDeadline - Date.now()),
    );
    if (unsubscribeAResult?.status !== "notLoaded") {
      await waitFor(
        (message) => message.method === "thread/closed" && message.params?.threadId === threadA,
        Math.max(1, closeDeadline - Date.now()),
        "thread A thread/closed after interrupt+unsubscribe",
      );
    }
    const neighbourEventsAfter = messages.filter(
      (message) => message.method && message.params?.threadId === threadB,
    ).length;
    if (neighbourEventsAfter !== neighbourEventsBefore) {
      throw new Error("Stopping thread A emitted unexpected notifications for neighbour thread B");
    }
    const turnB = await startTurn(threadB, "SMOKE_SHORT_B");
    const completedB = await waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.threadId === threadB &&
        message.params?.turn?.id === turnB,
      15_000,
      "neighbour thread B turn/completed",
    );
    if (completedB.params?.turn?.status !== "completed") {
      throw new Error(
        `Neighbour thread B did not complete cleanly: ${JSON.stringify(completedB.params)}`,
      );
    }

    // Negative: thread/unsubscribe WITHOUT turn/interrupt must NOT close a turn in flight.
    const threadC = await startThread();
    await startTurn(threadC, "SMOKE_HOLD_C");
    await waitFor(
      (message) =>
        message.method === "item/agentMessage/delta" && message.params?.threadId === threadC,
      15_000,
      "thread C text delta",
    );
    const unsubscribeCResult = await call("thread/unsubscribe", { threadId: threadC }, 5_000);
    if (unsubscribeCResult?.status === "notLoaded") {
      throw new Error("thread/unsubscribe without turn/interrupt unexpectedly returned notLoaded");
    }
    const closedWithoutInterrupt = await waitFor(
      (message) => message.method === "thread/closed" && message.params?.threadId === threadC,
      5_000,
      "thread C thread/closed",
    ).then(
      () => true,
      () => false,
    );
    if (closedWithoutInterrupt) {
      throw new Error(
        "thread/unsubscribe without turn/interrupt unexpectedly emitted thread/closed",
      );
    }
  } finally {
    server.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => server.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await stub.close();
  }
}

async function startCodexResponsesStub() {
  let requestId = 0;
  const handleRequest = async (req, reply) => {
    const id = ++requestId;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      reply.writeHead(400).end();
      return;
    }
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/responses") {
      reply.writeHead(404, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({ error: { message: "Loopback stub serves POST /v1/responses" } }));
      return;
    }
    const prompts = (Array.isArray(body.input) ? body.input : [])
      .filter((item) => item.role === "user")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
    const prompt =
      prompts
        .map((item) => item.text)
        .filter(Boolean)
        .at(-1) ?? "";
    const hold = !prompt.includes("SMOKE_SHORT");

    reply.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      "x-request-id": `smoke-${id}`,
    });
    const send = (type, data) => {
      reply.write(`event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`);
    };
    const response = {
      created_at: Math.floor(Date.now() / 1_000),
      id: `resp_${id}`,
      model: body.model,
      object: "response",
      output: [],
      status: "in_progress",
    };
    send("response.created", { response });
    const message = {
      content: [],
      id: `msg_${id}`,
      role: "assistant",
      status: "in_progress",
      type: "message",
    };
    send("response.output_item.added", { item: message, output_index: 0 });
    const part = { annotations: [], text: "", type: "output_text" };
    send("response.content_part.added", {
      content_index: 0,
      item_id: message.id,
      output_index: 0,
      part,
    });
    const delta = hold ? "holding" : "ok";
    send("response.output_text.delta", {
      content_index: 0,
      delta,
      item_id: message.id,
      output_index: 0,
    });
    if (hold) {
      const ceiling = setTimeout(() => reply.destroy(), 60_000);
      ceiling.unref();
      reply.once("close", () => clearTimeout(ceiling));
      return;
    }
    send("response.output_text.done", {
      content_index: 0,
      item_id: message.id,
      output_index: 0,
      text: delta,
    });
    part.text = delta;
    send("response.content_part.done", {
      content_index: 0,
      item_id: message.id,
      output_index: 0,
      part,
    });
    message.content = [part];
    message.status = "completed";
    send("response.output_item.done", { item: message, output_index: 0 });
    send("response.completed", {
      response: {
        ...response,
        output: [message],
        status: "completed",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    });
    reply.end();
  };
  const server = createServer((req, reply) => {
    void handleRequest(req, reply).catch(() => {
      if (!reply.headersSent) {
        reply.writeHead(500);
      }
      reply.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
    port: typeof address === "object" && address ? address.port : 0,
  };
}

async function waitForSocket(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Relay stand-in did not listen on ${path}`);
}
