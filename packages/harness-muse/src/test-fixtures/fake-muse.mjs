#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const capture = process.env.FAKE_MUSE_CAPTURE;
const scenario = process.env.FAKE_MUSE_SCENARIO ?? "happy";

async function record(value) {
  if (capture) await appendFile(capture, `${JSON.stringify(value)}\n`);
}

await record({
  argv: args,
  environment: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.startsWith("META_") || key.startsWith("XDG_") || key === "MUSE_PROJECTS_HOME",
    ),
  ),
});

if (args.includes("--version")) {
  process.stdout.write("Muse Code 1.4.14 (1.4.14-R7309.1)\n");
  process.exit(0);
}

if (args.includes("usage")) {
  if (scenario === "logged-out") {
    process.stderr.write("muse usage: not logged in: run muse login first\n");
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      observedAtMs: 1_800_000_000_000,
      tier: "pro",
      weekly: { resetsAtMs: 1_800_604_800_000, usedPercent: 12 },
      window: { resetsAtMs: 1_800_018_000_000, usedPercent: 25, windowDurationMins: 300 },
    }),
  );
  process.exit(0);
}

if (args.includes("login")) {
  process.stdout.write(
    "Open this page to sign in: https://auth.meta.com/oauth/device/?code=ABCD-EFGH\nconfirm this code matches: ABCD-EFGH\n",
  );
  setInterval(() => undefined, 1_000);
} else if (args.includes("logout")) {
  process.exit(0);
} else {
  serve();
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function session(sessionId) {
  return {
    activeTurnId: null,
    createdAt: "2026-01-01T00:00:00Z",
    forkedFrom: null,
    path: "/tmp",
    providerId: "meta",
    sessionId,
    status: "idle",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function serve() {
  const lines = createInterface({ input: process.stdin });
  let sessionId = "019a1111-1111-7111-8111-111111111111";
  let turnId = "019a2222-2222-7222-8222-222222222222";
  const handle = async (line) => {
    const message = JSON.parse(line);
    await record({ message });
    if (!("id" in message)) return;
    // A result for a server-to-client request, not a new client request.
    if (!("method" in message)) return;
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      response(id, {
        experimentalApi: false,
        grantedCapabilities:
          scenario === "no-mcp" ? [] : (params.capabilities?.requestedCapabilities ?? []),
        museHome: process.env.XDG_CONFIG_HOME ?? "/tmp/muse",
        platformFamily: "unix",
        platformOs: "darwin",
        schema: { version: 1 },
        serverInfo: { name: "fake-muse", version: "1.4.14" },
        userAgent: "fake-muse/1.4.14",
      });
      return;
    }
    if (method === "model/list") {
      response(id, {
        models: [
          {
            contextLimit: 131072,
            cost: null,
            defaultReasoningEffort: "high",
            description: "Muse test model",
            displayLabel: "Muse Test",
            isActive: false,
            isDefault: true,
            modelId: "muse-test",
            outputLimit: 8192,
            profileId: "test",
            providerId: "meta",
            reasoningEffortVariants: [],
            releaseDate: null,
            variants: "unknown",
          },
        ],
        profileId: "test",
        providerId: "meta",
        source: "bundledCatalog",
      });
      return;
    }
    if (method === "session/start") {
      sessionId = params.sessionId ?? sessionId;
      response(id, { session: session(sessionId), viewCursor: "v1" });
      return;
    }
    if (method === "session/resume") {
      if (scenario === "missing-session") {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32011,
            data: { kind: "notFound", retryable: false },
            message: "not found",
          },
        });
        return;
      }
      sessionId = params.sessionId;
      response(id, {
        history: { items: [], mode: "none", snapshot: null },
        pendingRequests: [],
        session: session(sessionId),
        viewCursor: "v2",
      });
      return;
    }
    if (method === "session/setApprovalMode") {
      response(id, {
        applyOutcome: "completed",
        commandId: params.commandId,
        effectiveMode: {
          lastCommandId: params.commandId,
          mode: params.mode,
          source: "approvalReconfigure",
        },
        status: "accepted",
      });
      return;
    }
    if (method === "session/setModel") {
      response(id, { commandId: params.commandId, status: "accepted" });
      return;
    }
    if (method === "turn/start") {
      turnId = "019a2222-2222-7222-8222-222222222222";
      response(id, {
        commandId: params.commandId,
        disposition: "started",
        startedNewTurn: true,
        status: "accepted",
        turnId,
      });
      queueMicrotask(() => {
        notification("turn/started", {
          commandId: params.commandId,
          sessionId,
          sourceRange: { first: "1", last: "1" },
          turnId,
          viewCursor: "v3",
        });
        if (scenario === "host-death") {
          process.exit(7);
          return;
        }
        if (scenario === "steer") return;
        if (scenario === "compaction") {
          notification("item/started", {
            item: {
              itemId: "compaction-1",
              kind: "compaction",
              revision: 1,
              status: "running",
              turnId,
            },
          });
          notification("item/completed", {
            item: {
              itemId: "compaction-observed",
              kind: "reasoning",
              revision: 1,
              status: "completed",
              text: "Compacting context",
              turnId,
            },
          });
          return;
        }
        if (scenario === "quota" || scenario === "model-denied") {
          notification("turn/completed", {
            error:
              scenario === "quota"
                ? {
                    kind: "provider",
                    message: "429 usage limit exceeded",
                    quota: { resetsAtMs: 1_800_018_000_000 },
                    retryable: false,
                  }
                : {
                    kind: "provider",
                    message: "model does not exist or you lack access",
                    retryable: false,
                  },
            sessionId,
            sourceRange: { first: "2", last: "2" },
            terminal: "failed",
            turnId,
            viewCursor: "v4",
          });
          return;
        }
        if (scenario === "child-approval") {
          notification("item/started", {
            item: {
              childSessionId: "019a3333-3333-7333-8333-333333333333",
              itemId: "subagent-item",
              kind: "subagent",
              objective: "Check the workspace",
              revision: 1,
              status: "running",
              subagentId: "child-1",
              turnId,
            },
          });
          send({
            jsonrpc: "2.0",
            id: 99,
            method: "approval/request",
            params: {
              approvalId: "approval-1",
              availableChoices: [
                {
                  acceptsFeedback: false,
                  choiceId: "approve-once",
                  decision: "approved",
                  label: "Allow once",
                  scope: "once",
                },
                {
                  acceptsFeedback: true,
                  choiceId: "reject-once",
                  decision: "rejected",
                  label: "Reject",
                  scope: "once",
                },
              ],
              currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
              itemId: "tool-item-1",
              rawArgs: "pwd",
              sessionId,
              subagentOrigin: {
                childRunId: "child-run-1",
                childSessionId: "019a3333-3333-7333-8333-333333333333",
                subagentId: "child-1",
              },
              subject: { command: "pwd", kind: "command" },
              toolCallId: "tool-call-1",
              toolName: "shell",
              turnId,
            },
          });
          notification("turn/completed", {
            sessionId,
            sourceRange: { first: "2", last: "3" },
            terminal: "completed",
            turnId,
            viewCursor: "v4",
          });
          return;
        }
        finishTurn();
      });
      return;
    }
    if (method === "turn/steer") {
      response(id, {
        commandId: params.commandId,
        status: "accepted",
        turnId: params.expectedTurnId,
      });
      queueMicrotask(finishTurn);
      return;
    }
    if (method === "turn/interrupt") {
      response(id, {
        commandId: params.commandId,
        status: "accepted",
        turnId: params.turnId ?? turnId,
      });
      queueMicrotask(() =>
        notification("turn/completed", {
          sessionId,
          sourceRange: { first: "4", last: "4" },
          terminal: "cancelled",
          turnId,
          viewCursor: "v5",
        }),
      );
      return;
    }
    if (method === "approval/decide") {
      response(id, {
        approvalId: params.approvalId,
        commandId: params.commandId,
        status: "accepted",
        terminal: true,
      });
      if (scenario === "child-approval") {
        queueMicrotask(() =>
          notification("item/completed", {
            item: {
              childSessionId: "019a3333-3333-7333-8333-333333333333",
              controlStatus: "closed",
              itemId: "subagent-item",
              kind: "subagent",
              objective: "Check the workspace",
              result: {
                artifactRefs: [],
                evidenceRefs: [],
                summary: "Workspace checked",
                text: "Workspace checked",
              },
              revision: 2,
              status: "completed",
              subagentId: "child-1",
              turnId,
            },
          }),
        );
      }
      return;
    }
    if (method === "userInput/answer") {
      response(id, {
        commandId: params.commandId,
        status: "accepted",
        userInputId: params.userInputId,
      });
      return;
    }
    response(id, { commandId: params.commandId, status: "accepted" });
  };
  // One line at a time, in order, as a real stdio peer reads them.
  let pending = Promise.resolve();
  lines.on("line", (line) => {
    pending = pending.then(() => handle(line));
  });

  function finishTurn() {
    notification("session/tokenUsage", {
      promptTokens: 11,
      sessionId,
      totalTokens: 15,
      turnId,
      usage: { cachedTokens: 2, inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
    });
    notification("item/completed", {
      item: {
        itemId: "message-1",
        kind: "agentMessage",
        revision: 1,
        role: "assistant",
        status: "completed",
        text: "Hello from Muse",
        turnId,
      },
    });
    notification("turn/completed", {
      sessionId,
      sourceRange: { first: "2", last: "3" },
      terminal: "completed",
      turnId,
      usage: { cachedTokens: 2, inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
      viewCursor: "v4",
    });
  }
}
