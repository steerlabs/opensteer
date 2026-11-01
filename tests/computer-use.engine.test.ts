import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentEventViewSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  type RunId,
} from "../packages/core/src/index.js";
import {
  ComputerUseHelperRequestSchema,
  computerUseBridgeApprovalParams,
  type ComputerUseBridgeRequest,
  type ComputerUseObservation,
  type WindowInfo,
} from "../packages/protocol/src/index.js";
import {
  createComputerAppApproval,
  signComputerAppApprovalKeyChallenge,
} from "../packages/runner-auth/src/index.js";
import { nativeUserHarnessRuntimeBoundary } from "../packages/harness/src/index.js";
import { parseAgentExecutionConfig } from "../apps/runner/src/app-config.js";
import { createHarnessRegistry } from "../apps/runner/src/harness/harness-registry.js";
import { prepareIntegrationsModule } from "../apps/runner/src/computer-apps/prepare.js";
import {
  startVerticalStack,
  type VerticalStack,
} from "../apps/host/src/agents/vertical-stack.test-support.js";
import { startFakeDesktop } from "../apps/host/src/runtime/computer-apps.test-support.js";

const prompt =
  "In Notes, open the window called Recipes and type 'Lemon tart' into its Title field, then press Save in that window.";
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const recipesId = 84;
const sourceIds: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai" };

/*
 * A real signed-in engine, Host, QuickJS REPL and Runner; only the Mac's
 * desktop/helper is scripted. Failures to catch: legacy tool selection,
 * front-window fallback, guessed/stale indices, wrong field/button/window,
 * missing Host-authored transcript pairs, and a Run that never completes.
 * No GUI, app data or synthetic input on the computer running this test.
 */
describe("real-engine computer use", () => {
  it("edits and saves Recipes without sending input to the front window", async () => {
    const engine = process.env.OPENSTEER_COMPUTER_ENGINE ?? "claude";
    const accessMode = ThreadAccessModeSchema.parse(
      process.env.OPENSTEER_COMPUTER_ACCESS_MODE ?? "full-access",
    );
    const directory = path.resolve(
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ?? path.join(tmpdir(), "opensteer-computer-engine"),
    );
    const checkout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const relative = path.relative(checkout, directory);
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      throw new Error("Computer engine evidence must be outside the checkout");
    const fixture = scriptedNotes();
    const evidence: Record<string, unknown> = {
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
      engine,
      accessMode,
      prompt,
      helperRequests: [],
      transcriptExcerpt: [],
      outcome: "failed",
      replay: `OPENSTEER_COMPUTER_ENGINE=${engine} OPENSTEER_COMPUTER_ACCESS_MODE=${accessMode} pnpm test:engines -- tests/computer-use.engine.test.ts`,
    };
    let stack: VerticalStack | undefined;
    let desktop: Awaited<ReturnType<typeof startFakeDesktop>> | undefined;
    let scratch: string | undefined;
    let runId: RunId | undefined;
    try {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl) throw new Error("Run through pnpm test:engines");
      const sourceId = sourceIds[engine];
      if (!sourceId) throw new Error(`Unsupported computer engine: ${engine}`);
      scratch = await mkdtemp(path.join(tmpdir(), "opensteer-computer-engine-"));
      desktop = await startFakeDesktop(fixture.answer, { computerUseVersion: 2 });
      evidence.helperRequests = desktop.requests;
      const bridge = desktop;
      const dataDirectory = scratch;
      stack = await startVerticalStack({
        databaseUrl,
        catalogTimeoutMs: 180_000,
        runTimeoutMs: 600_000,
        harnessInstance: { config: {}, driverKind: engine, sourceId, stateKind: "ambient" },
        harnesses: createHarnessRegistry(
          parseAgentExecutionConfig(process.env).harnessExecutables,
          {
            nodeExecutable: process.execPath,
            runtimeCacheDirectory: path.join(tmpdir(), "opensteer-test-runtime-cache"),
          },
        ),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        personal: {
          integrations: () => {
            const prepared = prepareIntegrationsModule({
              computerUseBridge: bridge,
              dataDirectory,
              platform: "darwin",
            });
            if (!prepared) throw new Error("No scripted Mac integrations module");
            return prepared;
          },
        },
      });
      evidence.catalog = stack.catalog;
      const machines = await stack.api["machines.list"]({});
      if (!machines.ok) throw new Error(machines.error.message);
      const mac = machines.data.machines.find((machine) => machine.ownership === "deployment");
      if (!mac) throw new Error("Personal Main Mac was not listed");
      const registered = await stack.api["commands.dispatch"]({
        type: "integration.computer.approval-key.set",
        idempotencyKey: randomUUID(),
        input: { runnerId: mac.id, publicKey: fixture.publicKey },
      });
      if (!registered.ok) throw new Error(registered.error.message);
      const requested = await stack.api["commands.dispatch"]({
        type: "integration.computer.setup.request",
        idempotencyKey: randomUUID(),
        input: {
          kind: "app",
          runnerId: mac.id,
          app: notes,
          definitionId: "macos-app",
          access: "read-write",
        },
      });
      if (!requested.ok) throw new Error(requested.error.message);
      if (requested.data.type !== "integration.computer.setup.request")
        throw new Error("Expected Notes approval request");
      const request = requested.data.request;
      const approval = await desktop.answer(request.id, {
        kind: "allow",
        approval: fixture.approve(request),
      });
      expect(approval.kind).toBe("allowed");
      const model = stack.catalog.models.find((candidate) => candidate.isDefault);
      if (!model) throw new Error("The signed-in engine has no default model");
      evidence.model = model;
      const threadId = await stack.createThread({
        title: "Save a recipe in Notes",
        workspaceId: stack.mainWorkspaceId,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          providerId: model.providerId,
          options: {},
        }),
      });
      await stack.updateThreadAccess(threadId, accessMode);
      evidence.threadId = threadId;
      const turn = await stack.sendMessage({
        text: prompt,
        threadId,
        workspaceId: stack.mainWorkspaceId,
        onQueued: async (id) => {
          runId = id;
          evidence.runId = id;
        },
      });
      evidence.assistantText = turn.assistantText;
      const run = await stack.host.store.database
        .selectFrom("runs")
        .select(["status", "accessMode"])
        .where("id", "=", turn.runId)
        .executeTakeFirstOrThrow();
      evidence.run = run;
      expect(run).toMatchObject({ status: "completed", accessMode });
      assertHelperJourney(desktop.requests, fixture);
      const transcript = await readTranscript(stack, turn.runId);
      evidence.transcriptExcerpt = transcript;
      const starts = transcript
        .map((row) => ({ row, event: AgentEventViewSchema.parse(row) }))
        .filter(({ event }) => event.type === "tool.started");
      const outer = starts.filter(
        ({ event }) =>
          event.type === "tool.started" && /(?:^|__)computer$/u.test(event.data.tool.name),
      );
      expect(outer.length, "real engine invoked the outer computer MCP tool").toBeGreaterThan(0);
      expect(
        starts.filter(
          ({ event }) =>
            event.type === "tool.started" && event.data.tool.name.endsWith("integration_call"),
        ),
        "no legacy computer integration calls",
      ).toEqual([]);
      const operations = starts.filter(
        ({ event }) =>
          event.type === "tool.started" && event.data.tool.name.startsWith("computer."),
      );
      for (const operation of ["windows", "bind", "observe"]) {
        expect(
          operations.some(
            ({ event }) =>
              event.type === "tool.started" && event.data.tool.name === `computer.${operation}`,
          ),
          `Host recorded computer.${operation}`,
        ).toBe(true);
      }
      // act() may batch the same required inputs; the helper assertions below
      // still require the exact Title edit and Save press in Recipes.
      for (const operation of ["type", "click"]) {
        expect(
          operations.some(
            ({ event }) =>
              event.type === "tool.started" &&
              ["computer.act", `computer.${operation}`].includes(event.data.tool.name),
          ),
          `Host recorded ${operation} input`,
        ).toBe(true);
      }
      for (const { row, event } of operations) {
        if (event.type !== "tool.started") continue;
        expect(row, "computer operation was authored by the Host").toMatchObject({
          runnerId: null,
          runnerOrdinal: null,
          runnerBindingGeneration: null,
        });
        expect(event.data.integration?.computerApp).toMatchObject({
          app: "Notes",
          bundleId: notes.bundleId,
          runnerId: mac.id,
        });
      }
      for (const { event } of [...outer, ...operations]) {
        if (event.type !== "tool.started") continue;
        const completed = transcript
          .map((row) => AgentEventViewSchema.parse(row))
          .filter(
            (candidate) =>
              candidate.type === "tool.completed" && candidate.data.callId === event.data.callId,
          );
        expect(completed, `completed transcript pair for ${event.data.tool.name}`).toHaveLength(1);
        expect(completed[0]).toMatchObject({ data: { isError: false } });
      }
      evidence.outcome = "passed";
    } catch (error) {
      evidence.failure = error instanceof Error ? error.stack : String(error);
      if (/authentication-required/u.test(String(error)))
        evidence.blocked = `${engine} is not signed in on this Mac`;
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      if (stack && runId) {
        try {
          evidence.transcriptExcerpt = await readTranscript(stack, runId);
        } catch (error) {
          cleanupErrors.push(`transcript: ${String(error)}`);
        }
      }
      evidence.fixture = fixture.state();
      for (const [label, close] of [
        ["deployment", () => stack?.close()],
        ["desktop bridge", () => desktop?.close()],
        ["scratch", () => (scratch ? rm(scratch, { recursive: true, force: true }) : undefined)],
      ] as const) {
        try {
          await close();
        } catch (error) {
          cleanupErrors.push(`${label}: ${String(error)}`);
        }
      }
      evidence.cleanupErrors = cleanupErrors;
      if (cleanupErrors.length) evidence.outcome = "failed";
      await mkdir(directory, { recursive: true });
      const artifact = path.join(
        directory,
        `computer-use-${engine}-${accessMode}-${Date.now()}.json`,
      );
      await writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
      process.stdout.write(`computer engine evidence: ${artifact}\n`);
      expect(cleanupErrors, "every owned resource was stopped").toEqual([]);
    }
  });
});

async function readTranscript(stack: VerticalStack, runId: RunId) {
  return (
    await stack.host.store.database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", runId)
      .orderBy("sequence")
      .execute()
  ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

function scriptedNotes() {
  const key = generateKeyPairSync("ed25519");
  const documents = [
    { id: 71, title: "Shopping list", field: 1, save: 2, value: "Weekly groceries", saved: false },
    { id: recipesId, title: "Recipes", field: 3, save: 4, value: "", saved: false },
    { id: 99, title: "Archive", field: 5, save: 6, value: "Old notes", saved: false },
  ];
  const snapshots = new Map<string, string>();
  const current = new Map<string, number>();
  const focused = new Map<string, number>();
  let serial = 0;
  const violations: string[] = [];
  const windows = (session: string): WindowInfo[] =>
    documents.map((document) => ({
      id: document.id,
      title: document.title,
      ref: `${session}:${document.id}`,
      focused: document.id === 71,
      main: document.id === 71,
      minimized: false,
      onScreen: true,
      modal: false,
      current: document.id === (current.get(session) ?? 71),
      frame: { x: 0, y: 0, width: 800, height: 600 },
    }));
  return {
    publicKey: key.publicKey.export({ format: "pem", type: "spki" }).toString(),
    approve: (request: Parameters<typeof createComputerAppApproval>[1]) =>
      createComputerAppApproval(key.privateKey, request),
    state: () => ({ documents, violations }),
    answer(frame: ComputerUseBridgeRequest) {
      if (frame.method === "approvals.key-challenge") {
        const challenge = computerUseBridgeApprovalParams["approvals.key-challenge"].parse(
          frame.params,
        );
        return {
          result: {
            challengeId: challenge.challengeId,
            signature: signComputerAppApprovalKeyChallenge(key.privateKey, challenge),
          },
        };
      }
      const request = helperRequest(frame);
      if (!request) return undefined;
      const fail = (message: string) => {
        violations.push(message);
        return { error: { code: "stale-observation", message } };
      };
      switch (request.method) {
        case "apps.installed":
          return { result: { apps: [{ identity: notes, running: true }], total: 1 } };
        case "app.resolve":
          return {
            result: {
              app: {
                identity: notes,
                path: "/System/Applications/Notes.app",
                risk: "standard",
                allowed: true,
                reason: null,
                running: true,
              },
            },
          };
        case "session.open":
          return { result: { sessionId: request.params.sessionId } };
        case "session.close":
          return { result: {} };
        case "session.windows":
          return { result: { windows: windows(request.params.sessionId) } };
        case "session.bind": {
          const window = windows(request.params.sessionId).find(
            (window) =>
              window.id === (request.params.window ?? current.get(request.params.sessionId) ?? 71),
          );
          if (!window) return fail("That window is closed.");
          current.set(request.params.sessionId, window.id);
          return { result: { window: { ...window, current: true } } };
        }
        case "session.observe": {
          const window = windows(request.params.sessionId).find(
            (window) => window.ref === request.params.window,
          );
          const document = documents.find((document) => document.id === window?.id);
          if (!window || !document) return fail("That window is closed.");
          const snapshot = `snapshot-${++serial}`;
          snapshots.set(window.ref, snapshot);
          const fieldTitle = document.id === recipesId ? "Title" : `${document.title} title`;
          const buttonTitle = document.id === recipesId ? "Save" : `Save ${document.title}`;
          const tree = [
            `[0] window "${document.title}" (0,0 800×600)`,
            ...Array.from(
              { length: document.field - 1 },
              (_, index) =>
                `  [${index + 1}] button "${document.title} action ${index + 1}" (10,${index * 30} 100×20)`,
            ),
            `  [${document.field}] textField "${fieldTitle}" value=${JSON.stringify(document.value)} (150,50 400×30)`,
            `  [${document.save}] button "${buttonTitle}" (150,100 100×30)`,
          ].join("\n");
          const observation: ComputerUseObservation = {
            app: notes,
            capturedAt: new Date().toISOString(),
            elementCount: document.save + 1,
            focusChanged: false,
            geometry: { width: 800, height: 600 },
            snapshot,
            windows: windows(request.params.sessionId),
            blockedBy: [],
            alone: false,
            screenshot: null,
            tree,
            truncated: false,
            window: {
              ref: window.ref,
              id: window.id,
              title: window.title,
              frame: window.frame,
              scale: 1,
            },
          };
          return { result: { observation } };
        }
        case "session.act": {
          const window = windows(request.params.sessionId).find(
            (window) => window.ref === request.params.window,
          );
          const document = documents.find((document) => document.id === window?.id);
          if (!window || !document) return fail("That window is closed.");
          const performed: string[] = [];
          for (const action of request.params.actions) {
            if (
              ("target" in action || action.type === "setValue") &&
              (!request.params.snapshot || request.params.snapshot !== snapshots.get(window.ref))
            )
              return fail("Observe this window first.");
            if (action.type === "type" && typeof action.text === "string") {
              const index =
                action.target && "index" in action.target
                  ? action.target.index
                  : focused.get(window.ref);
              if (index !== document.field)
                return fail("Typing did not target this window's Title field.");
              document.value += action.text;
              performed.push(`Typed "${action.text}" into "Title"`);
            } else if (action.type === "click" && "index" in action.target) {
              if (action.target.index === document.field) focused.set(window.ref, document.field);
              else if (action.target.index === document.save) document.saved = true;
              else return fail("Clicked an unrelated element.");
              performed.push(
                action.target.index === document.save ? 'Clicked "Save"' : 'Clicked "Title"',
              );
            } else return fail(`Unexpected input: ${action.type}`);
          }
          current.set(request.params.sessionId, window.id);
          return { result: { performed, error: null } };
        }
        default:
          return undefined;
      }
    },
  };
}

function assertHelperJourney(
  frames: readonly ComputerUseBridgeRequest[],
  fixture: ReturnType<typeof scriptedNotes>,
) {
  const requests = frames.flatMap((frame) => {
    const parsed = helperRequest(frame);
    return parsed ? [parsed] : [];
  });
  const listed = requests.findIndex((request) => request.method === "session.windows");
  const bound = requests.findIndex(
    (request) => request.method === "session.bind" && request.params.window === recipesId,
  );
  expect(listed, "agent listed Notes windows").toBeGreaterThanOrEqual(0);
  expect(bound, "agent explicitly bound Recipes after listing windows").toBeGreaterThan(listed);
  const observed = new Set<string>();
  let typed = false;
  let saved = false;
  for (const [index, request] of requests.entries()) {
    if (request.method === "session.observe") observed.add(request.params.window);
    if (request.method !== "session.act") continue;
    expect(request.params.app.identity, "input targets the approved Notes app").toEqual(notes);
    expect(index, "binding preceded input").toBeGreaterThan(bound);
    expect(request.params.window, "no input to Shopping list or Archive").toBe(
      `${request.params.sessionId}:${recipesId}`,
    );
    expect(observed.has(request.params.window), "observe before index-targeted input").toBe(true);
    for (const action of request.params.actions) {
      if (action.type === "type" && action.text === "Lemon tart") typed = true;
      if (action.type === "click" && "index" in action.target && action.target.index === 4) {
        expect(typed, "Title filled before Save").toBe(true);
        saved = true;
      }
    }
  }
  expect(typed, "typed Lemon tart").toBe(true);
  expect(saved, "pressed Recipes Save").toBe(true);
  expect(fixture.state()).toEqual({
    documents: [
      {
        id: 71,
        title: "Shopping list",
        field: 1,
        save: 2,
        value: "Weekly groceries",
        saved: false,
      },
      { id: recipesId, title: "Recipes", field: 3, save: 4, value: "Lemon tart", saved: true },
      { id: 99, title: "Archive", field: 5, save: 6, value: "Old notes", saved: false },
    ],
    violations: [],
  });
}

function helperRequest(frame: ComputerUseBridgeRequest) {
  const { kind: _kind, ...request } = frame;
  const parsed = ComputerUseHelperRequestSchema.safeParse(request);
  return parsed.success ? parsed.data : undefined;
}
