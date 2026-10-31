import { createCaptureRecordWriter } from "./capture-records.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";

/**
 * The features this fake Codex release knows: some the driver approves, some it
 * does not, one a release has just turned on by default, one whose name holds a
 * dot, and one Codex has removed.
 */
const fakeFeatures = [
  { defaultEnabled: true, name: "apps", stage: "stable" },
  { defaultEnabled: true, name: "browser_use", stage: "stable" },
  { defaultEnabled: true, name: "code_mode_host", stage: "stable" },
  { defaultEnabled: true, name: "fast_mode", stage: "stable" },
  { defaultEnabled: false, name: "guardianv2", stage: "under development" },
  { defaultEnabled: false, name: "guardianv2.thread_context", stage: "under development" },
  { defaultEnabled: false, name: "memories", stage: "under development" },
  { defaultEnabled: true, name: "multi_agent", stage: "stable" },
  { defaultEnabled: false, name: "multi_agent_v2", stage: "stable" },
  { defaultEnabled: true, name: "plugins", stage: "stable" },
  { defaultEnabled: true, name: "release_default_on", stage: "stable" },
  { defaultEnabled: true, name: "shell_tool", stage: "stable" },
  { defaultEnabled: true, name: "sqlite", stage: "removed" },
  { defaultEnabled: true, name: "unified_exec", stage: "stable" },
];

// `codex features list` prints its table and exits without serving anything.
if (process.argv.includes("features") && process.argv.includes("list")) {
  writeFileSync(
    1,
    fakeFeatures
      .map(({ defaultEnabled, name, stage }) =>
        [name.padEnd(41), stage.padEnd(19), String(defaultEnabled)].join(""),
      )
      .join("\n") + "\n",
  );
  process.exit(0);
}

const scenarioArgument = process.argv.find((argument) => argument.startsWith("--scenario="));
const scenario =
  scenarioArgument?.slice("--scenario=".length) ?? process.env.FAKE_CODEX_SCENARIO ?? "happy";
const capturePath =
  process.argv.find((argument) => argument.startsWith("--capture="))?.slice("--capture=".length) ??
  process.env.FAKE_CODEX_CAPTURE_PATH;
// A file whose appearance lets a held turn continue, so a test can act while
// the turn is mid-stream and then release it deterministically.
const releasePath = process.argv
  .find((argument) => argument.startsWith("--release-file="))
  ?.slice("--release-file=".length);
// The fake answers as the Codex release this tree installs, so a version bump
// never has to edit it; `version-mismatch` answers as a release nothing pins.
const version =
  scenario === "version-mismatch"
    ? "0.0.0"
    : createRequire(import.meta.url)("@openai/codex/package.json").version;
const writeCaptureRecord = capturePath ? createCaptureRecordWriter(capturePath) : undefined;
let captureRunId = null;

const lines = readline.createInterface({ input: process.stdin });
let initialized = false;
let modelListRequests = 0;
let threadId = "codex-thread-1";
const ephemeralThreads = new Set();
let threadConfig = {};
/** The MCP client an `mcp-session` engine keeps across its turns. */
let sessionTools;
let extraSkillRoots = [];
let turnId = "codex-turn-1";
let runScopedApprovalCalls = 0;
// Opt-in: each root turn gets an id of its own, as Codex mints them.
const uniqueTurns = process.argv.includes("--unique-turns");
// Answers model/list this late, as an engine still starting up does.
const modelListDelayMs = Number(
  process.argv
    .find((argument) => argument.startsWith("--model-list-delay-ms="))
    ?.slice("--model-list-delay-ms=".length) ?? 0,
);
const delayedModelLists = new WeakSet();
const resolvedNativeChildRequests = new Set();
// Codex's own default is a login shell; only the flag Opensteer passes turns it off.
const allowLoginShell = !process.argv.includes("allow_login_shell=false");
const shellEnvironmentPolicy = {
  exclude: JSON.parse(overrideValue("shell_environment_policy.exclude") ?? "[]"),
  inherit: JSON.parse(overrideValue("shell_environment_policy.inherit") ?? '"all"'),
};
// The driver bounds features with one inline table: features={"name"=true,...}.
const featureConfig = Object.fromEntries(
  [...(overrideValue("features") ?? "").matchAll(/"([^"]+)"=(true|false)/gu)].map(
    ([, name, value]) => [name, value === "true"],
  ),
);
// Opt-in: Codex's token accounting. After each model response Codex states
// the thread's running `total` and that response's own `last`; every reading
// here is distinct, so a miscount shows in the recorded totals.
const tokenUsage = process.argv.includes("--token-usage");
// Opt-in: a root turn starts by restating its thread's reading unchanged.
const restateUsage = process.argv.includes("--restate-usage");
// Opt-in: a turn consumes one response, so a thread's statements are few and plain.
const singleResponse = process.argv.includes("--single-response");
// Opt-in: the reading Codex restates when it resumes a thread arrives only
// once the next turn has been asked for, before that turn starts.
const deferResumeRestatement = process.argv.includes("--defer-resume-restatement");
/** A resumed thread's restatement, held for the next turn when deferred. */
let pendingRestatement;
// Opt-in: a response's reading whose cached input exceeds its input.
const impossibleUsage = process.argv.includes("--impossible-usage");
// Opt-in: cleaning this thread's background terminals fails.
const failCleanThread = process.argv
  .find((argument) => argument.startsWith("--fail-clean="))
  ?.slice("--fail-clean=".length);
/** Each thread's newest statement: its running total and its last response. */
const usageReadings = new Map();

if (scenario === "ignore-termination") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  capture({ fakeGrandchildPid: grandchild.pid });
  process.on("SIGTERM", () => undefined);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (typeof message.method === "string") handleClientMethod(message);
  else handleServerResponse(message);
});

lines.on("close", () => {
  if (scenario === "ignore-termination") setInterval(() => undefined, 1_000);
  else if (process.argv.includes("--survive-parent")) setInterval(() => undefined, 1_000);
  else process.exit(0);
});

function handleClientMethod(message) {
  switch (message.method) {
    case "initialize":
      capture({
        fakeCodexProcess: {
          argv: process.argv.slice(2),
          pid: process.pid,
          environment: {
            CODEX_HOME: process.env.CODEX_HOME ?? null,
            CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME ?? null,
          },
        },
      });
      // The Runner injects these for the harness and every command it runs; a
      // process boundary that drops them takes browser control with it.
      capture({
        fakeRunnerEnvironment: {
          OPENSTEER_AGENT_WORKSPACE: process.env.OPENSTEER_AGENT_WORKSPACE ?? null,
          OPENSTEER_BROWSER_CDP_WS: process.env.OPENSTEER_BROWSER_CDP_WS ?? null,
          OPENSTEER_BROWSER_HARNESS: process.env.OPENSTEER_BROWSER_HARNESS ?? null,
        },
      });
      capture({
        fakeOpensteerTokenEnvironment: {
          agentTools: Boolean(process.env.OPENSTEER_AGENT_TOOLS_TOKEN),
          integrationTools: Boolean(process.env.OPENSTEER_INTEGRATION_TOOLS_TOKEN),
        },
      });
      // Opt-in, for journeys that exercise exactly the token an engine holds.
      if (process.argv.includes("--capture-tokens"))
        capture({ fakeOpensteerTokens: { agentTools: process.env.OPENSTEER_AGENT_TOOLS_TOKEN } });
      if (scenario === "handshake-timeout") return;
      if (scenario === "cold-preparation") {
        const readyPath = join(process.env.CODEX_HOME, "prepared");
        if (existsSync(readyPath)) sendInitialize(message);
        else
          setTimeout(() => {
            appendFileSync(readyPath, "ready");
            sendInitialize(message);
          }, 350);
        return;
      }
      if (scenario === "delayed-handshake") {
        setTimeout(
          () => sendInitialize(message),
          Number(process.env.FAKE_CODEX_INITIALIZE_DELAY_MS ?? 100),
        );
      } else sendInitialize(message);
      break;
    case "initialized":
      initialized = true;
      break;
    case "skills/extraRoots/set":
      requireInitialized(message);
      extraSkillRoots = message.params.extraRoots;
      send({ id: message.id, result: {} });
      break;
    case "config/read":
      requireInitialized(message);
      send({
        id: message.id,
        result: {
          config: {
            log_dir:
              scenario === "voice-policy"
                ? "/outside"
                : JSON.parse(overrideValue("log_dir") ?? "null"),
            sqlite_home: JSON.parse(overrideValue("sqlite_home") ?? "null"),
            // A local policy that keeps the login shell despite the session flag.
            allow_login_shell: scenario === "managed-login-shell" ? true : allowLoginShell,
            features:
              scenario === "managed-extension"
                ? { ...featureConfig, plugins: true }
                : featureConfig,
            shell_environment_policy:
              scenario === "managed-shell-environment"
                ? { exclude: [], inherit: "all" }
                : shellEnvironmentPolicy,
            mcp_servers:
              scenario === "ambient-extensions"
                ? {
                    "company.docs": { command: "ambient-docs" },
                    github: { url: "https://example.test" },
                  }
                : {},
            tools: {
              update_plan: { enabled: scenario === "managed-planning-tool" },
            },
            web_search: "disabled",
          },
          layers: [
            {
              config: {
                allow_login_shell: allowLoginShell,
                check_for_update_on_startup: false,
                features: featureConfig,
                shell_environment_policy: shellEnvironmentPolicy,
                tools: {
                  update_plan: { enabled: scenario === "managed-planning-tool" },
                },
                web_search: "disabled",
              },
              name: { type: "sessionFlags" },
              version: "fake-session-flags",
            },
          ],
          origins: {},
        },
      });
      break;
    case "experimentalFeature/list":
      requireInitialized(message);
      send({
        id: message.id,
        result: {
          data: fakeFeatures.map(({ defaultEnabled, name, stage }) => ({
            defaultEnabled,
            // A managed policy that keeps an extension on despite the session flag.
            enabled:
              scenario === "managed-extension" && name === "plugins"
                ? true
                : stage === "removed"
                  ? defaultEnabled
                  : (featureConfig[name] ?? defaultEnabled),
            name,
            stage: stage === "under development" ? "underDevelopment" : stage,
          })),
          nextCursor: null,
        },
      });
      break;
    case "skills/list":
      requireInitialized(message);
      send({
        id: message.id,
        result: {
          data: [
            {
              cwd: message.params.cwds[0],
              errors: [],
              skills: discoveredSkills(),
            },
          ],
        },
      });
      break;
    case "account/read": {
      requireInitialized(message);
      const signedOut =
        scenario.startsWith("device-auth") ||
        scenario === "signed-out-without-auth-flag" ||
        scenario === "cold-preparation";
      send({
        id: message.id,
        result: {
          account: signedOut
            ? null
            : { email: "integration@example.test", planType: "pro", type: "chatgpt" },
          requiresOpenaiAuth: scenario !== "signed-out-without-auth-flag",
        },
      });
      break;
    }
    case "account/rateLimits/read": {
      requireInitialized(message);
      if (scenario === "rate-limits-missing") {
        send({
          id: message.id,
          error: { code: -32601, message: "Unexpected client method account/rateLimits/read" },
        });
        break;
      }
      if (scenario === "rate-limits-malformed") {
        send({ id: message.id, result: { rateLimits: { primary: { usedPercent: "lots" } } } });
        break;
      }
      const reached = scenario === "rate-limits-reached";
      send({
        id: message.id,
        result: {
          rateLimits: {
            credits: { balance: "0", hasCredits: false, unlimited: false },
            individualLimit: null,
            limitId: "codex",
            limitName: null,
            planType: "pro",
            primary: {
              resetsAt: 1788748992,
              usedPercent: reached ? 100 : 39,
              windowDurationMins: 10080,
            },
            rateLimitReachedType: reached ? "usage_limit_reached" : null,
            secondary: { resetsAt: null, usedPercent: 12, windowDurationMins: 300 },
            spendControlReached: false,
          },
          rateLimitResetCredits: { availableCount: 3, credits: [] },
          rateLimitsByLimitId: {},
        },
      });
      break;
    }
    case "account/login/start":
      requireInitialized(message);
      send({
        id: message.id,
        result: {
          loginId: "fake-device-login",
          type: "chatgptDeviceCode",
          userCode: "OPEN-STEER",
          verificationUrl: "https://auth.openai.com/device",
        },
      });
      if (scenario !== "device-auth-pending") {
        setTimeout(
          () =>
            send({
              method: "account/login/completed",
              params: {
                error: scenario === "device-auth-failure" ? "Fake sign-in declined" : null,
                loginId: "fake-device-login",
                success: scenario !== "device-auth-failure",
              },
            }),
          25,
        );
      }
      break;
    case "account/login/cancel":
      requireInitialized(message);
      send({ id: message.id, result: {} });
      break;
    case "model/list":
      requireInitialized(message);
      if (modelListDelayMs > 0 && !delayedModelLists.has(message)) {
        delayedModelLists.add(message);
        setTimeout(() => handleClientMethod(message), modelListDelayMs);
        break;
      }
      modelListRequests += 1;
      // `endless-models` never finishes paging.
      if (scenario === "endless-models") {
        send({ id: message.id, result: { data: [], nextCursor: "again" } });
        break;
      }
      if (scenario === "unique-cursor-models" || scenario === "invalid-cursor-models") {
        send({
          id: message.id,
          result: {
            data: [],
            nextCursor: scenario === "unique-cursor-models" ? `page-${modelListRequests}` : 123,
          },
        });
        break;
      }
      if (scenario === "oversized-models") {
        send({ id: message.id, result: { data: Array(8_193).fill(null), nextCursor: null } });
        break;
      }
      // `paged-models` hands out its catalog one model per page, as Codex may.
      if (scenario === "paged-models" && message.params?.cursor !== "page-2") {
        send({
          id: message.id,
          result: {
            data: [
              {
                defaultReasoningEffort: "medium",
                description: "First page",
                displayName: "GPT-6 Astra",
                hidden: false,
                id: "gpt-6-astra",
                inputModalities: ["text", "image"],
                isDefault: true,
                serviceTiers: [],
                supportedReasoningEfforts: [{ description: "Balanced", reasoningEffort: "medium" }],
              },
            ],
            nextCursor: "page-2",
          },
        });
        break;
      }
      send({
        id: message.id,
        result: {
          data: [
            {
              defaultReasoningEffort:
                scenario === "missing-default-effort"
                  ? undefined
                  : scenario === "unlisted-default-effort"
                    ? "retired"
                    : "low",
              defaultServiceTier:
                scenario === "default-service-tier" || scenario === "missing-default-service-tiers"
                  ? "priority"
                  : scenario === "unlisted-default-service-tier"
                    ? "retired"
                    : scenario === "invalid-default-service-tier"
                      ? 123
                      : null,
              description: "Deterministic integration model",
              displayName: "GPT-5.6 Sol",
              hidden: false,
              id: "gpt-5.6-sol",
              inputModalities: ["text", "image"],
              isDefault: scenario !== "paged-models",
              serviceTiers:
                scenario === "missing-default-service-tiers"
                  ? []
                  : [
                      { description: "1.5x speed, increased usage", id: "priority", name: "Fast" },
                      { description: "", id: "ultrafast", name: "Ultrafast" },
                      ...(scenario === "malformed-service-tiers"
                        ? [
                            null,
                            [],
                            { id: "" },
                            { id: 123 },
                            { id: "default", name: "Duplicate standard" },
                            { id: "priority", name: "Duplicate priority" },
                            { id: "x".repeat(256), name: "Too long" },
                          ]
                        : []),
                    ],
              supportedReasoningEfforts: [
                { description: "Fast", reasoningEffort: "low" },
                { description: "Thorough", reasoningEffort: "high" },
                { description: "Exhaustive", reasoningEffort: "xhigh" },
              ],
            },
            ...(scenario === "model-modalities"
              ? [
                  // Codex offers text-only models too, and an older build
                  // may not state modalities at all.
                  {
                    displayName: "GPT-5.3-Codex-Spark",
                    hidden: false,
                    id: "gpt-5.3-codex-spark",
                    inputModalities: ["text"],
                    isDefault: false,
                  },
                  {
                    displayName: "GPT-5.2",
                    hidden: false,
                    id: "gpt-5.2",
                    isDefault: false,
                  },
                ]
              : []),
          ],
          nextCursor: null,
        },
      });
      break;
    case "thread/start":
      requireInitialized(message);
      if (message.params.ephemeral) {
        threadId = `codex-title-${randomUUID()}`;
        ephemeralThreads.add(threadId);
      } else if (process.argv.includes("--unique-threads"))
        threadId = `codex-thread-${randomUUID()}`;
      captureRunId = threadId;
      threadConfig = message.params.config ?? {};
      if (process.env.FAKE_CODEX_TRUST_WRITE_PATH && message.params.sandbox !== "read-only") {
        appendFileSync(process.env.FAKE_CODEX_TRUST_WRITE_PATH, "mutated\n");
      }
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      send({
        id: message.id,
        result: {
          thread: { id: threadId },
          ...(message.params.ephemeral ? { sandbox: { type: "readOnly" } } : {}),
        },
      });
      break;
    case "thread/resume":
      requireInitialized(message);
      threadId = message.params.threadId;
      captureRunId = threadId;
      threadConfig = message.params.config ?? {};
      // Codex keeps a thread's reading with its history, and on resuming it
      // restates that reading, naming the thread's last turn, before any new
      // turn (verified against Codex 0.156.0).
      const stored = tokenUsage ? storedUsage()[threadId] : undefined;
      if (stored) usageReadings.set(threadId, stored.reading);
      const restate = stored
        ? () => sendUsage("restated", threadId, stored.turnId, stored.reading)
        : undefined;
      if (scenario === "resume-missing") {
        send({ id: message.id, error: { code: -32600, message: "no rollout found for thread" } });
        break;
      }
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      send({
        id: message.id,
        result: {
          thread: {
            id: scenario === "resume-wrong-thread" ? "different-thread" : threadId,
            turns:
              scenario === "resume-large-history" && !message.params.excludeTurns
                ? [
                    {
                      id: "historical-turn",
                      status: "completed",
                      items: [
                        { id: "compaction", type: "contextCompaction" },
                        ...Array.from({ length: 144 }, (_, index) => ({
                          id: `historical-output-${index}`,
                          type: "mcpToolCall",
                          result: {
                            content: [{ type: "text", text: "x".repeat(64 * 1024) }],
                          },
                        })),
                      ],
                    },
                  ]
                : [],
          },
        },
      });
      if (deferResumeRestatement) pendingRestatement = restate;
      else restate?.();
      break;
    case "mcpServerStatus/list":
      requireInitialized(message);
      const ambientNames = scenario === "ambient-extensions" ? ["company.docs", "github"] : [];
      const managedNames = ["opensteer", "opensteer_integrations"];
      send({
        id: message.id,
        result: {
          data: [
            ...managedNames.map((name) => ({
              name,
              resourceTemplates: [],
              resources: [],
              serverInfo: { name, version: "1.0.0" },
              tools: Object.fromEntries(
                [
                  ...(threadConfig[`mcp_servers.${name}.enabled_tools`] ?? []).filter(
                    (tool) =>
                      name !== "opensteer_integrations" ||
                      ((scenario !== "previous-host" || tool !== "computer") &&
                        (scenario !== "mcp-missing-required-tool" ||
                          tool !== "integration_search")),
                  ),
                  ...(scenario === "mcp-extra-tool" && name === "opensteer_integrations"
                    ? ["unexpected_tool"]
                    : []),
                ].map((tool) => [tool, { inputSchema: { type: "object" }, name: tool }]),
              ),
            })),
            ...[...ambientNames, ...(scenario === "mcp-boundary-leak" ? ["ambient"] : [])].map(
              (name) => ({
                name,
                resourceTemplates: [],
                resources: [],
                serverInfo:
                  scenario === "mcp-boundary-leak" && name === "ambient" ? { name } : null,
                tools: {},
              }),
            ),
          ],
          nextCursor: null,
        },
      });
      break;
    case "turn/start":
      if (ephemeralThreads.has(message.params.threadId)) {
        handleTitleTurn(message);
        break;
      }
      // Opt-in: a command the model started that left the engine's process
      // group, as a daemonizing tool does; its Runner must still end it.
      if (process.argv.includes("--spawn-detached")) {
        // `--spawn-unmarked` also starts it with an environment of its own,
        // which drops the marker naming the execution it belongs to.
        const unmarked = process.argv.includes("--spawn-unmarked");
        const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          ...(unmarked ? { env: { PATH: process.env.PATH ?? "" } } : {}),
          stdio: "ignore",
        });
        detached.unref();
        capture({ fakeDetachedChild: detached.pid });
      }
      handleTurnStart(message);
      break;
    case "turn/steer":
      handleTurnSteer(message);
      break;
    case "thread/backgroundTerminals/clean":
      capture({ backgroundTerminalsCleaned: message.params.threadId });
      if (message.params.threadId === failCleanThread) {
        send({ id: message.id, error: { code: -32603, message: "terminal cleanup failed" } });
        break;
      }
      send({ id: message.id, result: {} });
      break;
    case "thread/realtime/start":
      if (scenario === "voice-unsupported") {
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
        break;
      }
      send({ id: message.id, result: {} });
      if (scenario === "voice-refused" || scenario === "voice-closed") {
        send({
          method: scenario === "voice-refused" ? "thread/realtime/error" : "thread/realtime/closed",
          params: { threadId, message: "private voice payload" },
        });
      } else {
        send({ method: "thread/realtime/sdp", params: { threadId, sdp: "fake-answer" } });
        send({ method: "turn/started", params: { threadId, turn: { id: "voice-handoff" } } });
      }
      break;
    case "thread/inject_items":
      send({ id: message.id, result: {} });
      break;
    case "thread/realtime/appendText":
    case "thread/realtime/appendSpeech":
      send({ id: message.id, result: {} });
      if (scenario === "voice-agent") {
        const specs =
          message.params.text === "invalid"
            ? [
                ["unknown", {}],
                ["show", { link: 4 }],
                ["send_to_chat", { messages: 6 }],
                ["show", { link: "x", extra: true }],
              ]
            : message.params.text === "queue"
              ? Array.from({ length: 9 }, () => ["send_to_chat", {}])
              : [["show", { link: "opensteer://chat" }]];
        // The delegated speech that starts the agent's turn precedes its tool calls.
        send({
          method: "item/started",
          params: {
            threadId,
            turnId: `voice-turn-${message.params.text}`,
            item: {
              id: "spoken",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "<realtime_delegation>\n  <input>Book a flight &amp; hotel</input>\n  <transcript_delta>user: Book a flight &amp; hotel</transcript_delta>\n</realtime_delegation>",
                },
              ],
            },
          },
        });
        for (const [tool, args] of specs)
          send({
            id: randomUUID(),
            method: "item/tool/call",
            params: {
              threadId,
              turnId: `voice-turn-${message.params.text}`,
              tool,
              arguments: args,
            },
          });
      }
      if (scenario === "voice-exit") process.exit(1);
      if (scenario === "voice-interaction")
        send({ id: "voice-tool", method: "item/tool/call", params: { threadId } });
      if (scenario === "voice-close-after-say")
        send({ method: "thread/realtime/closed", params: { threadId } });
      break;
    case "thread/realtime/stop":
      send({ id: message.id, result: {} });
      send({ method: "thread/realtime/closed", params: { threadId } });
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      // A child agent's thread is interrupted on its own, as Codex requires.
      if (message.params.threadId !== threadId) {
        capture({ childInterrupted: message.params.threadId });
        sendChildTurnCompleted(message.params.threadId, message.params.turnId, "interrupted");
        const starting = followUpStart;
        followUpStart = undefined;
        if (starting) setTimeout(starting, 50);
        break;
      }
      capture({ rootInterrupted: message.params.turnId ?? null });
      // Opt-in: an engine that acknowledges an interrupt and keeps going.
      if (!process.argv.includes("--ignore-interrupt")) {
        sendTurnCompleted("interrupted", undefined, message.params.turnId ?? turnId);
      }
      break;
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `Unexpected client method ${message.method}` },
      });
  }
}

function discoveredSkills() {
  const paths = [];
  for (const root of extraSkillRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name, "SKILL.md");
      if (entry.isDirectory() && existsSync(path)) paths.push(realpathSync(path));
    }
  }
  const ambient = process.env.FAKE_CODEX_AMBIENT_SKILL_PATH;
  if (ambient && existsSync(ambient)) paths.push(realpathSync(ambient));
  return paths.map((path) => ({ description: "Test skill", enabled: true, name: "test", path }));
}

/** Ephemeral, read-only naming has no tools, children or persisted conversation. */
function handleTitleTurn(message) {
  const id = `codex-title-turn-${randomUUID()}`;
  capture({ fakeTitleTurn: { pid: process.pid, threadId } });
  send({ id: message.id, result: { turn: { id, items: [], status: "inProgress" } } });
  send({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress" } } });
  if (process.argv.includes("--title-error")) {
    sendTurnCompleted("failed", { message: "Naming unavailable" }, id);
    return;
  }
  const reply =
    process.argv
      .find((argument) => argument.startsWith("--title-reply="))
      ?.slice("--title-reply=".length) ?? "Support migration\nheadphones";
  sendResponseUsage("naming", threadId, id, tokens(1_000, 0, 0, 20, 0));
  if (reply)
    send({
      method: "item/completed",
      params: { threadId, turnId: id, item: { id: "name", type: "agentMessage", text: reply } },
    });
  sendTurnCompleted("completed", undefined, id);
}

function handleTurnStart(message) {
  capture({ fakeTurn: { pid: process.pid, threadId } });
  pendingRestatement?.();
  pendingRestatement = undefined;
  if (uniqueTurns) turnId = `codex-turn-${randomUUID()}`;
  if (scenario === "recovery-held") {
    recoveryHeldTurn(message);
    return;
  }
  if (scenario === "request-timeout") return;
  if (scenario === "background-children") {
    backgroundTurn(message);
    return;
  }
  send({
    id: message.id,
    result: { turn: { error: null, id: turnId, items: [], status: "inProgress" } },
  });
  send({
    method: "turn/started",
    params: { threadId, turn: { error: null, id: turnId, items: [], status: "inProgress" } },
  });
  if (restateUsage) restateThreadUsage(threadId, turnId);

  if (scenario === "conversation") {
    conversationTurn(message.params?.input ?? []);
    return;
  }
  if (scenario === "resume-large-history") {
    send({
      method: "item/completed",
      params: {
        item: {
          id: "new-digest",
          phase: "final_answer",
          text: "Today's digest.",
          type: "agentMessage",
        },
        threadId,
        turnId,
      },
    });
    sendTurnCompleted("completed");
    return;
  }
  if (scenario === "invalid-json") {
    process.stdout.write("{this is not json}\n");
    return;
  }
  if (scenario === "oversized-line") {
    send({ method: "warning", params: { message: "x".repeat(32 * 1024), threadId } });
    return;
  }
  if (scenario === "notifications") {
    void notificationsTurn(message.params?.input ?? [], threadId, turnId);
    return;
  }
  if (scenario === "usage-limit") {
    sendTurnCompleted("failed", {
      codexErrorInfo: "usageLimitExceeded",
      message: "You've hit your usage limit.",
    });
    return;
  }
  if (scenario === "exit") {
    process.stderr.write("fake app-server exploded\n");
    setTimeout(() => process.exit(17), 5);
    return;
  }
  if (scenario === "stderr-tail") {
    process.stderr.write(`HEAD-${"x".repeat(2_048)}-TAIL\n`);
    setTimeout(() => process.exit(18), 5);
    return;
  }
  if (scenario === "pending-approval-interrupt") {
    send({
      id: "pending-interrupt-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test",
        itemId: "pending-interrupt-command",
        reason: "Run tests",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario === "run-scoped-approval") {
    send({
      id: "run-scoped-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", "acceptForSession", "decline"],
        command: "pnpm test",
        itemId: `run-scoped-command-${process.pid}-${++runScopedApprovalCalls}`,
        reason: "Run tests",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario === "sibling-approval-race") {
    // One Thread asks; the other gates its second durable event so the journey
    // can prove contention during acceptance without accumulating a backlog.
    if (JSON.stringify(message.params?.input ?? []).includes("Ask before acting")) {
      send({
        id: "run-scoped-approval-rpc",
        method: "item/commandExecution/requestApproval",
        params: {
          availableDecisions: ["accept", "decline"],
          command: "pnpm test",
          itemId: "race-command",
          reason: "Run tests",
          threadId,
          turnId,
        },
      });
    } else {
      void durableStreamUntilReleased();
    }
    return;
  }
  if (scenario.startsWith("steer")) {
    sendResponseUsage("response", threadId, turnId, responseUsage.beforeSteer);
  }
  if (scenario === "interrupt" || scenario.startsWith("steer")) return;
  if (scenario === "large-command-arguments") {
    const encoded = Buffer.from("Opensteer deterministic image bytes\n".repeat(7_000))
      .toString("base64")
      .slice(0, 300_000);
    const script = `python3 - <<'PY'\n# HEAD-large-command-arguments\nimport base64,pathlib\npathlib.Path('alaska-daytime.jpg').write_bytes(base64.b64decode('${encoded}'))\n# TAIL-large-command-arguments\nPY`;
    // Codex reports the command as the shell ran it, joined by shlex, which
    // double-quotes a script holding a `'`, and each part it read as that
    // part's own text, so an inline script arrives twice.
    const command = `/bin/zsh -lc "${script.replace(/[\\"$`]/gu, "\\$&")}"`;
    const item = {
      command,
      commandActions: [{ type: "unknown", command: script }],
      cwd: message.params.cwd,
      id: "large-command-arguments-1",
      type: "commandExecution",
    };
    send({
      method: "item/started",
      params: {
        item: { ...item, aggregatedOutput: null, exitCode: null, status: "inProgress" },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          ...item,
          aggregatedOutput: "Saved alaska-daytime.jpg\n",
          durationMs: 12,
          exitCode: 0,
          status: "completed",
        },
        threadId,
        turnId,
      },
    });
    finishTurnWith("Saved alaska-daytime.jpg successfully.");
    return;
  }
  if (scenario === "large-tool-output") {
    const output = `HEAD-${"x".repeat(1_100_000)}-TAIL`;
    send({
      method: "item/started",
      params: {
        item: {
          command: "rg pattern bundle.js.map | head -50",
          cwd: "/workspace",
          id: "large-command-1",
          status: "inProgress",
          type: "commandExecution",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/commandExecution/outputDelta",
      params: { delta: output, itemId: "large-command-1", threadId, turnId },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          aggregatedOutput: output,
          command: "rg pattern bundle.js.map | head -50",
          cwd: "/workspace",
          id: "large-command-1",
          status: "completed",
          stdout: output,
          type: "commandExecution",
        },
        threadId,
        turnId,
      },
    });
    sendTurnCompleted("completed");
    return;
  }
  if (scenario === "mcp-session") {
    // One MCP client for as long as this engine runs, as Codex keeps one: a
    // later turn calls its tools on the session the first turn opened.
    void (async () => {
      sessionTools ??= await mcpClient(
        threadConfig["mcp_servers.opensteer.url"],
        process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
      );
      const listed = await sessionTools.call("request_list", { limit: 1 });
      capture({ fakeMcpCall: { ok: true, pid: process.pid, sessionId: sessionTools.sessionId } });
      return JSON.stringify({ requests: listed.requests?.length ?? 0 });
    })().then(finishTurnWith, (error) => {
      capture({
        fakeMcpCall: { error: String(error?.message ?? error), ok: false, pid: process.pid },
      });
      finishTurnWith(JSON.stringify({ error: String(error?.message ?? error) }));
    });
    return;
  }
  if (scenario === "browser-tab-groups") {
    void tabGroupJourney(message.params.input).then(
      (report) => finishTurnWith(JSON.stringify(report)),
      (error) => finishTurnWith(JSON.stringify({ error: String(error?.stack ?? error) })),
    );
    return;
  }
  if (scenario === "browser-profiles") {
    void browserProfilesTurn(message.params.input).then((report) =>
      finishTurnWith(JSON.stringify(report)),
    );
    return;
  }
  if (scenario === "browser-agent") {
    // Acts as an agent following the opensteer-browser skill: it opens
    // Browser Sessions through Opensteer's MCP tools, drives each one by ID
    // with the shipped Browser Harness, and reports exactly what it saw.
    void browserAgentTurn(message.params.input).then(
      (report) => finishTurnWith(JSON.stringify(report)),
      (error) => finishTurnWith(JSON.stringify({ error: String(error?.stack ?? error) })),
    );
    return;
  }
  if (scenario === "attachments-vertical") {
    const input = message.params.input;
    const imagePaths = input.filter((part) => part.type === "localImage").map((part) => part.path);
    const filePaths = input
      .filter((part) => part.type === "text")
      .flatMap((part) =>
        [...part.text.matchAll(/Readable path: ([^\n]+)/gu)].map((match) => match[1]),
      );
    // Each file is <Thread>/<attachment ID>/<name>; listing the whole Thread
    // folder shows everything this Run could read, not only what was named.
    const threadDirectories = [
      ...new Set([...imagePaths, ...filePaths].map((path) => dirname(dirname(path)))),
    ];
    const files = threadDirectories.flatMap((directory) =>
      readdirSync(directory).flatMap((id) =>
        readdirSync(join(directory, id)).map((name) => ({
          id,
          name,
          sha256: createHash("sha256")
            .update(readFileSync(join(directory, id, name)))
            .digest("hex"),
        })),
      ),
    );
    const text = JSON.stringify({
      files,
      images: imagePaths.map((path) => basename(dirname(path))),
      inputTypes: input.map((part) => part.type),
    });
    send({
      method: "item/completed",
      params: {
        item: { id: "attachment-receipt", phase: "final_answer", text, type: "agentMessage" },
        threadId,
        turnId,
      },
    });
    sendTurnCompleted("completed");
    return;
  }
  if (scenario === "vertical" || scenario === "vertical-delayed") {
    if (
      process.argv.includes("--hold-second-turn") &&
      JSON.stringify(message.params.input).includes("Second question")
    )
      return;
    const complete = () => {
      if (singleResponse) {
        const reading = usageReadings.has(threadId)
          ? responseUsage.laterResponse
          : responseUsage.firstResponse;
        sendResponseUsage("response", threadId, turnId, reading);
      } else sendSeveralResponsesUsage();
      send({
        method: "item/agentMessage/delta",
        params: { delta: "Completed by Codex.", itemId: "message-1", threadId, turnId },
      });
      send({
        method: "item/completed",
        params: {
          item: {
            id: "message-1",
            phase: "final_answer",
            text: "Completed by Codex.",
            type: "agentMessage",
          },
          threadId,
          turnId,
        },
      });
      sendTurnCompleted("completed");
      // A reading of the finished turn that arrives once its Run has ended.
      if (!singleResponse) sendResponseUsage("late", threadId, turnId, responseUsage.late);
    };
    if (scenario === "vertical-delayed") setTimeout(complete, 2_000);
    else complete();
    return;
  }
  if (scenario === "long-stream" || scenario === "long-stream-held") {
    void longStreamTurn(scenario === "long-stream-held");
    return;
  }
  if (scenario === "event-overflow") {
    // Durable completions, not streaming deltas: progress is evicted when a
    // consumer stalls, but an event the Host must receive overflows the buffer.
    for (let index = 0; index < 100; index += 1) {
      send({
        method: "item/completed",
        params: {
          item: {
            id: `overflow-message-${index}`,
            phase: "commentary",
            text: `semantic-output-${index}`,
            type: "agentMessage",
          },
          threadId,
          turnId,
        },
      });
    }
    return;
  }
  if (scenario === "approval-kinds") {
    send({
      id: "file-rpc",
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: "/workspace/generated",
        itemId: "file-1",
        reason: "Write generated files",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario.startsWith("denial-note-")) {
    const kind = scenario.slice("denial-note-".length);
    const method =
      kind === "command"
        ? "item/commandExecution/requestApproval"
        : kind === "file"
          ? "item/fileChange/requestApproval"
          : "item/permissions/requestApproval";
    send({
      id: `denial-note-${kind}-rpc`,
      method,
      params: {
        ...(kind === "command" ? { command: "pnpm publish" } : {}),
        ...(kind === "file" ? { grantRoot: "/workspace/generated" } : {}),
        ...(kind === "permissions"
          ? {
              cwd: "/workspace",
              environmentId: "fake-environment",
              permissions: { network: { enabled: true } },
            }
          : {}),
        itemId: `denial-note-${kind}`,
        reason: "Approval is required",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario === "structured-execpolicy-approval") {
    send({
      id: "execpolicy-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["curl", "-sS"],
            },
          },
          "decline",
        ],
        command: "curl -sS https://api.github.com/search/repositories",
        itemId: "execpolicy-command-1",
        proposedExecpolicyAmendment: ["curl", "-sS"],
        reason: "Search GitHub for a Gmail MCP server",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario === "structured-network-policy-approval") {
    send({
      id: "network-policy-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: [
          "accept",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { action: "allow", host: "api.github.com" },
            },
          },
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { action: "deny", host: "api.github.com" },
            },
          },
          "decline",
        ],
        command: "curl -sS https://api.github.com/search/repositories",
        itemId: "network-policy-command-1",
        networkApprovalContext: { host: "api.github.com", protocol: "https" },
        proposedNetworkPolicyAmendments: [
          { action: "allow", host: "api.github.com" },
          { action: "deny", host: "api.github.com" },
        ],
        reason: "Network access to api.github.com is required",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (scenario === "unknown-request") {
    send({ id: "unknown-rpc", method: "fake/unsupported", params: { threadId, turnId } });
    return;
  }
  if (scenario.startsWith("subagents")) {
    sendResponseUsage("response", threadId, turnId, responseUsage.rootDelegates);
    // A subagent asking before the Runner has heard of it.
    if (scenario === "subagents-early-approval") sendChildApproval();
    sendSubagentActivity("spawn-1", "started");
    send({
      method: "turn/started",
      params: { threadId: childThreadId, turn: childTurn("child-turn-1", "inProgress") },
    });
    sendChildItem("item/completed", {
      content: [{ text: "Look up the release notes", type: "text" }],
      id: "child-prompt-1",
      type: "userMessage",
    });
    sendChildItem("item/started", {
      command: "cat NOTES.md",
      cwd: "/workspace",
      id: "child-command-1",
      status: "inProgress",
      type: "commandExecution",
    });
    sendResponseUsage("response", childThreadId, "child-turn-1", responseUsage.childRuns);
    if (scenario === "subagents") sendChildApproval();
    // `subagents-hold` leaves the child working until it is interrupted.
    return;
  }
  if (scenario === "native-child-actions") {
    send({
      id: "root-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test",
        itemId: "root-command",
        reason: "Run root tests",
        threadId,
        turnId,
      },
    });
    send({
      id: "child-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm lint",
        itemId: "child-command",
        reason: "Run child checks",
        threadId: "codex-child-thread-1",
        turnId: "codex-child-turn-1",
      },
    });
    return;
  }
  if (scenario === "provider-cancels-action") {
    send({
      id: "cancelled-child-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test",
        itemId: "cancelled-child-command",
        reason: "Run child tests",
        threadId: "codex-child-thread-1",
        turnId: "codex-child-turn-1",
      },
    });
    send({
      method: "serverRequest/resolved",
      params: {
        requestId: "cancelled-child-approval-rpc",
        threadId: "codex-child-thread-1",
      },
    });
    sendTurnCompleted("completed");
    return;
  }
  if (scenario === "reasoning") {
    send({
      method: "item/started",
      params: {
        item: { content: [], id: "reasoning-1", summary: [], type: "reasoning" },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: { delta: "Weighing", itemId: "reasoning-1", summaryIndex: 0, threadId, turnId },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: { delta: " options", itemId: "reasoning-1", summaryIndex: 0, threadId, turnId },
    });
    send({
      method: "item/reasoning/summaryPartAdded",
      params: { itemId: "reasoning-1", summaryIndex: 1, threadId, turnId },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: {
        delta: "Choosing a plan",
        itemId: "reasoning-1",
        summaryIndex: 1,
        threadId,
        turnId,
      },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: {
        delta: "FOREIGN-THREAD",
        itemId: "reasoning-1",
        summaryIndex: 0,
        threadId: "foreign-thread",
        turnId,
      },
    });
    send({
      method: "item/reasoning/textDelta",
      params: {
        contentIndex: 0,
        delta: "FOREIGN-TURN",
        itemId: "reasoning-1",
        threadId,
        turnId: "foreign-turn",
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          content: [],
          id: "reasoning-1",
          summary: ["Weighing options", "Choosing a plan"],
          type: "reasoning",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          content: ["Raw reasoning content"],
          id: "reasoning-2",
          summary: ["Summarized reasoning"],
          type: "reasoning",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: { content: [], id: "reasoning-3", summary: [], type: "reasoning" },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: { id: "message-1", phase: "final_answer", text: "Done.", type: "agentMessage" },
        threadId,
        turnId,
      },
    });
    sendTurnCompleted("completed");
    return;
  }

  send({
    method: "item/agentMessage/delta",
    params: { delta: "FOREIGN", itemId: "foreign-message", threadId: "foreign-thread", turnId },
  });
  send({
    method: "item/started",
    params: {
      item: {
        command: "pnpm test",
        commandActions: [{ command: "pnpm test", type: "unknown" }],
        cwd: "/workspace",
        id: "command-1",
        status: "inProgress",
        type: "commandExecution",
      },
      threadId,
      turnId,
    },
  });
  send({
    id: "approval-rpc",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "pnpm test",
      itemId: "command-1",
      reason: "Run the project tests",
      threadId,
      turnId,
    },
  });
}

const conversationSteers = [];

function handleTurnSteer(message) {
  if (scenario === "conversation") {
    // Every message steered in is kept; one without `[hold]` ends the turn,
    // which then answers all of them in the order they arrived.
    const text = (message.params?.input ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    conversationSteers.push(text);
    send({ id: message.id, result: { turnId } });
    if (text.includes("[hold]")) return;
    send({
      method: "item/completed",
      params: {
        item: {
          content: [{ text, type: "text" }],
          id: `steered-${randomUUID()}`,
          type: "userMessage",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          id: `conversation-handled-${randomUUID()}`,
          phase: "final_answer",
          text: `Handled ${conversationSteers.length}: ${conversationSteers.join(" | ")}`,
          type: "agentMessage",
        },
        threadId,
        turnId,
      },
    });
    conversationSteers.length = 0;
    sendTurnCompleted("completed");
    return;
  }
  if (scenario === "steer-not-steerable") {
    send({
      id: message.id,
      error: {
        code: -32600,
        data: {
          additional_details: null,
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
          message: "cannot steer a review turn",
        },
        message: "cannot steer a review turn",
      },
    });
    return;
  }
  if (scenario === "steer-failure") {
    send({ id: message.id, error: { code: -32603, message: "steer exploded" } });
    return;
  }
  send({ id: message.id, result: { turnId } });
  if (scenario.startsWith("denial-note-")) return;
  sendResponseUsage("response", threadId, turnId, responseUsage.steered);
  send({
    method: "item/completed",
    params: {
      item: {
        id: "message-1",
        phase: "final_answer",
        text: `Handled: ${message.params.input[0].text}`,
        type: "agentMessage",
      },
      threadId,
      turnId,
    },
  });
  sendTurnCompleted("completed");
}

/**
 * A conversation's turn: one holding for the person's next message (`[hold]`),
 * one asking for approval first and then holding (`[approve]`), or one that
 * answers at once naming every input it was started with, so a test can see
 * which messages reached the same turn.
 */
function conversationTurn(input) {
  const texts = input.filter((item) => item.type === "text").map((item) => item.text);
  const joined = texts.join("\n");
  if (joined.includes("[approve]")) {
    send({
      id: "conversation-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", "decline"],
        command: "pnpm test",
        itemId: "conversation-command",
        reason: "Run tests",
        threadId,
        turnId,
      },
    });
    return;
  }
  if (joined.includes("[hold]")) return;
  // Codex gives its final answer, then a message steered in keeps the turn going.
  if (joined.includes("[answer-first]")) {
    send({
      method: "item/completed",
      params: {
        item: {
          id: `conversation-first-${randomUUID()}`,
          phase: "final_answer",
          text: "First answer.",
          type: "agentMessage",
        },
        threadId,
        turnId,
      },
    });
    return;
  }
  send({
    method: "item/completed",
    params: {
      item: {
        id: `conversation-answer-${randomUUID()}`,
        phase: "final_answer",
        text: `Answered ${texts.length}: ${joined}`,
        type: "agentMessage",
      },
      threadId,
      turnId,
    },
  });
  sendTurnCompleted("completed");
}

const childThreadId = "codex-child-thread-1";

function childTurn(id, status) {
  return { error: null, id, items: [], status };
}

function sendSubagentActivity(id, kind) {
  const item = {
    agentPath: "/root/researcher",
    agentThreadId: childThreadId,
    id,
    kind,
    type: "subAgentActivity",
  };
  send({ method: "item/started", params: { item, threadId, turnId } });
  send({ method: "item/completed", params: { item, threadId, turnId } });
}

function sendChildItem(method, item, childTurnId = "child-turn-1") {
  send({ method, params: { item, threadId: childThreadId, turnId: childTurnId } });
}

function sendChildApproval() {
  send({
    id: "child-approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "cat NOTES.md",
      itemId: "child-command-1",
      reason: "Read the release notes",
      threadId: childThreadId,
      turnId: "child-turn-1",
    },
  });
}

function sendChildTurnCompleted(childThread, childTurnId, status) {
  send({
    method: "turn/completed",
    params: { threadId: childThread, turn: childTurn(childTurnId, status) },
  });
}

/** The child finishes, is followed up on as a new invocation, and the root answers. */
function finishSubagents() {
  sendChildItem("item/completed", {
    aggregatedOutput: "v2 ships Friday",
    command: "cat NOTES.md",
    cwd: "/workspace",
    id: "child-command-1",
    status: "completed",
    type: "commandExecution",
  });
  sendChildItem("item/completed", {
    id: "child-answer-1",
    text: "The release notes say v2 ships Friday.",
    type: "agentMessage",
  });
  sendResponseUsage("response", childThreadId, "child-turn-1", responseUsage.childAnswers);
  sendChildTurnCompleted(childThreadId, "child-turn-1", "completed");
  sendSubagentActivity("followup-1", "interacted");
  send({
    method: "turn/started",
    params: { threadId: childThreadId, turn: childTurn("child-turn-2", "inProgress") },
  });
  sendChildItem(
    "item/completed",
    { id: "child-answer-2", text: "Confirmed: Friday.", type: "agentMessage" },
    "child-turn-2",
  );
  sendResponseUsage("response", childThreadId, "child-turn-2", responseUsage.childConfirms);
  sendChildTurnCompleted(childThreadId, "child-turn-2", "completed");
  sendResponseUsage("response", threadId, turnId, responseUsage.rootAnswers);
  send({
    method: "item/completed",
    params: {
      item: {
        id: "message-1",
        phase: "final_answer",
        text: "The researcher confirmed Friday.",
        type: "agentMessage",
      },
      threadId,
      turnId,
    },
  });
  sendTurnCompleted("completed");
}

function handleServerResponse(message) {
  if (message.id === "child-approval-1") {
    capture({ childApproval: message.result });
    finishSubagents();
    return;
  }
  if (String(message.id).startsWith("denial-note-") && String(message.id).endsWith("-rpc")) {
    send({ method: "serverRequest/resolved", params: { requestId: message.id, threadId } });
    sendTurnCompleted("completed");
    return;
  }
  if (message.id === "run-scoped-approval-rpc") {
    sendTurnCompleted("completed");
    return;
  }
  // The answered turn goes on working until the person's next message reaches it.
  if (message.id === "conversation-approval-rpc") return;
  // A declined ask waits for the interrupt that follows it, as Codex does.
  if (message.id === "notifications-approval-rpc") {
    if (message.result?.decision === "accept") {
      send({
        method: "item/completed",
        params: {
          item: {
            id: `notifications-reply-${randomUUID()}`,
            phase: "final_answer",
            text: "Tests passed.",
            type: "agentMessage",
          },
          threadId,
          turnId,
        },
      });
      sendTurnCompleted("completed");
    }
    return;
  }
  if (message.id === "root-approval-rpc" || message.id === "child-approval-rpc") {
    resolvedNativeChildRequests.add(message.id);
    if (resolvedNativeChildRequests.size === 2) sendTurnCompleted("completed");
    return;
  }

  if (message.id === "execpolicy-approval-rpc" || message.id === "network-policy-approval-rpc") {
    send({
      method: "serverRequest/resolved",
      params: { requestId: message.id, threadId },
    });
    sendTurnCompleted("completed");
    return;
  }

  if (message.id === "mcp-approval-rpc") {
    send({
      method: "serverRequest/resolved",
      params: { requestId: "mcp-approval-rpc", threadId },
    });
    sendTurnCompleted("completed");
    return;
  }

  if (message.id === "file-rpc") {
    send({ method: "serverRequest/resolved", params: { requestId: "file-rpc", threadId } });
    send({
      id: "permissions-rpc",
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/workspace",
        environmentId: "fake-environment",
        itemId: "permission-1",
        permissions: {
          fileSystem: { read: ["/workspace/shared"], write: ["/workspace/generated"] },
          network: { enabled: true },
        },
        reason: "Use the build service",
        threadId,
        turnId,
      },
    });
    return;
  }

  if (message.id === "permissions-rpc") {
    send({
      method: "serverRequest/resolved",
      params: { requestId: "permissions-rpc", threadId },
    });
    sendTurnCompleted("completed");
    return;
  }

  if (message.id === "approval-rpc") {
    send({
      method: "serverRequest/resolved",
      params: { requestId: "approval-rpc", threadId },
    });
    send({
      method: "item/commandExecution/outputDelta",
      params: { delta: "tests passed", itemId: "command-1", threadId, turnId },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          aggregatedOutput: "tests passed",
          command: "pnpm test",
          cwd: "/workspace",
          exitCode: 0,
          id: "command-1",
          status: "completed",
          type: "commandExecution",
        },
        threadId,
        turnId,
      },
    });
    send({
      id: "input-rpc",
      method: "item/tool/requestUserInput",
      params: {
        autoResolutionMs: null,
        itemId: "input-item",
        questions: [
          {
            header: "Deploy",
            id: "environment",
            isOther: false,
            isSecret: false,
            options: [
              { description: "Use staging", label: "Staging" },
              { description: "Use production", label: "Production" },
            ],
            question: "Where should this deploy?",
          },
          {
            header: "Ticket",
            id: "ticket",
            isOther: true,
            isSecret: true,
            options: null,
            question: "What is the private ticket reference?",
          },
        ],
        threadId,
        turnId,
      },
    });
    return;
  }

  if (message.id === "input-rpc") {
    send({ method: "serverRequest/resolved", params: { requestId: "input-rpc", threadId } });
    send({
      method: "item/started",
      params: {
        item: {
          arguments: { threadId: "thread_00000000-0000-4000-8000-000000000001" },
          id: "mcp-core-1",
          server: "opensteer",
          status: "inProgress",
          tool: "thread_read",
          type: "mcpToolCall",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          arguments: { threadId: "thread_00000000-0000-4000-8000-000000000001" },
          id: "mcp-core-1",
          result: { content: [{ text: '{"messages":[]}', type: "text" }] },
          server: "opensteer",
          status: "completed",
          tool: "thread_read",
          type: "mcpToolCall",
        },
        threadId,
        turnId,
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: { delta: "Done", itemId: "message-1", threadId, turnId },
    });
    send({
      method: "item/agentMessage/delta",
      params: { delta: ".", itemId: "message-1", threadId, turnId },
    });
    send({
      method: "item/completed",
      params: {
        item: { id: "message-1", phase: "final_answer", text: "Done.", type: "agentMessage" },
        threadId,
        turnId,
      },
    });
    sendTurnCompleted("completed");
    return;
  }

  if (message.id === "unknown-rpc") sendTurnCompleted("completed");
}

/** The text of one long-stream message, built from exactly the deltas sent. */
function longStreamMessageText(messageIndex) {
  return Array.from({ length: longStreamDeltasPerMessage }, (_value, index) =>
    longStreamDelta(messageIndex, index),
  ).join("");
}

const longStreamMessages = 3;
const longStreamDeltasPerMessage = 1_200;
const longStreamReasoningDeltas = 300;
const longStreamCommandsPerMessage = 7;
const longStreamCommandDeltas = 30;

function longStreamDelta(messageIndex, index) {
  return `m${messageIndex}t${index} `;
}

/**
 * Thousands of live deltas around a few dozen durable items: three answers,
 * three reasoning blocks and twenty-one commands with streamed output. A held turn
 * stops after its first answer has begun and waits for the release file.
 */
async function longStreamTurn(held) {
  for (let message = 0; message < longStreamMessages; message += 1) {
    const reasoningId = `long-reasoning-${message}`;
    send({
      method: "item/started",
      params: {
        item: { content: [], id: reasoningId, summary: [], type: "reasoning" },
        threadId,
        turnId,
      },
    });
    let summary = "";
    for (let index = 0; index < longStreamReasoningDeltas; index += 1) {
      const delta = `r${message}d${index} `;
      summary += delta;
      send({
        method: "item/reasoning/summaryTextDelta",
        params: { delta, itemId: reasoningId, summaryIndex: 0, threadId, turnId },
      });
    }
    send({
      method: "item/completed",
      params: {
        item: { content: [], id: reasoningId, summary: [summary], type: "reasoning" },
        threadId,
        turnId,
      },
    });
    const messageId = `long-message-${message}`;
    for (let index = 0; index < longStreamDeltasPerMessage; index += 1) {
      send({
        method: "item/agentMessage/delta",
        params: { delta: longStreamDelta(message, index), itemId: messageId, threadId, turnId },
      });
      if (held && message === 0 && index === 199) await waitForRelease();
    }
    send({
      method: "item/completed",
      params: {
        item: {
          id: messageId,
          phase: message === longStreamMessages - 1 ? "final_answer" : "commentary",
          text: longStreamMessageText(message),
          type: "agentMessage",
        },
        threadId,
        turnId,
      },
    });
    for (let command = 0; command < longStreamCommandsPerMessage; command += 1) {
      const commandId = `long-command-${message}-${command}`;
      send({
        method: "item/started",
        params: {
          item: {
            command: `echo ${commandId}`,
            cwd: "/workspace",
            id: commandId,
            status: "inProgress",
            type: "commandExecution",
          },
          threadId,
          turnId,
        },
      });
      let output = "";
      for (let index = 0; index < longStreamCommandDeltas; index += 1) {
        const delta = `${commandId}:${index}\n`;
        output += delta;
        send({
          method: "item/commandExecution/outputDelta",
          params: { delta, itemId: commandId, threadId, turnId },
        });
      }
      send({
        method: "item/completed",
        params: {
          item: {
            aggregatedOutput: output,
            command: `echo ${commandId}`,
            cwd: "/workspace",
            exitCode: 0,
            id: commandId,
            status: "completed",
            stdout: output,
            type: "commandExecution",
          },
          threadId,
          turnId,
        },
      });
    }
  }
  sendTurnCompleted("completed");
}

async function durableStreamUntilReleased() {
  if (!releasePath) throw new Error("The sibling race needs a release file");
  for (let index = 0; index < 2; index += 1) {
    if (index === 1) await waitForRelease(`${releasePath}.sibling`);
    send({
      method: "item/completed",
      params: {
        item: {
          id: `race-note-${index}`,
          phase: "commentary",
          text: `Note ${index}`,
          type: "agentMessage",
        },
        threadId,
        turnId,
      },
    });
  }
  await waitForRelease();
  sendTurnCompleted("completed");
}

async function waitForRelease(path = releasePath) {
  if (!path) return;
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * The notification journeys' agent. Its turn input says what it does:
 * `[[fail]]` fails the turn, `[[hold]]` keeps it running until stopped,
 * `[[ask]]` asks the person to approve a command, each
 * `[[call <tool> <base64url JSON>]]` calls one Opensteer tool, and
 * `[[reply <text>]]` is its final answer (otherwise "Completed by Codex.").
 */
async function notificationsTurn(input, turnThreadId, turnTurnId) {
  const text = input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  capture({ notificationsTurn: { text, threadId: turnThreadId } });
  if (text.includes("[[fail]]")) {
    sendTurnCompleted("failed", { message: "The engine could not continue." }, turnTurnId);
    return;
  }
  if (text.includes("[[hold]]")) return;
  if (text.includes("[[ask]]")) {
    send({
      id: "notifications-approval-rpc",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept", "decline"],
        command: "pnpm test",
        itemId: "notifications-command",
        reason: "Run the test suite",
        threadId: turnThreadId,
        turnId: turnTurnId,
      },
    });
    return;
  }
  const results = [];
  for (const [, name, encoded] of text.matchAll(/\[\[call ([a-z_]+) ([A-Za-z0-9_-]+)\]\]/gu)) {
    try {
      sessionTools ??= await mcpClient(
        threadConfig["mcp_servers.opensteer.url"],
        process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
      );
      const result = await sessionTools.call(
        name,
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
      results.push({ name, ok: true, result });
    } catch (error) {
      results.push({ error: String(error?.message ?? error), name, ok: false });
    }
  }
  if (results.length > 0) capture({ notificationsToolCalls: results });
  const failed = results.find((result) => !result.ok);
  const reply = failed
    ? `Tool ${failed.name} failed: ${failed.error}`
    : (/\[\[reply (.+?)\]\]/su.exec(text)?.[1] ?? "Completed by Codex.");
  send({
    method: "item/completed",
    params: {
      item: {
        id: `notifications-reply-${randomUUID()}`,
        phase: "final_answer",
        text: reply,
        type: "agentMessage",
      },
      threadId: turnThreadId,
      turnId: turnTurnId,
    },
  });
  sendTurnCompleted("completed", undefined, turnTurnId);
}

function finishTurnWith(text) {
  send({
    method: "item/completed",
    params: {
      item: { id: "browser-agent-report", phase: "final_answer", text, type: "agentMessage" },
      threadId,
      turnId,
    },
  });
  sendTurnCompleted("completed");
}

async function browserJourneyHarness(sessionId, program, targetId) {
  const child = spawn(
    process.execPath,
    [
      process.env.OPENSTEER_BROWSER_HARNESS,
      ...(sessionId ? ["--session", sessionId] : []),
      ...(targetId ? ["--tab", targetId] : []),
    ],
    { env: process.env, timeout: 60_000 },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
      }),
    );
  });
  child.stdin.end(program);
  return completed;
}

async function tabGroupJourney(input) {
  const text = input
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const plan = JSON.parse(/TAB_GROUP_JOURNEY:([^\n]+)/u.exec(text)[1]);
  const tools = await mcpClient(
    threadConfig["mcp_servers.opensteer.url"],
    process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
  );
  const report = { pages: [], calls: [] };
  for (const call of plan.calls ?? []) {
    try {
      report.calls.push({ result: await tools.call(call.name, call.input, call.requestId) });
    } catch (error) {
      report.calls.push({ error: String(error?.message ?? error) });
    }
  }
  if (plan.immediate) {
    const opened = await tools.call("browser_session_open", { fresh: true });
    const page = await browserJourneyHarness(
      opened.session.id,
      `await newTab(); console.log(JSON.stringify(await currentTab()));`,
    );
    if (page.code !== 0) throw new Error(page.stderr);
    const tab = JSON.parse(page.stdout);
    const tabId = tab.surfaceId ?? tab.id;
    const input = { action: "group", tabIds: [tabId], title: "Organize research" };
    const first = await tools.call("browser_tab_write", input, 9001);
    const replay = await tools.call("browser_tab_write", input, 9001);
    report.immediate = { tabId, first, replay };
  }
  if ((plan.calls ?? []).some((c) => c.input.action === "restore"))
    report.attached = await tools.call("browser_session_list", {});
  if (plan.paginate) {
    let cursor;
    do {
      const page = await tools.call("browser_tab_read", cursor ? { cursor } : {});
      report.pages.push(page);
      cursor = page.nextCursor;
      if (report.pages.length > 100) throw new Error("Pagination did not terminate");
    } while (cursor);
  }
  return report;
}

async function browserAgentTurn(input) {
  const text = input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const dialogPage = /DIALOG_PAGE=(\S+)/u.exec(text)?.[1];
  if (dialogPage)
    return browserDialogTurn(dialogPage, /DIALOG_TRIGGER=(\w+)/u.exec(text)?.[1] ?? "mousedown");
  const uploadPage = /UPLOAD_PAGE=(\S+)/u.exec(text)?.[1];
  const checkProfile = /CHECK_PROFILE=(\S+)/u.exec(text)?.[1];
  if (checkProfile && uploadPage) {
    // A later Run: reopen the profile and read what it kept.
    const tools = await mcpClient(
      threadConfig["mcp_servers.opensteer.url"],
      process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
    );
    const opened = await tools.call("browser_session_open", { profileId: checkProfile });
    const result = await browserJourneyHarness(
      opened.session.id,
      `await newTab(${JSON.stringify(`${uploadPage}?account`)});
await waitForLoad();
console.log(JSON.stringify(await js("document.cookie")));`,
    );
    return { cookie: result.code === 0 ? JSON.parse(result.stdout) : result.stderr };
  }
  const photo =
    input.find((part) => part.type === "localImage")?.path ??
    /Readable path: ([^\n]+)/u.exec(text)?.[1];
  if (!uploadPage || !photo) throw new Error("The prompt names no upload page or attached photo");
  const tools = await mcpClient(
    threadConfig["mcp_servers.opensteer.url"],
    process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
  );
  const report = { photoName: basename(photo) };

  const first = await tools.call("browser_session_open", { fresh: true });
  const second = await tools.call("browser_session_open", { fresh: true });
  report.opened = [first.session.id, second.session.id];
  report.listed = (await tools.call("browser_session_list", {})).sessions.map((session) => ({
    attached: session.attached,
    id: session.id,
  }));

  const upload = await browserJourneyHarness(
    first.session.id,
    `await newTab(${JSON.stringify(uploadPage)});
await waitForLoad();
const direct = await setInputFiles("#single", [${JSON.stringify(photo)}]);
const box = await js("(() => { const r = document.querySelector('#choose').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
const chooser = await setInputFiles(box, [${JSON.stringify(photo)}]);
for (let attempt = 0; attempt < 50; attempt += 1) {
  const received = await js("window.received");
  if (received.single && received.hidden) break;
  await sleep(100);
}
console.log(JSON.stringify({ chooser, direct, received: await js("window.received"), targetId: (await currentTab()).targetId }));`,
  );
  report.upload = upload.code === 0 ? JSON.parse(upload.stdout) : upload;

  const other = await browserJourneyHarness(
    second.session.id,
    `await newTab(${JSON.stringify(`${uploadPage}?second`)});
await waitForLoad();
console.log(JSON.stringify(await pageInfo()));`,
  );
  report.second = other.code === 0 ? JSON.parse(other.stdout) : other;
  const back = await browserJourneyHarness(
    first.session.id,
    `console.log(JSON.stringify(await js("({ received: Object.keys(window.received), url: location.href })")));`,
    report.upload.targetId,
  );
  report.backToFirst = back.code === 0 ? JSON.parse(back.stdout) : back;

  // Browsing as a person does: the session's own page carries each visit, and
  // a tab that went nowhere or served its purpose does not stay open.
  const browsing = await tools.call("browser_session_open", { fresh: true });
  const visit = async (program) => {
    const result = await browserJourneyHarness(browsing.session.id, program);
    return result.code === 0 ? { ...JSON.parse(result.stdout), stderr: result.stderr } : result;
  };
  const tabState = `console.log(JSON.stringify({ tabs: (await listTabs()).length, url: (await pageInfo()).url }));`;
  report.browsing = {
    start: await visit(`await gotoUrl(${JSON.stringify(`${uploadPage}?first`)});
await waitForLoad();
${tabState}`),
    inPlace: await visit(`await gotoUrl(${JSON.stringify(`${uploadPage}?next`)});
await waitForLoad();
${tabState}`),
    failed: await visit(`const failures = [];
for (const url of ["example.com", "http://127.0.0.1:1/"]) {
  try {
    failures.push({ opened: await newTab(url) });
  } catch (error) {
    failures.push({ error: error.message });
  }
}
console.log(JSON.stringify({ failures, tabs: (await listTabs()).length, url: (await pageInfo()).url }));`),
    many: await visit(`const opened = [];
for (let index = 0; index < 7; index += 1) {
  opened.push(await newTab(${JSON.stringify(`${uploadPage}?tab=`)} + index));
}
const whileMany = (await listTabs()).length;
for (const targetId of opened) await closeTab(targetId);
console.log(JSON.stringify({ tabs: (await listTabs()).length, whileMany }));`),
    // Each way an agent presses Cmd+V, reported without what a paste would hold.
    paste: await visit(`await gotoUrl(${JSON.stringify(`${uploadPage}?paste`)});
await waitForLoad();
await js("(() => { document.body.insertAdjacentHTML('beforeend', '<div id=paste-probe contenteditable=true></div>'); window.pastes = 0; window.vKeys = 0; document.addEventListener('paste', () => window.pastes++, true); document.addEventListener('keydown', (event) => { if (event.key.toLowerCase() === 'v') window.vKeys++; }, true); document.querySelector('#paste-probe').focus(); return true; })()");
const refusals = [];
for (const attempt of [
  () => page.keyboard.press("Meta+V"),
  () => pressKey("v", { modifiers: 4 }),
  () => pressKey("v", { modifiers: 4, commands: [] }),
  () => cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 }),
]) {
  try {
    await attempt();
    refusals.push("sent");
  } catch (error) {
    refusals.push(/Pasting is not available to agents/.test(String(error)) ? "refused" : String(error));
  }
}
await page.keyboard.type("ok");
console.log(JSON.stringify({ refusals, ...(await js("({ pastes: window.pastes, vKeys: window.vKeys, typedOnly: document.querySelector('#paste-probe').textContent === 'ok' })")) }));`),
  };
  await tools.call("browser_session_close", { sessionId: browsing.session.id });

  report.withoutSession = await browserJourneyHarness(undefined, "console.log(1)");
  report.outsideFile = await browserJourneyHarness(
    first.session.id,
    `const found = await cdp("Runtime.evaluate", { expression: "document.querySelector('#single')" });
await cdp("DOM.setFileInputFiles", { files: ["/etc/hosts"], objectId: found.result.objectId });`,
    report.upload.targetId,
  );
  await tools.call("browser_session_close", { sessionId: second.session.id });
  report.endedSession = await browserJourneyHarness(second.session.id, "await pageInfo()");
  report.unknownSession = await browserJourneyHarness(
    "bsn_00000000-0000-4000-8000-00000000dead",
    "await pageInfo()",
  );

  // A granted profile: asking again is answered at once, and a session on it
  // saves the profile's state while in use.
  const profileId = /PROFILE_ID=(\S+)/u.exec(text)?.[1];
  if (profileId) {
    report.accessAlreadyAvailable = await tools
      .call("browser_access_request", {
        reason: "List the mattress",
        suggestion: { kind: "existing", profileId },
      })
      .then(
        (result) => ({ result }),
        (error) => ({ error: String(error.message) }),
      );
    const profiled = await tools.call("browser_session_open", { profileId });
    report.profileSession = profiled.session.id;
    report.signedIn = await browserJourneyHarness(
      profiled.session.id,
      `await newTab(${JSON.stringify(`${uploadPage}?account`)});
await waitForLoad();
await js("document.cookie = 'marketplace_session=signed-in; max-age=86400; path=/'");
console.log(JSON.stringify(await js("document.cookie")));`,
    );
  }
  return report;
}

/**
 * Dialogs through the Host's CDP route, as an agent meets them. `trigger` is
 * the event whose handler opens the dialog (mousedown, click or keydown), or
 * "replacement": a dialog whose answer opens a second one.
 */
async function browserDialogTurn(page, trigger) {
  const tools = await mcpClient(
    threadConfig["mcp_servers.opensteer.url"],
    process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
  );
  const opened = await tools.call("browser_session_open", { fresh: true });
  const timed = async (program) => {
    const started = Date.now();
    const result = await browserJourneyHarness(opened.session.id, program);
    let output;
    try {
      output = JSON.parse(result.stdout.split("\n").at(-1));
    } catch {
      output = { stdout: result.stdout };
    }
    // `doneAt` is the program's last moment; what follows is the harness leaving.
    const exitMs = typeof output.doneAt === "number" ? Date.now() - output.doneAt : undefined;
    return {
      ...output,
      code: result.code,
      exitMs,
      runMs: Date.now() - started,
      stderr: result.stderr,
    };
  };
  const replacement = trigger === "replacement";
  const event = replacement ? "mousedown" : trigger;
  const prepare = `(() => {
  document.body.insertAdjacentHTML('beforeend', '<button id=dialog-target style=position:fixed;left:0;top:0;width:200px;height:100px;z-index:9>Delete</button>');
  const target = document.querySelector('#dialog-target');
  window.inputs = 0;
  window.answers = [];
  target.addEventListener(${JSON.stringify(event)}, () => {
    window.inputs++;
    window.answers.push(confirm('Delete this listing?'));
    ${replacement ? "window.answers.push(confirm('Really delete it?'));" : ""}
  });
  target.focus();
  return true;
})()`;
  const act = event === "keydown" ? `pressKey("a")` : "clickAt(100, 50)";
  const setup = `await gotoUrl(${JSON.stringify(page)});
await waitForLoad();
await js(${JSON.stringify(prepare)});
const started = Date.now();
let outcome = "acted";
let dialogId;
try {
  await ${act};
} catch (error) {
  outcome = String(error?.name) + ": " + String(error?.message).slice(0, 160);
  dialogId = error?.dialog?.id;
}
const actMs = Date.now() - started;`;
  const settled = `for (let attempt = 0; attempt < 50 && (await js("window.answers.length")) < ${replacement ? 2 : 1}; attempt += 1) await sleep(100);
const seen = await js("({ inputs: window.inputs, answers: window.answers })");`;
  let report;
  if (replacement) {
    report = {
      replacement: await timed(`${setup}
await cdp("Page.handleJavaScriptDialog", { accept: true, dialogId });
let replacementId;
for (let attempt = 0; attempt < 50; attempt += 1) {
  replacementId = (await currentTab()).dialog?.id;
  if (replacementId && replacementId !== dialogId) break;
  await sleep(100);
}
let stale;
try {
  await cdp("Page.handleJavaScriptDialog", { accept: false, dialogId });
  stale = "answered";
} catch (error) {
  stale = "refused: " + String(error?.message).slice(0, 160);
}
const stillOpen = (await currentTab()).dialog?.id;
await cdp("Page.handleJavaScriptDialog", { accept: true, dialogId: stillOpen });
${settled}
console.log(JSON.stringify({ outcome, dialogId, replacementId, stale, stillOpen, ...seen, doneAt: Date.now() }));`),
    };
  } else {
    report = {
      leftOpen: await timed(`${setup}
console.log(JSON.stringify({ outcome, actMs, dialogId, doneAt: Date.now() }));`),
    };
    report.answeredLater = await timed(`const openId = (await currentTab()).dialog?.id;
const answering = Date.now();
await cdp("Page.handleJavaScriptDialog", { accept: true, dialogId: openId });
${settled}
console.log(JSON.stringify({ openId, ...seen, answerMs: Date.now() - answering, doneAt: Date.now() }));`);
    report.sameProgram = await timed(`${setup}
const answering = Date.now();
await cdp("Page.handleJavaScriptDialog", { accept: true });
${settled}
console.log(JSON.stringify({ outcome, actMs, dialogId, ...seen, answerMs: Date.now() - answering, doneAt: Date.now() }));`);
  }
  await tools.call("browser_session_close", { sessionId: opened.session.id });
  return report;
}

/** Profile journeys use only the agent's MCP surface and shipped Browser Harness. */
async function browserProfilesTurn(input) {
  const inputText = input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const marker = /BROWSER_PROFILE_JOURNEY:([^\n]+)/u.exec(inputText)?.[1];
  const plan = marker ? JSON.parse(marker) : {};
  const report = { inputText };
  try {
    const tools = await mcpClient(
      threadConfig["mcp_servers.opensteer.url"],
      process.env.OPENSTEER_AGENT_TOOLS_TOKEN,
    );
    report.tools = (await tools.list()).tools.map((tool) => tool.name).sort();
    const call = (name, args, replayId) => {
      if (!report.tools.includes(name)) throw new Error(`${name} is not offered`);
      return tools.call(name, args, replayId);
    };
    if (plan.create) {
      report.created = await call("browser_profile_create", { name: plan.create.name }, 9001);
      if (plan.create.replay)
        report.replayed = await call("browser_profile_create", { name: plan.create.name }, 9001);
      if (plan.create.independent)
        report.independent = await call("browser_profile_create", { name: plan.create.name }, 9002);
    }
    if (plan.delegate)
      report.delegated = await call("thread_delegate", {
        workspaceId: plan.delegate,
        task: 'Report your tool inventory. BROWSER_PROFILE_JOURNEY:{"kind":"delegated"}',
        title: "Profile authority inventory",
      });
    if (plan.request)
      report.request = await call("browser_access_request", {
        reason: "Create an isolated profile for the fixture account",
        suggestion: { kind: "new", suggestedName: "brex-ops" },
      });
    let sessionId = plan.sessionId;
    if (plan.open) {
      report.opened = await call(
        "browser_session_open",
        plan.open === "created" ? { profileId: report.created.profile.id } : plan.open,
      );
      sessionId = report.opened.session.id;
    } else if (sessionId && plan.visit) {
      report.opened = await call("browser_session_open", { sessionId });
    }
    if (plan.visit) {
      const page = await browserJourneyHarness(
        sessionId,
        `await gotoUrl(${JSON.stringify(plan.visit)});\nawait waitForLoad();\nconsole.log(JSON.stringify(await js("({signedIn: document.body.dataset.signedIn === 'true', url: location.href})")));`,
      );
      if (page.code !== 0) throw new Error(`Browser Harness: ${page.stderr}`);
      report.page = JSON.parse(page.stdout);
    }
    if (plan.tabs) {
      report.tabs = [];
      let cursor;
      do {
        const page = await call("browser_tab_read", cursor ? { cursor } : {});
        report.tabs.push(...page.tabs);
        cursor = page.nextCursor;
        if (report.tabs.length > 1000) throw new Error("Tab pagination did not terminate");
      } while (cursor);
    }
    if (plan.close) report.closed = await call("browser_session_close", { sessionId });
    report.profiles = await call("browser_profile_list", plan.site ? { site: plan.site } : {});
  } catch (error) {
    report.error = String(error?.message ?? error);
  }
  return report;
}

/** The smallest Streamable HTTP MCP client: initialize once, then call tools. */
async function mcpClient(url, token) {
  if (!url || !token) throw new Error("The Opensteer MCP server is not configured");
  let sessionId;
  let nextId = 1;
  const post = async (body) => {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      method: "POST",
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const raw = await response.text();
    if (!("id" in body)) return undefined;
    const payload = raw.trim().startsWith("{")
      ? raw
      : raw
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .at(-1);
    const message = JSON.parse(payload ?? "{}");
    if (message.error) throw new Error(message.error.message);
    return message.result;
  };
  await post({
    id: nextId++,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "fake-codex", version },
      protocolVersion: "2025-06-18",
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    get sessionId() {
      return sessionId;
    },
    async list() {
      return post({ id: nextId++, jsonrpc: "2.0", method: "tools/list", params: {} });
    },
    async call(name, argumentsValue, replayId) {
      const result = await post({
        id: replayId ?? nextId++,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: argumentsValue, name },
      });
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
      return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
    },
  };
}

function sendTurnCompleted(status, error, id = turnId) {
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        error: status === "failed" ? (error ?? { message: "fake failure" }) : null,
        id,
        items: [],
        status,
      },
    },
  });
}

function sendInitialize(message) {
  send({
    id: message.id,
    result: {
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: `Codex Desktop/${version} (Fake; arm64)`,
    },
  });
}

function requireInitialized(message) {
  if (initialized) return;
  send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function capture(message) {
  if (capturePath && process.argv.includes("--capture-records")) {
    if (message.params?.threadId) captureRunId = message.params.threadId;
    // initialize has no thread yet. The immutable process identity correlates
    // its credentials with the later thread/start or thread/resume record.
    writeCaptureRecord(message, captureRunId);
    return;
  }
  if (capturePath)
    appendFileSync(
      capturePath,
      `${JSON.stringify(
        process.argv.includes("--capture-process-id")
          ? { ...message, captureProcessId: process.pid }
          : message,
      )}\n`,
    );
}

/** The value half of a `-c key=<TOML literal>` override, or undefined when unset. */
function overrideValue(key) {
  const argument = process.argv.find((value) => value.startsWith(`${key}=`));
  return argument?.slice(key.length + 1);
}

let backgroundTurns = 0;

/**
 * The root starts a researcher and answers while it works; a later message is
 * a turn of its own; the researcher finishes when the release file appears.
 */
function backgroundTurn(message) {
  backgroundTurns += 1;
  const id = `codex-turn-${backgroundTurns}`;
  const turn = (status) => ({ error: null, id, items: [], status });
  const answerStart = () => send({ id: message.id, result: { turn: turn("inProgress") } });
  const announce = () =>
    send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
  const start = () => {
    answerStart();
    announce();
  };
  const answer = (text) => {
    send({
      method: "item/completed",
      params: {
        item: { id: `message-${id}`, phase: "final_answer", text, type: "agentMessage" },
        threadId,
        turnId: id,
      },
    });
    send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
  };
  if (backgroundTurns > 1) {
    const noted = `Noted: ${message.params.input.map((part) => part.text ?? "").join(" ")}`;
    const respond = () => {
      sendResponseUsage("response", threadId, id, responseUsage.rootFollowsUp);
      answer(noted);
    };
    // A new turn that is still starting when a Stop reaches the engine: it
    // starts only once the Stop has asked for the child to be interrupted,
    // and then works until it is stopped too.
    if (process.argv.includes("--slow-follow-up-start")) {
      // `--announce-before-answer` names the turn at once and answers the
      // request that started it only well after the Runner's stop grace.
      followUpStart = process.argv.includes("--announce-before-answer")
        ? () => {
            announce();
            setTimeout(answerStart, 5_000);
          }
        : start;
      return;
    }
    if (process.argv.includes("--child-ends-while-starting") && !backgroundChildDone) {
      // The child finishes while the root's new turn is still starting.
      finishBackgroundChild();
      setTimeout(() => {
        start();
        respond();
      }, 200);
      return;
    }
    start();
    respond();
    return;
  }
  start();
  sendResponseUsage("response", threadId, id, responseUsage.rootDelegatesInBackground);
  sendSubagentActivity("spawn-1", "started");
  send({
    method: "turn/started",
    params: { threadId: childThreadId, turn: childTurn("child-turn-1", "inProgress") },
  });
  sendChildItem("item/started", {
    command: "sleep 600",
    cwd: "/workspace",
    id: "child-command-1",
    status: "inProgress",
    type: "commandExecution",
  });
  sendResponseUsage("response", childThreadId, "child-turn-1", responseUsage.childWorks);
  answer("The researcher is working in the background.");
  const watch = setInterval(() => {
    if (backgroundChildDone) clearInterval(watch);
    if (!releasePath || !existsSync(releasePath)) return;
    clearInterval(watch);
    finishBackgroundChild();
  }, 50);
}

let backgroundChildDone = false;
/** A `--slow-follow-up-start` turn waiting to start. */
let followUpStart;

function finishBackgroundChild() {
  if (backgroundChildDone) return;
  backgroundChildDone = true;
  sendChildItem("item/completed", {
    aggregatedOutput: "done",
    command: "sleep 600",
    cwd: "/workspace",
    id: "child-command-1",
    status: "completed",
    type: "commandExecution",
  });
  // A step the child takes after the root has answered.
  sendChildItem("item/started", {
    command: "cat findings.md",
    cwd: "/workspace",
    id: "child-command-2",
    status: "inProgress",
    type: "commandExecution",
  });
  sendChildItem("item/completed", {
    aggregatedOutput: "findings",
    command: "cat findings.md",
    cwd: "/workspace",
    id: "child-command-2",
    status: "completed",
    type: "commandExecution",
  });
  sendChildItem("item/completed", {
    id: "child-answer-1",
    text: "Background research finished.",
    type: "agentMessage",
  });
  sendResponseUsage("response", childThreadId, "child-turn-1", responseUsage.childFinishes);
  sendChildTurnCompleted(childThreadId, "child-turn-1", "completed");
}

function tokens(inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoning) {
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens: reasoning,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Each model response's own usage, as Codex states it in `last`. */
const responseUsage = {
  // Captured from Codex 0.156.0: a first response, then a short second one.
  first: tokens(17_492, 11_008, 0, 151, 51),
  second: tokens(17_669, 17_152, 0, 5, 0),
  // Shaped like Codex 0.156.0's: a thread's one-response turn (17,515 in
  // all), then a resumed engine's turn (17,742; 35,257 running).
  firstResponse: tokens(17_364, 11_008, 0, 151, 51),
  laterResponse: tokens(17_590, 17_152, 0, 152, 64),
  foreignTurn: tokens(4_096, 3_072, 0, 64, 32),
  foreignThread: tokens(2_560, 0, 0, 48, 16),
  // A compaction's summary response; the running total restarts from it.
  compaction: tokens(2_100, 0, 0, 300, 0),
  afterCompaction: tokens(2_900, 1_792, 256, 88, 21),
  late: tokens(1_000, 512, 0, 10, 0),
  beforeSteer: tokens(11_000, 5_120, 0, 77, 33),
  steered: tokens(11_350, 10_880, 128, 64, 16),
  rootDelegates: tokens(12_000, 6_144, 0, 240, 128),
  childRuns: tokens(8_000, 0, 0, 410, 190),
  childAnswers: tokens(8_650, 7_936, 0, 95, 0),
  childConfirms: tokens(9_100, 8_448, 0, 37, 12),
  rootAnswers: tokens(12_700, 12_032, 0, 61, 9),
  rootDelegatesInBackground: tokens(15_000, 9_984, 0, 180, 64),
  childWorks: tokens(6_400, 0, 0, 520, 300),
  rootFollowsUp: tokens(15_400, 15_104, 0, 46, 0),
  childFinishes: tokens(7_100, 6_272, 0, 140, 40),
};

/**
 * Where a thread's reading outlives this process, as Codex keeps it with the
 * thread's history: in the profile's home, which every engine of the profile
 * shares.
 */
function usageStorePath() {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "fake-token-usage.json") : undefined;
}

function storedUsage() {
  const path = usageStorePath();
  return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function storeUsage(thread, turn, reading) {
  if (ephemeralThreads.has(thread)) return;
  const path = usageStorePath();
  if (path)
    writeFileSync(path, JSON.stringify({ ...storedUsage(), [thread]: { reading, turnId: turn } }));
}

function addTokens(left, right) {
  return Object.fromEntries(Object.keys(right).map((key) => [key, left[key] + right[key]]));
}

/** One model response on `thread`: its own usage added to the thread's running total. */
function sendResponseUsage(label, thread, turn, last) {
  const previous = usageReadings.get(thread)?.total;
  sendUsage(label, thread, turn, { last, total: previous ? addTokens(previous, last) : last });
}

function sendUsage(label, thread, turn, reading) {
  if (!tokenUsage) return;
  usageReadings.set(thread, reading);
  storeUsage(thread, turn, reading);
  const params = {
    threadId: thread,
    tokenUsage: { last: reading.last, modelContextWindow: 258_400, total: reading.total },
    turnId: turn,
  };
  capture({ usageFrame: { label, ...params } });
  send({ method: "thread/tokenUsage/updated", params });
}

/** The thread's newest reading stated again, unchanged, for `turn`. */
function restateThreadUsage(thread, turn, label = "restated") {
  const reading = usageReadings.get(thread);
  if (reading) sendUsage(label, thread, turn, reading);
}

/**
 * A turn of several responses: one reading stated twice, readings of a turn
 * and of a thread no Run here ran, and a compaction that resets the total.
 */
function sendSeveralResponsesUsage() {
  sendResponseUsage("response", threadId, turnId, responseUsage.first);
  if (impossibleUsage) sendResponseUsage("impossible", threadId, turnId, tokens(100, 90, 20, 5, 0));
  restateThreadUsage(threadId, turnId, "duplicate");
  sendResponseUsage("foreign turn", threadId, "codex-turn-0", responseUsage.foreignTurn);
  sendResponseUsage(
    "foreign thread",
    "codex-foreign-thread",
    "codex-foreign-turn",
    responseUsage.foreignThread,
  );
  sendResponseUsage("response", threadId, turnId, responseUsage.second);
  sendUsage("compaction", threadId, turnId, {
    last: responseUsage.compaction,
    total: responseUsage.compaction,
  });
  sendResponseUsage("response", threadId, turnId, responseUsage.afterCompaction);
}

/** Durable side effects and real child processes for restart-recovery acceptance. */
function recoveryHeldTurn(message) {
  const input = JSON.stringify(message.params.input);
  const recovery = input.includes("Your conversation is intact.");
  const effect = process.argv.find((value) => value.startsWith("--effect-file="))?.slice(14);
  if (effect && !recovery) appendFileSync(effect, "effect\n");
  if (input.includes("[effect]") && !recovery)
    appendFileSync(join(process.cwd(), "recovery-effect"), "effect\n");
  const watchPids = process.argv.find((value) => value.startsWith("--watch-pids-file="))?.slice(18);
  const priorPidsAlive =
    watchPids && existsSync(watchPids)
      ? JSON.parse(readFileSync(watchPids, "utf8")).map((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
      : [];
  capture({
    recoveryTurn: {
      pid: process.pid,
      threadId,
      input: message.params.input,
      recovery,
      scope: process.env.OPENSTEER_EXECUTION_SCOPE ?? null,
      acceptedAt: Date.now(),
      priorPidsAlive,
    },
  });
  send({
    id: message.id,
    result: { turn: { error: null, id: turnId, items: [], status: "inProgress" } },
  });
  send({
    method: "turn/started",
    params: { threadId, turn: { error: null, id: turnId, items: [], status: "inProgress" } },
  });
  if (process.argv.includes("--recovery-tool") && !recovery) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    capture({
      recoveryChild: { pid: child.pid, scope: process.env.OPENSTEER_EXECUTION_SCOPE ?? null },
    });
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: {
          id: "recovery-command",
          type: "commandExecution",
          command: "sleep 600 # recovery acceptance",
          cwd: process.cwd(),
          status: "inProgress",
        },
      },
    });
  }
  send({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "recovery-answer", delta: "RECOVERY_STREAM_HELD" },
  });
  const watch = setInterval(() => {
    if (!releasePath || !existsSync(releasePath)) return;
    clearInterval(watch);
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "recovery-answer",
          type: "agentMessage",
          phase: "final_answer",
          text: "Recovery task completed.",
        },
      },
    });
    sendTurnCompleted("completed");
  }, 25);
}
