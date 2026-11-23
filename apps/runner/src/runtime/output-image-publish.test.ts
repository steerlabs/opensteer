import { agentTools } from "@opensteer/agent-tools";
import {
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  createId,
  type RequestId,
  type RequestResponse,
  type ToolOutputImage,
} from "@opensteer/core";
import {
  BoundedEventStream,
  HarnessRegistry,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSession,
} from "@opensteer/harness";
import {
  CorrelationIdSchema,
  RunnerCommandSchema,
  RunnerConnectionFenceSchema,
  type RunnerCommand,
  type RunnerOperationalReport,
} from "@opensteer/protocol";
import { providerContinuationIdentityProjector } from "@opensteer/runner-client";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CausallyOrderedRunnerSink } from "../host/host-connection.js";
import { ExecutionContainment } from "./execution-containment.js";
import { RunnerRuntime } from "./runtime.js";

const testNativeFsHelperBinary = fileURLToPath(
  new URL(
    `../../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const testAgentSkills = {
  paths: {
    "opensteer:skills": "/runner/agent-skills/skills/skills",
    "opensteer:memory": "/runner/agent-skills/skills/memory",
    "opensteer:plugins": "/runner/agent-skills/skills/plugins",
    "opensteer:browser": "/runner/agent-skills/skills/browser",
    "opensteer:computer-use": "/runner/agent-skills/skills/computer-use",
    "opensteer:computers": "/runner/agent-skills/skills/computers",
    "opensteer:devices": "/runner/agent-skills/skills/devices",
    "opensteer:tasks": "/runner/agent-skills/skills/tasks",
    "opensteer:automations": "/runner/agent-skills/skills/automations",
  },
  rootPath: "/runner/agent-skills",
} as const;

const createdRoots: string[] = [];

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("RunnerRuntime output image publishing", () => {
  it.each(["success", "transfer failure", "unanswered publish"] as const)(
    "records the image and completes after %s",
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), "opensteer-output-image-publish-"));
      createdRoots.push(root);
      const dataDirectory = join(root, "runner-data");
      const privateStateDirectory = join(dataDirectory, "private");
      const agentHomePath = join(root, "home");
      const sourceImagePath = join(root, "generated.png");
      await mkdir(privateStateDirectory, { recursive: true });
      await mkdir(agentHomePath, { recursive: true });
      await writeFile(sourceImagePath, pngBytes);

      const driverKind = HarnessIdSchema.parse("test-driver");
      const capabilities = {
        approvals: false,
        attachments: false,
        interruption: true,
        mcpImageContent: false,
        resume: false,
        steering: false,
        toolCalls: true,
        userInput: false,
      };

      class ImageSession implements HarnessSession {
        readonly providerSessionReference = "provider-session-image";
        readonly #stream = new BoundedEventStream<HarnessEvent>({
          maxBytes: 100_000,
          maxItems: 100,
        });
        readonly events: AsyncIterable<HarnessEvent> = this.#stream;

        async execute(_turn: HarnessRunInput): Promise<void> {
          const delivery = { delivery: "must-deliver" as const };
          this.#stream.publish({ data: { status: "running" }, type: "run.started" }, delivery);
          this.#stream.publish(
            {
              data: {
                arguments: { prompt: "dot" },
                callId: "call-img-1",
                tool: { name: "image_generation", namespace: "test" },
              },
              type: "tool.started",
            },
            delivery,
          );
          this.#stream.publish(
            {
              data: {
                callId: "call-img-1",
                isError: false,
                output: {
                  images: [{ generated: true, mediaType: "image/png", path: sourceImagePath }],
                  text: "Generated",
                },
              },
              type: "tool.completed",
            },
            delivery,
          );
          this.#stream.publish(
            {
              data: {
                content: [{ text: "Done", type: "text" }],
                messageId: createId("message"),
              },
              type: "assistant.message",
            },
            delivery,
          );
          this.#stream.publish({ data: { status: "completed" }, type: "run.completed" }, delivery);
        }

        async interrupt(): Promise<void> {}
        async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}
        async stop(): Promise<void> {
          this.#stream.close();
        }
      }

      const driver: HarnessDriver = {
        accessModes: ["full-access"],
        capabilities,
        configSchema: z.strictObject({}),
        create: async ({ instanceId }) => ({
          capabilities,
          close: async () => undefined,
          instanceId,
          resumeSession: async () => new ImageSession(),
          startSession: async () => new ImageSession(),
        }),
        inspect: async () => ({
          models: [
            {
              displayName: "Test model",
              isDefault: true,
              modelId: ModelIdSchema.parse("test-model"),
              options: [],
              providerId: ModelProviderIdSchema.parse("test-provider"),
            },
          ],
          status: "ready",
        }),
        kind: driverKind,
        sources: [
          {
            fields: [],
            kind: "first-party",
            label: "Test",
            quota: "none",
            sourceId: "test",
            stateKinds: ["ambient"],
          },
        ],
      };

      const registry = new HarnessRegistry();
      registry.registerDriver(driver);

      const environmentId = createId("environment");
      const runnerId = createId("runner");
      const runtime = new RunnerRuntime({
        agentHome: {
          ensure: async () => agentHomePath,
          folder: async ({ path }) => path,
          prepare: async () => ({
            computerId: runnerId,
            instructions: undefined,
            path: agentHomePath,
          }),
        },
        agentSkills: testAgentSkills,
        bootId: "boot-output-image-test",
        browserHarnessExecutable: "/opt/opensteer/browser-harness",
        containment: new ExecutionContainment({
          bootId: "boot-output-image-test",
          dataDirectory,
          listProcesses: async () => [],
        }),
        dataDirectory,
        deploymentShape: { kind: "personal" },
        environmentId,
        harnesses: registry,
        maxConcurrentRuns: 1,
        nativeFsHelperBinary: testNativeFsHelperBinary,
        nodeExecutable: process.execPath,
        plugins: async () => ({
          cleanup: async () => undefined,
          digest: "none",
          directories: [],
          skills: [],
        }),
        privateStateDirectory,
        projectContinuationIdentity: providerContinuationIdentityProjector(
          generateKeyPairSync("ed25519").privateKey,
        ),
      });

      const timeline: string[] = [];
      const published: ToolOutputImage[] = [];
      const reports: RunnerOperationalReport[] = [];
      const settled = Promise.withResolvers<void>();

      const sink = new CausallyOrderedRunnerSink({
        send: async (message) => {
          reports.push(message);
          if (message.type === "runner.event") {
            timeline.push(`event:${message.event.type}`);
            if (message.event.type === "run.completed" || message.event.type === "run.failed") {
              settled.resolve();
            }
          }
        },
      });
      const publishing = Promise.withResolvers<AbortSignal>();
      sink.setOutputImagePublisher(async (image, signal) => {
        timeline.push(`publish:${basename(image.path)}`);
        published.push(image);
        if (outcome === "transfer failure") throw new Error("Upload failed");
        if (outcome === "unanswered publish") {
          publishing.resolve(signal);
          await new Promise<void>(() => undefined);
        }
      });

      const command = RunnerCommandSchema.parse({
        agentHome: { computerId: runnerId, path: agentHomePath },
        commandId: createId("command"),
        context: {
          accessMode: "full-access",
          agentTools: {
            instructions: "Host Opensteer instructions",
            skills: ["opensteer:skills"],
            token: "opaque-agent-tools-token",
            tools: agentTools
              .filter((tool) => tool.callers.includes("run"))
              .map(({ name }) => name),
            toolsRevision: "test-tools-v1",
            url: "https://host.example/internal/v1/mcp",
          },
          assignment: null,
          bindingGeneration: 1,
          browserCdp: { url: "https://host.example/internal/v1/browser-cdp" },
          egress: {
            maxRequestBytes: 8 * 1024 * 1024,
            maxResponseBytes: 8 * 1024 * 1024,
            relayToken: "opaque-relay-token",
            relayUrl: "https://host.example/internal/v1/egress/relay",
          },
          environmentId,
          executionLeaseMs: 90_000,
          harness: {
            config: {},
            driverKind,
            name: "Test harness",
            runtimeRevision: 1,
            sourceId: "test",
            stateKind: "ambient",
          },
          harnessInstanceId: createId("harnessInstance"),
          history: [],
          historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
          initialContext: null,
          machineAccess: { callerMachineName: "test-computer", machines: [], omittedMachines: 0 },
          modelSelection: {
            modelId: "test-model",
            options: {},
            providerId: "test-provider",
          },
          personalContext: true,
          plugins: {
            token: "plugin-cache-token",
            url: "https://host.example/internal/v1/plugin-cache",
            versions: [],
          },
          providerSessionId: createId("providerSession"),
          providerSessionReference: null,
          providerSessionStateLayout: "thread",
          requestedBy: createId("user"),
          runId: createId("run"),
          taskPurpose: "task",
          threadId: createId("thread"),
          threadState: { previousAssignment: null, previousRun: null },
        },
        correlationId: CorrelationIdSchema.parse("output-image-publish-test"),
        environmentId,
        inputs: [
          {
            author: {
              displayName: "User",
              kind: "human",
              principalId: "principal:test",
            },
            content: [{ text: "Generate image", type: "text" }],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
        ],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        type: "run.execute",
      }) as Extract<RunnerCommand, { type: "run.execute" }>;

      try {
        await registry.reconcileInstances([
          { ...command.context.harness, id: command.context.harnessInstanceId },
        ]);
        await runtime.handleCommand(command, sink);
        runtime.renewLeases({
          ...RunnerConnectionFenceSchema.parse({
            bootId: `rbt_${randomUUID()}`,
            connectionGeneration: 1,
            connectionId: `rcn_${randomUUID()}`,
            connectionLeaseId: `rls_${randomUUID()}`,
            runnerId,
          }),
          heartbeatSentAt: new Date().toISOString(),
          leaseMs: command.context.executionLeaseMs,
          runIds: [command.context.runId],
          type: "host.executions.renewed",
        });
        await settled.promise;
        if (outcome === "unanswered publish") {
          const signal = await publishing.promise;
          expect(signal.aborted).toBe(false);
        }

        const expectedFileName = `${createHash("sha256").update(pngBytes).digest("hex")}.png`;
        expect(published).toHaveLength(outcome === "transfer failure" ? 2 : 1);
        expect(published[0]).toMatchObject({
          generated: true,
          mediaType: "image/png",
          path: join(dataDirectory, "images", expectedFileName),
        });
        expect(
          reports.find(
            (report) => report.type === "runner.event" && report.event.type === "tool.completed",
          ),
        ).toMatchObject({ event: { data: { output: { images: [published[0]] } } } });
        expect(timeline).toContain("event:run.completed");
        expect(timeline).not.toContain("event:run.failed");
        expect(timeline.indexOf(`publish:${expectedFileName}`)).toBeGreaterThanOrEqual(0);
        expect(timeline.indexOf(`publish:${expectedFileName}`)).toBeLessThan(
          timeline.indexOf("event:tool.completed"),
        );
        expect(
          reports.some(
            (report) => report.type === "runner.event" && report.event.type === "run.failed",
          ),
        ).toBe(false);
      } finally {
        sink.close();
        await runtime.close();
      }
    },
  );
});
