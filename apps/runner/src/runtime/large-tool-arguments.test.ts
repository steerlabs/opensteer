import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId, toolArgumentsMaxSerializedBytes } from "@opensteer/core";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import {
  PendingAgentEventSchema,
  pendingAgentEventMaxSerializedBytes,
  RunnerCommandSchema,
  RunnerConnectionFenceSchema,
  type RunnerOperationalReport,
} from "@opensteer/protocol";
import { providerContinuationIdentityProjector } from "@opensteer/runner-client";
import { delay } from "@opensteer/shared/delay";
import { expect, it } from "vitest";
import { RunnerRuntime } from "./runtime.js";

it("records a successful Codex command with large inline arguments without failing the Run", async ({
  signal,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-large-tool-arguments-"));
  const artifactPath = join(directory, "summary.json");
  const workspacePath = join(directory, "workspace");
  const privateStateDirectory = join(directory, "state");
  await mkdir(workspacePath);
  const registry = new HarnessRegistry();
  registry.registerDriver(
    new CodexHarnessDriver({
      launch: {
        arguments: [
          fileURLToPath(
            new URL(
              "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
              import.meta.url,
            ),
          ),
          "--scenario=large-command-arguments",
        ],
        executable: process.execPath,
      },
    }),
  );
  const environmentId = createId("environment");
  const workspaceId = createId("workspace");
  const command = RunnerCommandSchema.parse({
    commandId: createId("command"),
    context: {
      accessMode: "full-access",
      assignment: null,
      agentControl: {
        token: "test-control",
        url: "https://host.example/internal/v1/agent-control",
      },
      agentTools: {
        capabilityProfileId: "workspace",
        token: "test-tools",
        url: "https://host.example/internal/v1/mcp",
      },
      browserCdp: { token: "test-browser", url: "https://host.example/internal/v1/browser-cdp" },
      integrationTools: {
        token: "test-tools",
        url: "https://host.example/internal/v1/integration-mcp",
      },
      integrationSkills: {
        token: "test-skills",
        url: "https://host.example/internal/v1/integration-skills",
      },
      bindingGeneration: 1,
      executionLeaseMs: 90_000,
      membershipGeneration: 1,
      egress: {
        maxRequestBytes: 8 * 1024 * 1024,
        maxResponseBytes: 8 * 1024 * 1024,
        relayToken: "test-relay",
        relayUrl: "https://host.example/internal/v1/egress/relay",
      },
      environmentId,
      harness: {
        config: {},
        driverKind: "codex",
        name: "Codex reproduction",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnessInstanceId: createId("harnessInstance"),
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      initialContext: null,
      modelSelection: { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" },
      providerSessionId: createId("providerSession"),
      providerSessionStateLayout: "thread",
      providerSessionReference: null,
      requestedBy: createId("user"),
      requesterTimeZone: null,
      runId: createId("run"),
      threadId: createId("thread"),
      threadRole: "work",
      threadState: { previousAssignment: null, previousRun: null },
      workspaceId,
      workspaceKind: "specialized",
      machineAccess: { callerMachineName: "test-runner", machines: [], omittedMachines: 0 },
      workspaceInstructionsPath: null,
      workspaceAccess: {
        createdBy: createId("user"),
        exchangeToken: "test-exchange",
        exchangeUrl: "https://host.example/internal/v1/mount-grants/exchange",
        generation: 1,
        kind: "portablefs",
        volumeId: "test-volume",
        workspaceId,
        workspaceKind: "specialized",
      },
    },
    correlationId: "large-tool-arguments",
    environmentId,
    inputs: [
      {
        author: { displayName: "User", kind: "human", principalId: "principal:test" },
        content: [{ text: "Save the inline image.", type: "text" }],
        createdAt: new Date().toISOString(),
        kind: "input",
        messageId: createId("message"),
      },
    ],
    reports: { messages: [], omittedCount: 0, throughSequence: null },
    type: "run.execute",
  });
  if (command.type !== "run.execute") throw new Error("Expected a run.execute command");
  const skillsRoot = fileURLToPath(new URL("../../agent-skills", import.meta.url));
  const skillPath = (name: string) => join(skillsRoot, "skills", name);
  const runtime = new RunnerRuntime({
    nodeExecutable: process.execPath,
    agentSkills: {
      rootPath: skillsRoot,
      paths: {
        "opensteer-specialization": skillPath("opensteer-specialization"),
        "opensteer-integrations": skillPath("opensteer-integrations"),
        "opensteer-browser": skillPath("opensteer-browser"),
        "opensteer-computer-use": skillPath("opensteer-computer-use"),
        "opensteer-computers": skillPath("opensteer-computers"),
        "opensteer-threads": skillPath("opensteer-threads"),
        "opensteer-triggers": skillPath("opensteer-triggers"),
        "opensteer-workspaces": skillPath("opensteer-workspaces"),
      },
    },
    integrationSkills: async () => ({
      cleanup: async () => undefined,
      digest: "none",
      directory: undefined,
      skills: [],
    }),
    bootId: "large-tool-arguments-test",
    browserHarnessExecutable: "/unused/browser-harness",
    deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    environmentId,
    harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
    harnesses: registry,
    maxConcurrentRuns: 1,
    dataDirectory: directory,
    privateStateDirectory,
    projectContinuationIdentity: providerContinuationIdentityProjector(
      generateKeyPairSync("ed25519").privateKey,
    ),
    workspaceManager: {
      writableRoots: () => [workspacePath],
      prepare: async () => ({ instructions: undefined, path: workspacePath }),
    },
  });
  const messages: RunnerOperationalReport[] = [];
  try {
    const definitions = [{ ...command.context.harness, id: command.context.harnessInstanceId }];
    await runtime.reconcileHarnesses(definitions);
    let catalogs = await runtime.inspectHarnesses(definitions, signal);
    while (catalogs.some((catalog) => catalog.status === "preparing")) {
      await delay(5, signal);
      catalogs = await runtime.inspectHarnesses(definitions, signal);
    }
    expect(catalogs, JSON.stringify(catalogs)).toMatchObject([{ status: "ready" }]);
    expect(
      await runtime.handleCommand(command, {
        send: async (message) => void messages.push(message),
      }),
    ).toEqual({ status: "accepted" });
    runtime.renewLeases({
      ...RunnerConnectionFenceSchema.parse({
        bootId: `rbt_${randomUUID()}`,
        connectionGeneration: 1,
        connectionId: `rcn_${randomUUID()}`,
        connectionLeaseId: `rls_${randomUUID()}`,
        runnerId: createId("runner"),
      }),
      heartbeatSentAt: new Date().toISOString(),
      leaseMs: command.context.executionLeaseMs,
      runIds: [command.context.runId],
      type: "host.executions.renewed",
    });
    while (runtime.activeRunIds().length > 0) await delay(5, signal);

    const events = messages.flatMap((message) =>
      message.type === "runner.event" ? [message.event] : [],
    );
    const terminal = events.at(-1);
    const summary = {
      scenario: "large-command-arguments",
      maxSerializedBytes: pendingAgentEventMaxSerializedBytes,
      events: events.map((event) => ({
        type: event.type,
        serializedBytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
        valid: PendingAgentEventSchema.safeParse(event).success,
      })),
      terminal,
    };
    await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Large command arguments artifact: ${artifactPath}`);
    console.log(`Terminal event: ${JSON.stringify(terminal)}`);

    expect(terminal?.type, JSON.stringify(terminal)).toBe("run.completed");
    for (const event of events) {
      expect(PendingAgentEventSchema.safeParse(event).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
        pendingAgentEventMaxSerializedBytes,
      );
    }
    const started = events.find(
      (event) => event.type === "tool.started" && event.data.callId === "large-command-arguments-1",
    );
    if (started?.type !== "tool.started") throw new Error("The command's call was not recorded");
    // The call's own command keeps its start and end around a marker saying
    // what was cut; the part Codex could not read does not repeat it.
    expect(started.data.arguments).toEqual({
      command: expect.stringMatching(
        /^\/bin\/zsh -lc "python3 - <<'PY'\n# HEAD-large-command-arguments\n[\s\S]*\n… \d+ bytes omitted …\n[\s\S]*\n# TAIL-large-command-arguments\nPY"$/u,
      ),
      commandActions: [{ type: "unknown" }],
      cwd: workspacePath,
    });
    expect(Buffer.byteLength(JSON.stringify(started.data.arguments), "utf8")).toBeLessThanOrEqual(
      toolArgumentsMaxSerializedBytes,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        data: {
          callId: "large-command-arguments-1",
          isError: false,
          output: { text: "Saved alaska-daytime.jpg\n" },
        },
        type: "tool.completed",
      }),
    );
  } finally {
    await runtime.close();
    await rm(privateStateDirectory, { force: true, recursive: true });
    await rm(workspacePath, { force: true, recursive: true });
  }
});
