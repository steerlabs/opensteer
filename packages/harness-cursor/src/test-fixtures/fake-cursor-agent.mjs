#!/usr/bin/env node
// A stand-in for the installed `agent` CLI. It speaks the exact subcommands
// and stream-json frames the real 2026.09.15 build was observed to produce, and
// for hook scenarios it runs the plugin's own hook program the way Cursor does
// (command string through a shell, payload on stdin) and honours the verdict.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_CURSOR_SCENARIO ?? "happy";
const capturePath = process.env.FAKE_CURSOR_CAPTURE_PATH;
const capture = (value) => {
  if (capturePath) appendFileSync(capturePath, `${JSON.stringify(value)}\n`);
};

capture({
  fakeCursorInvocation: {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    environment: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("npm_")),
    ),
  },
});

const subcommand = argv[0];
if (subcommand === "--version") {
  process.stdout.write(`${process.env.FAKE_CURSOR_VERSION ?? "2026.09.15-d2fe57e"}\n`);
  process.exit(0);
}
if (subcommand === "status") {
  if (scenario === "status-auth-required") {
    process.stderr.write("Error: Authentication required.\n");
    process.exit(1);
  }
  const authenticated = scenario !== "logged-out";
  process.stdout.write(
    `${JSON.stringify({
      hasAccessToken: authenticated,
      hasRefreshToken: authenticated,
      isAuthenticated: authenticated,
      status: authenticated ? "authenticated" : "unauthenticated",
      ...(authenticated
        ? {
            userInfo: {
              email: "cursor@example.test",
              firstName: "Test",
              lastName: "Person",
              userId: 1,
            },
          }
        : {}),
    })}\n`,
  );
  process.exit(0);
}
if (subcommand === "about") {
  process.stdout.write(
    `${JSON.stringify({
      cliVersion: process.env.FAKE_CURSOR_VERSION ?? "2026.09.15-d2fe57e",
      latestStatus: "up_to_date",
      model: "Composer 2.5",
      osArch: "arm64",
      osPlatform: "darwin",
      subscriptionTier: "Pro",
      userEmail: "cursor@example.test",
    })}\n`,
  );
  process.exit(0);
}
if (subcommand === "models") {
  if (scenario === "models-auth-required") {
    process.stderr.write("Error: Authentication required. Please run 'agent login'.\n");
    process.exit(1);
  }
  if (scenario === "no-models") {
    process.stdout.write("Available models\n\n");
    process.exit(0);
  }
  process.stdout.write(readFileSync(new URL("./cursor-models.txt", import.meta.url), "utf8"));
  process.exit(0);
}
if (subcommand === "create-chat") {
  process.stdout.write(
    `${process.env.FAKE_CURSOR_CHAT_ID ?? "11111111-2222-3333-4444-555555555555"}\n`,
  );
  process.exit(0);
}

// From here on this is the print-mode run.
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = flag("--resume") ?? "unknown-session";
const pluginDirectory = flag("--plugin-dir");
const prompt = argv.at(-1);
if (flag("--output-format") === "text") {
  capture({ fakeCursorNaming: prompt });
  process.stdout.write("Support migration\nheadphones");
  process.exit(0);
}
capture({ fakeCursorPrompt: prompt, fakeCursorModel: flag("--model") });

if (scenario === "trust-gate") {
  process.stderr.write(
    "\n⚠ Workspace Trust Required\n\n  Pass --trust, --yolo, or -f if you trust this directory\n",
  );
  process.exit(1);
}
if (scenario === "invalid-key") {
  process.stderr.write(
    "⚠ Warning: The provided API key is invalid.\nThe API key was loaded from the CURSOR_API_KEY environment variable.\n",
  );
  process.exit(1);
}
if (scenario === "usage-limit") {
  process.stderr.write("⚠ Usage limit exceeded. Upgrade your plan to continue.\n");
  process.exit(1);
}

const emit = (frame) =>
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...frame })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the plugin's hook program exactly as Cursor's hook runner does. */
async function runHook(event, payload) {
  if (!pluginDirectory) return { permission: "allow" };
  let hooks;
  try {
    hooks = JSON.parse(readFileSync(join(pluginDirectory, "hooks", "hooks.json"), "utf8"));
  } catch {
    return { permission: "allow" };
  }
  const entry = hooks.hooks?.[event]?.[0];
  if (!entry) return { permission: "allow" };
  const body = JSON.stringify({
    conversation_id: sessionId,
    cursor_version: "2026.09.15-d2fe57e",
    generation_id: sessionId,
    hook_event_name: event,
    model: "composer-2.5",
    session_id: sessionId,
    workspace_roots: [process.cwd()],
    ...payload,
  });
  capture({ fakeCursorHookRequest: { event, payload } });
  // The hook runs in a group of its own, and its timeout ends all of it: a
  // shell that does not exec its command (dash) would otherwise leave the
  // hook program running after its shell was killed.
  const child = spawn("/bin/sh", ["-c", entry.command], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${body}\n`);
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.resume();
  const timer = setTimeout(
    () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
    1_000 * (entry.timeout ?? 60),
  );
  const exit = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  clearTimeout(timer);
  if (exit !== 0 || stdout.trim().length === 0) {
    // failClosed turns a crashed or timed-out hook into a block.
    return entry.failClosed
      ? { permission: "deny", user_message: "the hook did not answer" }
      : { permission: "allow" };
  }
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return entry.failClosed
      ? { permission: "deny", user_message: "unreadable hook answer" }
      : { permission: "allow" };
  }
}

function blockedReason(verdict) {
  return `Command execution was blocked by a hook: ${verdict.user_message ?? "denied"}\n\nAgent note: Do not suggest workarounds to the blocked tool.`;
}

let interrupted = false;
if (scenario === "ignore-sigint") {
  // A CLI that will not stop on SIGINT, so the driver has to escalate.
  process.on("SIGINT", () => undefined);
} else {
  process.on("SIGINT", () => {
    interrupted = true;
    process.stderr.write("\nAborting operation...\n");
    process.exit(130);
  });
}
if (scenario === "hang") process.on("SIGTERM", () => undefined);

await main();

async function main() {
  emit({
    apiKeySource: "login",
    cwd: process.cwd(),
    model: scenario === "foreign-session" ? undefined : "Composer 2.5",
    permissionMode: "default",
    subtype: "init",
    type: "system",
    ...(scenario === "foreign-session"
      ? { session_id: "99999999-9999-9999-9999-999999999999" }
      : {}),
  });
  if (scenario === "init-then-failure") {
    process.stderr.write("Transport failed after session initialization.\n");
    process.exit(1);
  }
  emit({ message: { content: [{ text: prompt, type: "text" }], role: "user" }, type: "user" });

  if (scenario === "huge-line") {
    process.stdout.write(
      `${JSON.stringify({ text: "x".repeat(200_000), type: "thinking", subtype: "delta" })}\n`,
    );
    emit({
      duration_ms: 1,
      is_error: false,
      result: "done",
      subtype: "success",
      type: "result",
      usage: usage(),
    });
    process.exit(0);
  }

  if (scenario === "ignore-sigint") {
    emit({ text: "Working", timestamp_ms: Date.now(), type: "thinking", subtype: "delta" });
    setInterval(() => undefined, 1_000);
    return;
  }

  if (scenario === "hang") {
    // A timer, not an unsettled promise: Node exits on a stalled top-level await.
    setInterval(() => undefined, 1_000);
    return;
  }

  if (scenario === "slow") {
    emit({ text: "Working", timestamp_ms: Date.now(), type: "thinking", subtype: "delta" });
    const verdict = await runHook("beforeShellExecution", {
      command: "sleep 30",
      cwd: "",
      sandbox: false,
    });
    if (interrupted) return;
    shellFrames("sleep 30", verdict);
    await sleep(30_000);
    emit({
      duration_ms: 1,
      is_error: false,
      result: "done",
      subtype: "success",
      type: "result",
      usage: usage(),
    });
    return;
  }

  emit({ text: "Thinking ", timestamp_ms: Date.now(), type: "thinking", subtype: "delta" });
  emit({ text: "about it.", timestamp_ms: Date.now(), type: "thinking", subtype: "delta" });
  emit({ timestamp_ms: Date.now(), type: "thinking", subtype: "completed" });
  emit({
    message: { content: [{ text: "Running" }], role: "assistant" },
    timestamp_ms: Date.now(),
    type: "assistant",
  });
  emit({
    message: { content: [{ text: " it." }], role: "assistant" },
    timestamp_ms: Date.now(),
    type: "assistant",
  });
  emit({
    message: { content: [{ text: "Running it." }], role: "assistant" },
    model_call_id: "call-1",
    timestamp_ms: Date.now(),
    type: "assistant",
  });

  if (scenario === "hook-shell" || scenario === "hook-timeout") {
    const allowed = await runHook("beforeShellExecution", {
      command: "echo hi",
      cwd: "",
      sandbox: false,
    });
    shellFrames("echo hi", allowed);
    const denied = await runHook("beforeShellExecution", {
      command: "uname -a",
      cwd: "",
      sandbox: false,
    });
    shellFrames("uname -a", denied);
  } else if (scenario === "hook-write") {
    const verdict = await runHook("preToolUse", {
      tool_input: { path: join(process.cwd(), "probe.txt"), streamContent: "ok" },
      tool_name: "Write",
      tool_use_id: "tool_write_1",
    });
    emit({
      call_id: "tool_write_1",
      subtype: "started",
      tool_call: {
        editToolCall: { args: { path: join(process.cwd(), "probe.txt"), streamContent: "ok" } },
      },
      type: "tool_call",
    });
    emit({
      call_id: "tool_write_1",
      subtype: "completed",
      tool_call: {
        editToolCall: {
          args: { path: join(process.cwd(), "probe.txt") },
          result:
            verdict.permission === "allow"
              ? { success: { linesAdded: 1, path: join(process.cwd(), "probe.txt") } }
              : { error: { error: verdict.user_message ?? "denied", path: "" } },
        },
      },
      type: "tool_call",
    });
  } else if (scenario === "hook-mcp") {
    for (const server of ["plugin-opensteer-opensteer", "plugin-probe-other"]) {
      const verdict = await runHook("beforeMCPExecution", {
        mcp_server_name: server,
        mcp_server_url: "http://127.0.0.1:1/mcp",
        tool_input: "{}",
        tool_name: "probe",
        tool_use_id: `tool_${server}`,
      });
      emit({
        call_id: `tool_${server}`,
        subtype: "started",
        tool_call: {
          mcpToolCall: {
            args: {
              args: {},
              name: `${server}-probe`,
              providerIdentifier: server,
              toolName: "probe",
            },
          },
        },
        type: "tool_call",
      });
      emit({
        call_id: `tool_${server}`,
        subtype: "completed",
        tool_call: {
          mcpToolCall: {
            args: {
              args: {},
              name: `${server}-probe`,
              providerIdentifier: server,
              toolName: "probe",
            },
            result:
              verdict.permission === "allow"
                ? { success: { content: [{ text: { text: "MARKER-OK" } }], isError: false } }
                : { permissionDenied: { error: blockedReason(verdict), isReadonly: false } },
          },
        },
        type: "tool_call",
      });
    }
  } else if (scenario === "streamed-mcp-arguments") {
    const providerIdentifier = "plugin-opensteer-opensteer_integrations";
    const mcpArgs = (args) => ({
      args,
      name: "opensteer-integrations-integration_call",
      providerIdentifier,
      toolName: "integration_call",
    });
    emit({
      call_id: "tool_gateway",
      subtype: "started",
      tool_call: { mcpToolCall: { args: mcpArgs({}) } },
      type: "tool_call",
    });
    emit({
      call_id: "tool_gateway",
      subtype: "completed",
      tool_call: {
        mcpToolCall: {
          args: mcpArgs({ toolRef: "igr_grant.itl_tool.digest", arguments: { query: "hello" } }),
          result: { success: { content: [] } },
        },
      },
      type: "tool_call",
    });
    emit({
      call_id: "tool_existing",
      subtype: "started",
      tool_call: { mcpToolCall: { args: mcpArgs({ toolRef: "igr_existing.itl_tool.digest" }) } },
      type: "tool_call",
    });
    emit({
      call_id: "tool_existing",
      subtype: "completed",
      tool_call: { mcpToolCall: { args: mcpArgs({}), result: { success: { content: [] } } } },
      type: "tool_call",
    });
  } else if (scenario === "mcp-lifecycle-adversarial") {
    const mcpArgs = (args) => ({
      args,
      providerIdentifier: "plugin-opensteer-opensteer_integrations",
      toolName: "integration_call",
    });
    const emitMcp = (callId, subtype, args) =>
      emit({
        call_id: callId,
        subtype,
        tool_call: {
          mcpToolCall: {
            args: mcpArgs(args),
            ...(subtype === "completed" ? { result: { success: { content: [] } } } : {}),
          },
        },
        type: "tool_call",
      });
    emitMcp("tool_complete_only", "completed", { toolRef: "igr_complete.itl_tool.digest" });
    emitMcp("tool_duplicate", "started", { toolRef: "igr_full.itl_tool.digest" });
    emitMcp("tool_duplicate", "started", {});
    emitMcp("tool_duplicate", "completed", null);
    emitMcp("tool_duplicate", "started", {});
    emitMcp("tool_streamed", "started", {});
    emitMcp("tool_streamed", "completed", { toolRef: "igr_streamed.itl_tool.digest" });
    emitMcp("tool_streamed", "started", {});
    emitMcp("tool_streamed", "completed", null);
    emitMcp("tool_second_start", "started", { toolRef: "igr_partial.itl_tool.digest" });
    emitMcp("tool_second_start", "started", { toolRef: "igr_second.itl_tool.digest" });
    emitMcp("tool_second_start", "completed", null);
  } else if (scenario === "hook-unknown-tool") {
    // A mutating tool a later Cursor release could add, which this driver has
    // no name for.
    const verdict = await runHook("preToolUse", {
      tool_input: { target: "production", confirm: true },
      tool_name: "Deploy",
      tool_use_id: "tool_deploy_1",
    });
    emit({
      call_id: "tool_deploy_1",
      subtype: "completed",
      tool_call: {
        deployToolCall: {
          args: { target: "production" },
          result:
            verdict.permission === "allow"
              ? { success: { deployed: true } }
              : { error: { error: verdict.user_message ?? "denied" } },
        },
      },
      type: "tool_call",
    });
  } else if (scenario === "hook-read") {
    const verdict = await runHook("preToolUse", {
      tool_input: { path: join(process.cwd(), "README.md") },
      tool_name: "Read",
      tool_use_id: "tool_read_1",
    });
    emit({
      call_id: "tool_read_1",
      subtype: "completed",
      tool_call: {
        readToolCall: {
          args: { path: join(process.cwd(), "README.md") },
          result:
            verdict.permission === "allow"
              ? { success: { content: "hello" } }
              : { error: { error: "denied" } },
        },
      },
      type: "tool_call",
    });
  } else if (scenario === "unknown-tool") {
    emit({
      call_id: "tool_new_1",
      subtype: "started",
      tool_call: { crystalBallToolCall: { args: { question: "what next" } } },
      type: "tool_call",
    });
    emit({
      call_id: "tool_new_1",
      subtype: "completed",
      tool_call: { crystalBallToolCall: { args: {}, result: { success: { answer: "42" } } } },
      type: "tool_call",
    });
  } else {
    shellFrames("echo hi", { permission: "allow" });
  }

  emit({ message: { content: [{ text: "Done." }], role: "assistant" }, type: "assistant" });

  if (scenario === "error-result") {
    emit({
      duration_ms: 12,
      is_error: true,
      result: "The model could not finish this turn",
      subtype: "error",
      type: "result",
      usage: usage(),
    });
    process.exit(0);
  }
  if (scenario === "no-result") process.exit(3);
  if (scenario === "post-terminal") {
    // The terminal frame and one more, written in the same chunk.
    process.stdout.write(
      `${JSON.stringify({ duration_ms: 3, is_error: false, result: "Done.", session_id: sessionId, subtype: "success", type: "result", usage: usage() })}\n` +
        `${JSON.stringify({ message: { content: [{ text: "AFTER-THE-END" }], role: "assistant" }, session_id: sessionId, type: "assistant" })}\n`,
    );
    process.exit(0);
  }
  emit({
    duration_api_ms: 12,
    duration_ms: 12,
    is_error: false,
    request_id: "request-1",
    result: "Done.",
    subtype: "success",
    type: "result",
    usage: usage(),
  });
  process.exit(0);
}

function shellFrames(command, verdict) {
  emit({
    call_id: `tool_${command.replace(/\W/g, "_")}`,
    subtype: "started",
    tool_call: { shellToolCall: { args: { command, timeout: 30_000, workingDirectory: "" } } },
    type: "tool_call",
  });
  emit({
    call_id: `tool_${command.replace(/\W/g, "_")}`,
    subtype: "completed",
    tool_call: {
      shellToolCall: {
        args: { command },
        result:
          verdict.permission === "allow"
            ? { success: { command, exitCode: 0, signal: "", stderr: "", stdout: "hi\n" } }
            : {
                rejected: {
                  command,
                  isReadonly: false,
                  reason: blockedReason(verdict),
                  workingDirectory: "",
                },
              },
      },
    },
    type: "tool_call",
  });
}

function usage() {
  return { cacheReadTokens: 22_216, cacheWriteTokens: 0, inputTokens: 13_242, outputTokens: 570 };
}
