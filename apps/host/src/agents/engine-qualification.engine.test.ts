import { randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  RequestPresentationSchema,
  harnessCatalog,
  provisionalThreadTitle,
  defaultTaskSymbol,
  requestOptionDeclines,
  shipsHarnessRuntimeBytes,
  taskSymbolNames,
  type Attachment,
  type HarnessKind,
  type ModelSelection,
  type ThreadAccessMode,
  type WorkspaceId,
} from "@opensteer/core";
import { findExecutableOnPath, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createHarnessRegistry, parseAgentExecutionConfig } from "@opensteer/runner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  attachmentReference,
  startVerticalStack,
  type VerticalStack,
} from "./vertical-stack.test-support.js";
import {
  installedCommand,
  qualificationAccount,
  qualifiedVersion,
  shippedEnginesFirstOnPath,
  type QualifiedEngine,
} from "./engine-qualification.test-support.js";

/*
 * Qualifies every engine in the catalog through a whole deployment: the Host
 * admits a model the engine itself listed, dispatches a Run, and the Runner
 * drives the real engine against the Host's real tool servers. Each engine
 * answers, continues its own conversation, and takes an option value from its
 * own catalog.
 *
 * Nothing here is scripted, so it runs only on demand (`pnpm test:engines`),
 * against the accounts the machine's engines are already signed in to. An
 * engine bump is not qualified until this passes for every catalog engine.
 *
 * An account on the machine's own sign-in runs the person's own CLI for an
 * engine that declares one, so each such engine is qualified twice: `shipped`
 * puts the engine this tree ships first on PATH, `installed` runs the CLI this
 * computer actually has, and `downloaded` lets the driver prepare its pinned
 * release in the Runner's temporary runtime cache.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
let runtimeCacheDirectory: string | undefined;

beforeAll(async () => {
  runtimeCacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-engine-runtime-"));
});

afterAll(async () => {
  if (runtimeCacheDirectory) await rm(runtimeCacheDirectory, { force: true, recursive: true });
  runtimeCacheDirectory = undefined;
});

/**
 * Each engine is qualified on a first-party source. Given the source's key
 * in this process's environment, a private account is signed in with it
 * through the setup commands Settings sends — a Runner never hands its own
 * environment's keys to an engine. Without one, the account is the engine's
 * own sign-in on this machine (`CODEX_HOME`, Claude Code's login, Pi's home).
 * Antigravity uses a private Gemini API-key account because its profile is
 * isolated and the test Runner is disposable. OpenCode's Zen gateway serves
 * free models with no credential at all.
 */
type QualificationAccount = Omit<QualifiedEngine, "executable" | "label">;

const qualificationAccounts = {
  antigravity: {
    apiKey: { methodId: "gemini-api-key", variable: "GEMINI_API_KEY" },
    driverKind: "antigravity",
    signInGuidance: "Set GEMINI_API_KEY to a dedicated spending-limited Gemini API key.",
    sourceId: "google-gemini-api-key",
    stateKind: "isolated",
  },
  claude: {
    apiKey: { methodId: "claude-api-key", variable: "ANTHROPIC_API_KEY" },
    driverKind: "claude",
    sourceId: "anthropic",
    stateKind: "ambient",
  },
  codex: {
    apiKey: { methodId: "codex-api-key", variable: "OPENAI_API_KEY" },
    driverKind: "codex",
    sourceId: "openai",
    stateKind: "ambient",
  },
  cursor: {
    driverKind: "cursor",
    sourceId: "cursor",
    stateKind: "ambient",
  },
  grok: {
    driverKind: "grok",
    signInGuidance: "Sign in with `grok login --device-auth`.",
    sourceId: "xai",
    stateKind: "ambient",
  },
  muse: {
    driverKind: "muse",
    signInGuidance: "Sign in with `muse login`.",
    sourceId: "meta",
    stateKind: "ambient",
  },
  opencode: { driverKind: "opencode", sourceId: "opencode", stateKind: "isolated" },
  pi: {
    apiKey: { methodId: "pi-api-key", variable: "OPENAI_API_KEY" },
    driverKind: "pi",
    sourceId: "openai",
    stateKind: "ambient",
  },
} as const satisfies Record<HarnessKind, QualificationAccount>;

const qualifiedEngines: readonly QualifiedEngine[] = harnessCatalog.flatMap((entry) => {
  const account = qualificationAccounts[entry.kind];
  const engines: QualifiedEngine[] = [];
  if (shipsHarnessRuntimeBytes(entry)) {
    engines.push({ ...account, executable: "shipped", label: `shipped ${entry.label}` });
  }
  if (entry.runtime.shape === "downloaded") {
    engines.push({ ...account, executable: "downloaded", label: `downloaded ${entry.label}` });
  }
  if (installedCommand(entry.kind)) {
    engines.push({ ...account, executable: "installed", label: `installed ${entry.label}` });
  }
  return engines;
});

const newEngineKinds = new Set<HarnessKind>(["antigravity", "grok", "muse"]);
const expectedAccessModes = {
  antigravity: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  grok: ["approval-required", "auto", "full-access"],
  muse: ["approval-required", "full-access"],
} as const satisfies Partial<Record<HarnessKind, readonly ThreadAccessMode[]>>;

describe("engine qualification", () => {
  it("derives every runtime qualification from the complete engine catalog", () => {
    expect(Object.keys(qualificationAccounts).toSorted()).toEqual(
      harnessCatalog.map((entry) => entry.kind).toSorted(),
    );
    expect(qualifiedEngines.map((engine) => engine.label)).toEqual(
      harnessCatalog.flatMap((entry) => [
        ...(shipsHarnessRuntimeBytes(entry) ? [`shipped ${entry.label}`] : []),
        ...(entry.runtime.shape === "downloaded" ? [`downloaded ${entry.label}`] : []),
        ...(installedCommand(entry.kind) ? [`installed ${entry.label}`] : []),
      ]),
    );
  });

  it("qualifies the access modes each new engine declares", async () => {
    const harnesses = createHarnessRegistry(
      parseAgentExecutionConfig(process.env).harnessExecutables,
      {
        nodeExecutable: process.execPath,
        runtimeCacheDirectory: join(tmpdir(), "opensteer-unused-runtime-cache"),
      },
    );
    try {
      for (const [kind, modes] of Object.entries(expectedAccessModes)) {
        expect(harnesses.driverAccessModes(HarnessIdSchema.parse(kind))).toEqual(modes);
      }
    } finally {
      await harnesses.close();
    }
  });

  describe.each(qualifiedEngines)("$label", (engine) => {
    let stack: VerticalStack | undefined;
    let restorePath: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      if (engine.executable === "shipped") restorePath = await shippedEnginesFirstOnPath();
    });

    afterEach(async () => {
      await stack?.close();
      stack = undefined;
      await restorePath?.();
      restorePath = undefined;
    }, 60_000);

    it("contributes the person's Chat follow-ups to the reply under way", async () => {
      if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
      const command = installedCommand(engine.driverKind);
      if (
        engine.executable === "installed" &&
        command &&
        !findExecutableOnPath(command, process.env.PATH)
      ) {
        throw new Error(`Install ${command} on this computer to qualify ${engine.label}.`);
      }
      const harnesses = createHarnessRegistry(
        parseAgentExecutionConfig(process.env).harnessExecutables,
        {
          nodeExecutable: process.execPath,
          runtimeCacheDirectory: runtimeCacheDirectory!,
        },
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 180_000,
        databaseUrl,
        harnessInstance: qualificationAccount(engine),
        harnesses,
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 300_000,
      }).catch((error: unknown) => {
        throw qualificationFailure(engine, error);
      });
      const active = stack;
      const native =
        harnesses.driverCapabilities(HarnessIdSchema.parse(engine.driverKind))?.steering === true;
      const model = active.catalog.models.find((candidate) => candidate.isDefault)!;
      const workspaceId = active.mainWorkspaceId;
      const threadId = await active.createThread({
        home: true,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
        title: "Chat",
        workspaceId,
      });
      const database = active.host.store.database;
      const input = (messageId: string) =>
        database
          .selectFrom("threadInputs")
          .select(["cancelReason", "runId", "state"])
          .where("messageId", "=", messageId as never)
          .executeTakeFirstOrThrow();
      const replies = async (runId: string) =>
        (
          await database
            .selectFrom("messages")
            .select(["content", "sequence"])
            .where("runId", "=", runId as never)
            .where("kind", "=", "assistant")
            .orderBy("sequence", "asc")
            .execute()
        ).map(({ content, sequence }) => ({
          sequence: String(sequence),
          text: (content as readonly { readonly text?: string }[])
            .flatMap((part) => (part.text ? [part.text] : []))
            .join("\n"),
        }));
      const attempts = async (runId: string) => {
        const listed = await active.api["run.attempts.list"]({ runId: runId as never });
        if (!listed.ok) throw new Error(listed.error.message);
        return listed.data.attempts.map((attempt) => [attempt.reason, attempt.outcome]);
      };
      const runCount = async () =>
        (await database.selectFrom("runs").select("id").where("threadId", "=", threadId).execute())
          .length;

      // An additive follow-up while the engine waits on a tool reaches the
      // same reply, which then honours both the request and the follow-up.
      const original = `ALPHA-${randomInt(1_000, 9_999)}`;
      const added = `BRAVO-${randomInt(1_000, 9_999)}`;
      let followUpId = "";
      const midTurn = await active.sendMessage({
        onQueued: async (runId) => {
          await active.waitForToolStart(runId);
          const followUp = await active.queueMessage({
            text: `Also put this second code in that same final reply: ${added}`,
            threadId,
          });
          expect(followUp.runId).toBe(runId);
          followUpId = followUp.messageId;
        },
        text: `Use your shell tool to run exactly \`sleep 15\` and wait for it to finish. Then reply with the code ${original}.`,
        threadId,
        workspaceId,
      });
      expect(midTurn.assistantText).toContain(original);
      expect(midTurn.assistantText).toContain(added);
      expect(await input(followUpId)).toMatchObject({ runId: midTurn.runId, state: "delivered" });
      const midTurnAttempts = await attempts(midTurn.runId);
      expect(midTurnAttempts).toEqual(
        native
          ? [["initial", "completed"]]
          : [
              ["initial", "interrupted"],
              ["steer_restart", "completed"],
            ],
      );
      expect(await runCount()).toBe(1);
      console.info(
        `${engine.label}: mid-turn follow-up joined the reply (${native ? "native" : "restart"})`,
      );

      // A follow-up landing as the engine starts or finishes its answer is
      // answered once: in this Run, as a turn of its own if it came late, or
      // by the next Run when the engine provably refused it. Never accepted
      // and then left unanswered.
      const lateWord = `DELTA-${randomInt(1_000, 9_999)}`;
      let lateId = "";
      const late = await active.sendMessage({
        onQueued: async (runId) => {
          await waitForRunStatus(active, runId, "running");
          const followUp = await active.queueMessage({
            text: `Also reply with the word ${lateWord}.`,
            threadId,
          });
          lateId = followUp.messageId;
        },
        text: "Reply with exactly the word GAMMA.",
        threadId,
        workspaceId,
      });
      const lateInput = await input(lateId);
      let lateAnsweredBy = late.runId;
      if (lateInput.runId === late.runId) {
        expect(lateInput.state).toBe("delivered");
        expect(late.assistantText).toContain(lateWord);
      } else {
        // Refused before it reached the engine: it starts the next reply.
        expect(lateInput.state).not.toBe("unknown");
        const next = await database
          .selectFrom("runs")
          .select("id")
          .where("seedInputId", "=", lateId as never)
          .executeTakeFirstOrThrow();
        lateAnsweredBy = next.id;
        await waitForRunStatus(active, lateAnsweredBy, "completed");
        expect((await replies(lateAnsweredBy)).map(({ text }) => text).join("\n")).toContain(
          lateWord,
        );
      }
      const lateReplies = await replies(late.runId);

      // A follow-up written while the engine streams its final answer, with no
      // tool round left to fold it into: it is answered in this Run, by the
      // same turn or one of its own after the first answer.
      const finalWord = `OMEGA-${randomInt(1_000, 9_999)}`;
      let midAnswerId = "";
      const midAnswer = await active.sendMessage({
        onQueued: async (runId) => {
          await waitForRunStatus(active, runId, "running");
          await waitForAssistantText(active, runId);
          const followUp = await active.queueMessage({
            text: `After that, end with one more line containing only ${finalWord}.`,
            threadId,
          });
          midAnswerId = followUp.messageId;
        },
        text: "Without using any tools, write a numbered list of 40 short facts about the ocean.",
        threadId,
        workspaceId,
      });
      const midAnswerInput = await input(midAnswerId);
      const midAnswerReplies = await replies(midAnswer.runId);
      let midAnswerAnsweredBy = midAnswer.runId;
      if (midAnswerInput.runId === midAnswer.runId) {
        expect(midAnswerInput.state).toBe("delivered");
        expect(midAnswerReplies.at(-1)?.text).toContain(finalWord);
      } else {
        expect(midAnswerInput.state).not.toBe("unknown");
        const next = await database
          .selectFrom("runs")
          .select("id")
          .where("seedInputId", "=", midAnswerId as never)
          .executeTakeFirstOrThrow();
        midAnswerAnsweredBy = next.id;
        await waitForRunStatus(active, midAnswerAnsweredBy, "completed");
        expect((await replies(midAnswerAnsweredBy)).at(-1)?.text).toContain(finalWord);
      }

      // Messages sent before the engine can start are its first turn.
      const burstRunsBefore = await runCount();
      const first = await active.queueMessage({ text: "Remember the word ECHO.", threadId });
      const second = await active.queueMessage({
        text: "Then reply with the remembered word followed by FOXTROT.",
        threadId,
      });
      if (!first.runId) throw new Error("The burst did not start a reply");
      await waitForRunStatus(active, first.runId, "completed");
      expect(await input(second.messageId)).toMatchObject({
        runId: first.runId,
        state: "delivered",
      });
      const burstReplies = await replies(first.runId);
      expect(burstReplies.map(({ text }) => text).join("\n")).toMatch(
        /ECHO[\s\S]*FOXTROT|FOXTROT[\s\S]*ECHO/u,
      );
      expect(await runCount()).toBe(burstRunsBefore + 1);

      // Stop ends the reply; the next message is answered without a Resume.
      const stopped = await active.sendMessage({
        onQueued: async (runId) => {
          await active.waitForToolStart(runId);
          await active.interruptRun(threadId, runId);
        },
        text: "Use your shell tool to run exactly `sleep 60` and wait for it to finish.",
        threadId,
        workspaceId,
      });
      const afterStop = await active.queueMessage({ text: "Reply with exactly HOTEL.", threadId });
      if (!afterStop.runId) throw new Error("The next message waited for a Resume");
      await waitForRunStatus(active, afterStop.runId, "completed");
      expect((await replies(afterStop.runId)).at(-1)?.text).toMatch(/HOTEL/u);
      const paused = await database
        .selectFrom("threads")
        .select("inputQueuePaused")
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      expect(paused.inputQueuePaused).toBe(false);

      const evidenceRoot =
        process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
        join(tmpdir(), "opensteer-engine-evidence", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, `conversation-${engine.driverKind}-${engine.executable}.json`),
        JSON.stringify(
          {
            engine: engine.driverKind,
            executable: engine.executable,
            engineVersion: await qualifiedVersion(engine),
            steering: native ? "native" : "restart",
            midTurn: {
              attempts: midTurnAttempts,
              followUp: await input(followUpId),
              reply: midTurn.assistantText,
              runId: midTurn.runId,
            },
            midAnswerFollowUp: {
              answeredBy: midAnswerAnsweredBy,
              input: midAnswerInput,
              replies: midAnswerReplies.map(({ sequence, text }) => ({
                sequence,
                text: text.slice(-120),
              })),
              runEvents: midAnswer.events
                .filter(
                  (event) => event.type.startsWith("run.") || event.type === "message.injected",
                )
                .map((event) =>
                  event.type === "run.phase"
                    ? `run.phase:${String((event.data as { phase?: unknown }).phase)}`
                    : event.type,
                ),
              runId: midAnswer.runId,
            },
            lateFollowUp: {
              answeredBy: lateAnsweredBy,
              input: lateInput,
              replies: lateReplies,
              runEvents: late.events.map((event) => event.type),
              runId: late.runId,
            },
            burst: {
              inputs: [await input(first.messageId), await input(second.messageId)],
              replies: burstReplies,
              runId: first.runId,
            },
            stop: {
              nextRunId: afterStop.runId,
              queuePaused: paused.inputQueuePaused,
              stoppedEvents: stopped.events.map((event) => event.type),
              stoppedRunId: stopped.runId,
            },
          },
          null,
          2,
        ),
      );
      console.info(`Conversation delivery evidence: ${evidenceRoot}`);
    }, 900_000);

    it("answers, continues, and takes a listed option through a whole deployment", async () => {
      if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
      const command = installedCommand(engine.driverKind);
      if (
        engine.executable === "installed" &&
        command &&
        !findExecutableOnPath(command, process.env.PATH)
      ) {
        throw new Error(`Install ${command} on this computer to qualify ${engine.label}.`);
      }
      const harnesses = createHarnessRegistry(
        parseAgentExecutionConfig(process.env).harnessExecutables,
        {
          nodeExecutable: process.execPath,
          runtimeCacheDirectory: runtimeCacheDirectory!,
        },
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 180_000,
        databaseUrl,
        harnessInstance: qualificationAccount(engine),
        harnesses,
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 300_000,
      }).catch((error: unknown) => {
        throw qualificationFailure(engine, error);
      });

      // The engine names its own default; nothing in Opensteer picks one.
      const defaults = stack.catalog.models.filter((model) => model.isDefault);
      expect(defaults).toHaveLength(1);
      const model = defaults[0]!;
      if (newEngineKinds.has(engine.driverKind)) {
        expect(model.options).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "effort", type: "select" })]),
        );
      }
      const workspace = await stack.createWorkspace(`${engine.label} qualification`);
      const threadId = await stack.createThread({
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
        title: `${engine.label} qualification`,
        workspaceId: workspace.id,
      });

      const remembered = randomUUID();
      const first = await stack.sendMessage({
        text: `Remember this code for later: ${remembered}. Reply with exactly the word READY and nothing else.`,
        threadId,
        workspaceId: workspace.id,
      });
      expect(first.assistantText).toMatch(/\bREADY\b/iu);
      if (newEngineKinds.has(engine.driverKind)) {
        const eventTypes = first.events.map((event) => event.type);
        expect(eventTypes).toContain("assistant.message");
        expect(eventTypes).toContain("run.usage");
        expect(eventTypes.indexOf("assistant.message")).toBeLessThan(
          eventTypes.indexOf("run.completed"),
        );
        expect(eventTypes.indexOf("run.usage")).toBeLessThan(eventTypes.indexOf("run.completed"));
        const listed = await stack.api["run.attempts.list"]({ runId: first.runId });
        if (!listed.ok) throw new Error(listed.error.message);
        const usage = listed.data.attempts.at(-1)?.usage;
        expect(usage?.outputTokens).toBeGreaterThan(0);
        expect((usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0)).toBeGreaterThan(0);
      }

      // Choose a non-default value for each option that offers one. An option
      // with only one listed value stays there. The Host admits those choices,
      // dispatch re-checks them, and the engine must accept them.
      const listedOptions = Object.fromEntries(
        model.options.map((option) =>
          option.type === "toggle"
            ? [option.id, !option.defaultValue]
            : [
                option.id,
                (
                  option.values.find((choice) => choice.value !== option.defaultValue) ??
                  option.values[0]!
                ).value,
              ],
        ),
      );
      await stack.updateThreadExecution(
        threadId,
        ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: listedOptions,
          providerId: model.providerId,
        }),
      );
      const second = await stack.sendMessage({
        text: "Reply with only the code I asked you to remember.",
        threadId,
        workspaceId: workspace.id,
      });
      expect(second.assistantText).toContain(remembered);

      // Returning to defaults must also work on the continued conversation;
      // engines can retain an earlier Run's reasoning level or speed tier.
      await stack.updateThreadExecution(
        threadId,
        ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
      );
      const third = await stack.sendMessage({
        text: "Repeat the remembered code, with nothing else.",
        threadId,
        workspaceId: workspace.id,
      });
      expect(third.assistantText).toContain(remembered);

      // With nothing changed, the next Run is served by the engine the last
      // one left running, and the conversation carries on in it.
      const reused = await stack.sendMessage({
        text: "Reply with only the remembered code, once more.",
        threadId,
        workspaceId: workspace.id,
      });
      expect(reused.assistantText).toContain(remembered);
      // How each Run's engine started, and how long from dispatch until it
      // accepted the work: the part a warm engine saves.
      const engineStarts = [];
      for (const runId of [first.runId, second.runId, third.runId, reused.runId]) {
        const listed = await stack.api["run.attempts.list"]({ runId });
        if (!listed.ok) throw new Error(listed.error.message);
        const attempt = listed.data.attempts.at(-1)!;
        engineStarts.push({
          engineStart: attempt.engineStart,
          startupMs:
            attempt.dispatchedAt && attempt.startedAt
              ? Date.parse(attempt.startedAt) - Date.parse(attempt.dispatchedAt)
              : null,
        });
        // Codex states each response's tokens, on a fresh and a reused engine alike.
        if (engine.driverKind === "codex") {
          const usage = attempt.usage;
          expect(usage?.outputTokens).toBeGreaterThan(0);
          expect((usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0)).toBeGreaterThan(0);
          console.info(`${engine.label}: Run ${runId} usage ${JSON.stringify(usage)}`);
        }
      }
      const warmReuse =
        harnesses.driverCapabilities(HarnessIdSchema.parse(engine.driverKind))?.warmReuse === true;
      // A new conversation always starts its engine. The Runs between may
      // already be warm: a model with no options leaves their selections equal.
      expect(engineStarts[0]!.engineStart).toBe("cold");
      expect(engineStarts[3]!.engineStart).toBe(warmReuse ? "warm" : "cold");
      console.info(`${engine.label}: engine starts ${JSON.stringify(engineStarts)}`);

      // The nonce exists only in the uploaded file. A correct answer proves
      // the engine could read the Host original staged by the Runner.
      const fileNonce = randomUUID();
      const file = await stack.uploadAttachment({
        bytes: Buffer.from(`The qualification code is ${fileNonce}.\n`, "utf8"),
        mediaType: "text/plain",
        name: "qualification.txt",
        workspaceId: workspace.id,
      });
      const fileTurn = await stack.sendMessage({
        attachments: [attachmentReference(file)],
        text: "Read the attached text file and reply with only its qualification code.",
        threadId,
        workspaceId: workspace.id,
      });
      expect(fileTurn.assistantText).toContain(fileNonce);
      console.info(`${engine.label}: continued conversation read uploaded file`);

      // The engine's supervised mode must surface a real Opensteer Request
      // before an MCP shell call, then continue after a client answers it.
      const approvalThreadId = await stack.createThread({
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
        title: `${engine.label} approval qualification`,
        workspaceId: workspace.id,
      });
      await stack.updateThreadAccess(approvalThreadId, "approval-required");
      const approvalCode = randomUUID();
      let approvalRequestId = "";
      const approved = await stack.sendMessage({
        onQueued: async (runId) => {
          approvalRequestId = await approvePendingHarnessRequest(stack!, runId);
        },
        text: `Use the shell tool to run exactly \`printf '${approvalCode}'\`, then reply with only its output.`,
        threadId: approvalThreadId,
        workspaceId: workspace.id,
      });
      expect(approvalRequestId).not.toBe("");
      expect(approved.assistantText).toContain(approvalCode);
      expect(approved.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["tool.started", "tool.completed"]),
      );
      console.info(
        `${engine.label}: approved an MCP shell call through Request ${approvalRequestId}`,
      );

      // An engine's own subagents are the Run's execution nodes: their steps
      // name them, and their words are their result, not the Run's message.
      let subagentResult: { nodes: readonly unknown[]; response: string; runId: string } | null =
        null;
      if (["claude", "codex", "opencode"].includes(engine.driverKind)) {
        const code = randomUUID();
        const delegated = await stack.sendMessage({
          text: `Start exactly one subagent and have it run the shell command \`echo ${code}\` and report the output. Then reply with only that output.`,
          threadId,
          workspaceId: workspace.id,
        });
        expect(delegated.assistantText).toContain(code);
        const listed = await stack.api["run.attempts.list"]({ runId: delegated.runId });
        if (!listed.ok) throw new Error(listed.error.message);
        expect(listed.data.nodes.length).toBeGreaterThan(0);
        expect(
          listed.data.nodes.map((node) => ({ status: node.status, title: node.title })),
        ).toEqual(listed.data.nodes.map((node) => ({ status: "completed", title: node.title })));
        const childSteps = await stack.host.store.database
          .selectFrom("workspaceEvents")
          .select("data")
          .where("runId", "=", delegated.runId)
          .where("type", "=", "tool.started")
          .execute();
        expect(
          childSteps.some((step) => typeof (step.data as { nodeId?: unknown }).nodeId === "string"),
        ).toBe(true);
        // A Codex subagent's responses are its node's usage and the Run's too.
        if (engine.driverKind === "codex") {
          const usage = listed.data.attempts.at(-1)?.usage;
          const nodesOutput = listed.data.nodes.reduce(
            (sum, node) => sum + (node.usage?.outputTokens ?? 0),
            0,
          );
          expect(usage?.outputTokens).toBeGreaterThan(nodesOutput);
          console.info(
            `${engine.label}: delegated Run usage ${JSON.stringify(usage)}, nodes ${JSON.stringify(listed.data.nodes.map((node) => node.usage))}`,
          );
        }
        subagentResult = {
          nodes: listed.data.nodes,
          response: delegated.assistantText,
          runId: delegated.runId,
        };
        console.info(`${engine.label}: attributed a native subagent's steps to its node`);
      }

      // An engine that cannot take a message mid-turn restarts the Run with
      // it: the running attempt is interrupted and the next one, in the same
      // native conversation, starts with the steered message.
      let restartResult: { attempts: readonly unknown[]; response: string; runId: string } | null =
        null;
      if (
        harnesses.driverCapabilities(HarnessIdSchema.parse(engine.driverKind))?.steering !== true
      ) {
        const steeredCode = randomUUID();
        const active = stack;
        const restarted = await active.sendMessage({
          onQueued: async (runId) => {
            await active.waitForToolStart(runId);
            await active.steerMessage({
              text: `Stop waiting for that command. Reply with only this code: ${steeredCode}`,
              threadId,
            });
          },
          text: "Use your shell tool to run exactly `sleep 30` and wait for it to finish. Then reply with DONE.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(restarted.assistantText).toContain(steeredCode);
        const listed = await stack.api["run.attempts.list"]({ runId: restarted.runId });
        if (!listed.ok) throw new Error(listed.error.message);
        expect(listed.data.attempts.map((attempt) => [attempt.reason, attempt.outcome])).toEqual([
          ["initial", "interrupted"],
          ["steer_restart", "completed"],
        ]);
        restartResult = {
          attempts: listed.data.attempts,
          response: restarted.assistantText,
          runId: restarted.runId,
        };
        console.info(`${engine.label}: restarted a running turn with a steered message`);
      }

      // The engine and the selected model must both advertise image input.
      // The default can be text-only even when another listed model is capable.
      const imageModel = model.acceptsImages
        ? model
        : stack.catalog.models.find((candidate) => candidate.acceptsImages === true);
      let imageResult:
        | {
            modelId: string;
            photos: readonly PhotoEvidence[];
            runId: string;
            response: string;
          }
        | undefined;
      if (imageModel) {
        const pixels = Buffer.alloc(64 * 32 * 3);
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 64; x++) {
            const offset = (y * 64 + x) * 3;
            pixels[offset + (x < 32 ? 0 : 2)] = 255;
          }
        }
        const png = await sharp(pixels, { raw: { width: 64, height: 32, channels: 3 } })
          .png()
          .toBuffer();
        const image = await stack.uploadAttachment({
          bytes: png,
          mediaType: "image/png",
          name: "two-colors.png",
          workspaceId: workspace.id,
        });
        const imageThreadId = await stack.createThread({
          modelSelection: ModelSelectionSchema.parse({
            modelId: imageModel.modelId,
            options: {},
            providerId: imageModel.providerId,
          }),
          title: `${engine.label} image qualification`,
          workspaceId: workspace.id,
        });
        const imageTurn = await stack.sendMessage({
          attachments: [attachmentReference(image)],
          text: "What color is the LEFT half of the attached image? Reply with only RED or BLUE.",
          threadId: imageThreadId,
          workspaceId: workspace.id,
        });
        expect(imageTurn.assistantText.trim().split(/\r?\n/u).at(-1)).toMatch(/^RED[.!]?$/iu);
        console.info(`${engine.label}: catalog-confirmed model read native image`);
        const photos = await qualifyPhotos({
          label: engine.label,
          modelSelection: ModelSelectionSchema.parse({
            modelId: imageModel.modelId,
            options: {},
            providerId: imageModel.providerId,
          }),
          stack,
          steering:
            harnesses.driverCapabilities(HarnessIdSchema.parse(engine.driverKind))
              ?.messageAttachments?.nativeImages?.steering === true,
          workspaceId: workspace.id,
        });
        imageResult = {
          modelId: imageModel.modelId,
          photos,
          response: imageTurn.assistantText,
          runId: imageTurn.runId,
        };
      }

      // All Runs continued one native conversation.
      const sessions = await stack.host.store.database
        .selectFrom("providerSessions")
        .select(["providerSessionReference", "status"])
        .where("threadId", "=", threadId)
        .execute();
      expect(sessions).toEqual([{ providerSessionReference: expect.any(String), status: "ready" }]);

      const evidenceRoot =
        process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
        join(tmpdir(), "opensteer-engine-evidence", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, `${engine.driverKind}-${engine.executable}.json`),
        JSON.stringify(
          {
            engine: engine.driverKind,
            executable: engine.executable,
            engineVersion: await qualifiedVersion(engine),
            catalogModelIds: stack.catalog.models.map((listed) => listed.modelId),
            providerId: model.providerId,
            defaultModelId: model.modelId,
            continuationRunIds: [
              first.runId,
              second.runId,
              third.runId,
              reused.runId,
              fileTurn.runId,
            ],
            engineStarts,
            fileReadVerified: fileTurn.assistantText.includes(fileNonce),
            approval: {
              requestId: approvalRequestId,
              runId: approved.runId,
              toolEvents: approved.events
                .filter((event) => event.type.startsWith("tool."))
                .map((event) => event.type),
            },
            restartSteer: restartResult ?? { status: "The engine steers natively" },
            subagents: subagentResult ?? { status: "Not qualified for this engine" },
            image: imageResult ?? { status: "No catalog-confirmed image model" },
          },
          null,
          2,
        ),
      );
      console.info(`Engine qualification evidence: ${evidenceRoot}`);
    }, 900_000);
  });
});

describe.each(qualifiedEngines)("$label Thread names and symbols", (engine) => {
  let stack: VerticalStack | undefined;
  let restorePath: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stack?.close();
    await restorePath?.();
  }, 60_000);

  it("generates an isolated title and symbol and preserves personal choices on the next Run", async () => {
    const root =
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-engine-evidence", randomUUID());
    await mkdir(root, { recursive: true });
    const evidencePath = join(root, `thread-name-${engine.driverKind}-${engine.executable}.json`);
    const evidence: Record<string, unknown> = {
      engine: engine.driverKind,
      generatedTitle: null,
      generatedIcon: null,
      latencyMs: null,
    };
    try {
      if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
      if (engine.executable === "shipped") restorePath = await shippedEnginesFirstOnPath();
      const engineVersion = await qualifiedVersion(engine);
      evidence.engineVersion = engineVersion;
      stack = await startVerticalStack({
        catalogTimeoutMs: 180_000,
        databaseUrl,
        harnessInstance: qualificationAccount(engine),
        harnesses: createHarnessRegistry(
          parseAgentExecutionConfig(process.env).harnessExecutables,
          {
            nodeExecutable: process.execPath,
            runtimeCacheDirectory: runtimeCacheDirectory!,
          },
        ),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 120_000,
        runnerLogger: {
          info: (message, fields) => console.info(message, fields),
          error: (message, fields) => console.error(message, fields),
        },
      }).catch((error: unknown) => {
        throw qualificationFailure(engine, error);
      });
      const active = stack;
      // The name is under test, not the Run: a fast model keeps the Run short,
      // which also leaves naming the least time before the Run ends.
      const model =
        active.catalog.models.find((candidate) =>
          /luna|haiku|flash|lightning|nano/iu.test(candidate.modelId),
        ) ?? active.catalog.models.find((candidate) => candidate.isDefault)!;
      evidence.runModel = model.modelId;
      const firstLine = "I need a clear plan for moving our support team to a new help desk.";
      const message = `${firstLine}\nWe have eight support specialists, about 400 weekly tickets, and three years of customer history. We need to preserve ticket ownership and customer context, train the team, and move in stages without dropping replies. Focus on the migration risks, rollback, and how to measure whether the transition worked. For this initial check, do not use tools or start the work: reply only READY.`;
      const seed = provisionalThreadTitle(message);
      evidence.seed = seed;
      const threadId = await active.createThread({
        generateTitle: true,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          providerId: model.providerId,
          options: {},
        }),
        title: seed,
        workspaceId: active.mainWorkspaceId,
      });
      const started = Date.now();
      const first = await active.sendMessage({
        text: message,
        threadId,
        workspaceId: active.mainWorkspaceId,
      });
      const latencyMs = Date.now() - started;
      evidence.latencyMs = latencyMs;
      expect(first.assistantText).toMatch(/\bREADY\b/u);
      const stored = await active.host.store.database
        .selectFrom("threads")
        .select(["title", "icon"])
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      evidence.generatedTitle = stored.title;
      evidence.generatedIcon = stored.icon;
      const scratchEntries = (
        await readdir(active.runnerDataDirectory, { recursive: true })
      ).filter((name) => name.split(/[\\/]/u).some((part) => part.startsWith("title-")));
      evidence.scratchEntries = scratchEntries;
      expect(scratchEntries).toEqual([]);
      expect(stored.title).not.toBe(seed);
      expect(stored.title).not.toBe(firstLine);
      expect(stored.title.length).toBeGreaterThan(0);
      expect(stored.title.length).toBeLessThanOrEqual(80);
      expect(stored.title).not.toMatch(/[\r\n]/u);
      expect([...taskSymbolNames, defaultTaskSymbol]).toContain(stored.icon);
      expect(first.assistantText).not.toContain(stored.title);
      const transcript = await active.host.store.database
        .selectFrom("messages")
        .select("content")
        .where("threadId", "=", threadId)
        .execute();
      expect(JSON.stringify(transcript)).not.toContain("You name tasks in a person's task list");
      expect(JSON.stringify(transcript)).not.toContain(stored.title);
      const renamedTitle = "Support migration — chosen title";
      const renamed = await active.api["commands.dispatch"]({
        type: "thread.rename",
        threadId,
        title: renamedTitle,
        idempotencyKey: `rename-${randomUUID()}`,
      });
      if (!renamed.ok) throw new Error(renamed.error.message);
      const chosenIcon = stored.icon === "plane" ? "heart" : "plane";
      const iconSet = await active.api["commands.dispatch"]({
        type: "thread.icon.set",
        threadId,
        icon: chosenIcon,
        idempotencyKey: `icon-${randomUUID()}`,
      });
      if (!iconSet.ok) throw new Error(iconSet.error.message);
      const second = await active.sendMessage({
        text: "Keep the migration on hold. Reply only WAITING.",
        threadId,
        workspaceId: active.mainWorkspaceId,
      });
      expect(second.assistantText).toMatch(/\bWAITING\b/u);
      const afterSecond = await active.host.store.database
        .selectFrom("threads")
        .select(["title", "icon"])
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      expect(afterSecond.title).toBe(renamedTitle);
      expect(afterSecond.icon).toBe(chosenIcon);
      const attempts = await active.api["run.attempts.list"]({ runId: second.runId });
      if (!attempts.ok) throw new Error(attempts.error.message);
      if (engine.driverKind === "codex" || engine.driverKind === "opencode")
        expect(attempts.data.attempts.at(-1)?.engineStart).toBe("warm");
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            ...evidence,
            status: "passed",
            engine: engine.driverKind,
            engineVersion,
            seed,
            generatedTitle: stored.title,
            generatedIcon: stored.icon,
            chosenIcon,
            afterSecond,
            latencyMs,
            renamedTitle,
            runIds: [first.runId, second.runId],
            secondEngineStart: attempts.data.attempts.at(-1)?.engineStart,
            transcript,
          },
          null,
          2,
        ),
      );
      console.info(`Thread name evidence: ${evidencePath}`);
    } catch (error) {
      const blocked =
        error instanceof Error &&
        /authentication|required.*sign|sign in|quota|usage.limit|not installed|ENOENT|credentials|not configured|not signed|not ready/iu.test(
          error.message,
        );
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            ...evidence,
            status: blocked ? "blocked" : "failed",
            reason: blocked
              ? "Account authentication or quota unavailable"
              : "Engine name acceptance check failed",
            error: error instanceof Error ? error.message.slice(0, 2000) : String(error),
          },
          null,
          2,
        ),
      );
      console.info(`Thread name evidence: ${evidencePath}`);
      throw error;
    }
  }, 360_000);
});

describe("live Home handoff between native engines", () => {
  let stack: VerticalStack | undefined;
  let restorePath: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    restorePath = await shippedEnginesFirstOnPath();
  });

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    await restorePath?.();
    restorePath = undefined;
  }, 60_000);

  it("delivers committed Codex history to Claude and Claude history to a fresh Codex session", async () => {
    if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
    const shipped = qualifiedEngines.filter((engine) => engine.executable === "shipped");
    const codex = shipped.find((engine) => engine.driverKind === "codex")!;
    const claude = qualifiedEngines.find(
      (engine) => engine.driverKind === "claude" && engine.executable === "installed",
    )!;
    stack = await startVerticalStack({
      additionalHarnessInstances: [qualificationAccount(claude)],
      catalogTimeoutMs: 180_000,
      databaseUrl,
      harnessInstance: qualificationAccount(codex),
      harnesses: createHarnessRegistry(parseAgentExecutionConfig(process.env).harnessExecutables, {
        nodeExecutable: process.execPath,
        runtimeCacheDirectory: join(tmpdir(), "opensteer-test-runtime-cache"),
      }),
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      runTimeoutMs: 300_000,
    });
    const claudeHarnessId = stack.additionalHarnessInstanceIds[0];
    if (!claudeHarnessId) throw new Error("Claude account did not connect");
    const bootstrap = await stack.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const environment = bootstrap.data.environments.find(
      (candidate) => candidate.id === stack!.environmentId,
    );
    const claudeCatalog = environment?.harnessCatalogs.find(
      (candidate) => candidate.harnessInstanceId === claudeHarnessId,
    );
    if (claudeCatalog?.status !== "ready") throw new Error("Claude catalog is unavailable");
    const codexModel = stack.catalog.models.find((model) => model.isDefault);
    const claudeModel = claudeCatalog.models.find((model) => model.isDefault);
    if (!codexModel || !claudeModel) throw new Error("An engine has no default model");
    const codexSelection = ModelSelectionSchema.parse({
      modelId: codexModel.modelId,
      options: {},
      providerId: codexModel.providerId,
    });
    const claudeSelection = ModelSelectionSchema.parse({
      modelId: claudeModel.modelId,
      options: {},
      providerId: claudeModel.providerId,
    });
    const threadId = await stack.createThread({
      home: true,
      modelSelection: codexSelection,
      title: "Chat",
      workspaceId: stack.mainWorkspaceId,
    });
    const sourceCode = randomUUID();
    const first = await stack.sendMessage({
      text: `Remember this source code: ${sourceCode}. Reply only READY.`,
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    expect(first.assistantText).toMatch(/\bREADY\b/iu);
    const firstRun = await stack.host.store.database
      .selectFrom("runs")
      .select(["providerSessionId", "seedInputId"])
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    const firstSession = await stack.host.store.database
      .selectFrom("providerSessions")
      .select(["id", "providerSessionReference"])
      .where("id", "=", firstRun.providerSessionId)
      .executeTakeFirstOrThrow();
    expect(firstSession.providerSessionReference).toEqual(expect.any(String));

    await stack.updateThreadExecution(threadId, claudeSelection, {
      expectedProviderSessionId: firstSession.id,
      harnessInstanceId: claudeHarnessId,
    });
    const handoffCode = randomUUID();
    const second = await stack.sendMessage({
      text: `What source code did I give earlier? Also remember this new handoff code: ${handoffCode}. Reply only with the earlier source code.`,
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    expect(second.assistantText).toContain(sourceCode);
    const secondRun = await stack.host.store.database
      .selectFrom("runs")
      .select(["initialContext", "providerSessionId", "seedInputId"])
      .where("id", "=", second.runId)
      .executeTakeFirstOrThrow();
    expect(secondRun.providerSessionId).not.toBe(firstSession.id);
    expect(secondRun.initialContext?.messageIds).toContain(firstRun.seedInputId);
    expect(secondRun.initialContext?.messageIds).not.toContain(secondRun.seedInputId);

    await stack.updateThreadExecution(threadId, codexSelection, {
      expectedProviderSessionId: secondRun.providerSessionId,
      harnessInstanceId: stack.harnessInstanceId,
    });
    const third = await stack.sendMessage({
      text: "What new handoff code did I ask the previous engine to remember? Reply only with that code.",
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    expect(third.assistantText).toContain(handoffCode);
    const thirdRun = await stack.host.store.database
      .selectFrom("runs")
      .select(["initialContext", "providerSessionId"])
      .where("id", "=", third.runId)
      .executeTakeFirstOrThrow();
    expect(thirdRun.providerSessionId).not.toBe(firstSession.id);
    expect(thirdRun.providerSessionId).not.toBe(secondRun.providerSessionId);
    expect(thirdRun.initialContext?.messageIds).toContain(secondRun.seedInputId);

    const evidenceRoot =
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-engine-evidence", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "home-codex-claude-codex.json"),
      JSON.stringify(
        {
          threadId,
          runIds: [first.runId, second.runId, third.runId],
          sessionIds: [firstSession.id, secondRun.providerSessionId, thirdRun.providerSessionId],
          firstHandoffIncludedSource: secondRun.initialContext?.messageIds.includes(
            firstRun.seedInputId,
          ),
          returnHandoffIncludedClaude: thirdRun.initialContext?.messageIds.includes(
            secondRun.seedInputId,
          ),
          sourceCodeRecalled: second.assistantText.includes(sourceCode),
          handoffCodeRecalled: third.assistantText.includes(handoffCode),
        },
        null,
        2,
      ),
    );
    console.info(`Live Home handoff evidence: ${evidenceRoot}`);
  }, 900_000);
});

interface PhotoEvidence {
  readonly answer: string;
  readonly check: string;
  readonly expected: string;
  readonly runId: string;
  readonly sources: readonly {
    readonly bytes: number;
    readonly height: number | null;
    readonly name: string;
    readonly width: number | null;
  }[];
}

/**
 * Real photos, not thumbnails: every image is larger than any engine's own
 * input limit (over 5 MiB, 24 MP or more), so each check proves the driver
 * fitted it on that delivery path and the model still read what it shows.
 * Words are random, so an answer cannot come from anything but the image.
 */
async function qualifyPhotos(input: {
  readonly label: string;
  readonly modelSelection: ModelSelection;
  readonly stack: VerticalStack;
  readonly steering: boolean;
  readonly workspaceId: WorkspaceId;
}): Promise<readonly PhotoEvidence[]> {
  const { stack, workspaceId } = input;
  const threadId = await stack.createThread({
    modelSelection: input.modelSelection,
    title: `${input.label} photo qualification`,
    workspaceId,
  });
  const evidence: PhotoEvidence[] = [];
  const sources = (attachments: readonly Attachment[]) =>
    attachments.map((attachment) => ({
      bytes: attachment.sizeBytes,
      height: attachment.height,
      name: attachment.name,
      width: attachment.width,
    }));

  // A default 24 MP phone photo, larger than every engine's per-image limit.
  const word = randomWord();
  const bytes = await wordPhoto(word, "#ffd400");
  expect(bytes.byteLength).toBeGreaterThan(5 * 1_024 * 1_024);
  const photo = await stack.uploadAttachment({
    bytes,
    mediaType: "image/jpeg",
    name: "IMG_8003.jpeg",
    workspaceId,
  });
  expect([photo.width, photo.height]).toEqual([5712, 4284]);
  const read = await stack.sendMessage({
    attachments: [attachmentReference(photo)],
    text: "What word is written in large letters in the attached photo? Reply with only that word.",
    threadId,
    workspaceId,
  });
  expect(read.assistantText.toUpperCase()).toContain(word);
  evidence.push({
    answer: read.assistantText,
    check: "24 MP photo over 5 MiB on the first message",
    expected: word,
    runId: read.runId,
    sources: sources([photo]),
  });
  console.info(`${input.label}: read a full-resolution photo`);

  // A new Run on the same conversation: the Runner rebuilt its cache, and the
  // engine answers a question about the photo that nobody asked before.
  const recall = await stack.sendMessage({
    text: "In the photo I sent before, what color are the letters of that word? Reply with only one word: YELLOW, RED, or GREEN.",
    threadId,
    workspaceId,
  });
  expect(recall.assistantText.toUpperCase()).toContain("YELLOW");
  expect(recall.assistantText.toUpperCase()).not.toMatch(/\b(?:RED|GREEN)\b/u);
  evidence.push({
    answer: recall.assistantText,
    check: "continued conversation still holds the earlier photo",
    expected: "YELLOW",
    runId: recall.runId,
    sources: [],
  });

  // Stored sideways with EXIF orientation 6: upright, red fills the top half.
  const turned = await stack.uploadAttachment({
    bytes: await turnedPhoto(),
    mediaType: "image/jpeg",
    name: "turned.jpg",
    workspaceId,
  });
  expect([turned.width, turned.height]).toEqual([900, 1200]);
  const orientation = await stack.sendMessage({
    attachments: [attachmentReference(turned)],
    text: "Look only at the photo attached to this message. Which color fills its TOP half? Reply with only RED or BLUE.",
    threadId,
    workspaceId,
  });
  expect(orientation.assistantText.trim().split(/\r?\n/u).at(-1)).toMatch(/^RED[.!]?$/iu);
  evidence.push({
    answer: orientation.assistantText,
    check: "EXIF-rotated photo arrives upright",
    expected: "RED",
    runId: orientation.runId,
    sources: sources([turned]),
  });

  // Three full photos in one message share one delivery's transport budget.
  const words = [randomWord(), randomWord(), randomWord()];
  const several = [];
  for (const [index, each] of words.entries())
    several.push(
      await stack.uploadAttachment({
        bytes: await wordPhoto(each, "#ffffff"),
        mediaType: "image/jpeg",
        name: `photo-${index + 1}.jpeg`,
        workspaceId,
      }),
    );
  const ordered = await stack.sendMessage({
    attachments: several.map(attachmentReference),
    text: "Each of the three attached photos shows one large word. Reply with the three words in the order the photos are attached, separated by spaces, and nothing else.",
    threadId,
    workspaceId,
  });
  const positions = words.map((each) => ordered.assistantText.toUpperCase().indexOf(each));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  evidence.push({
    answer: ordered.assistantText,
    check: "three full photos in one message, in order",
    expected: words.join(" "),
    runId: ordered.runId,
    sources: sources(several),
  });

  // 16-bit RGBA at 70 MP needs 558 MB to decode, beyond Codex's decoder.
  const deepWord = randomWord();
  const deep = await stack.uploadAttachment({
    bytes: await deepWordImage(deepWord),
    mediaType: "image/png",
    name: "scan.png",
    workspaceId,
  });
  const deepRead = await stack.sendMessage({
    attachments: [attachmentReference(deep)],
    text: "What word is written in the attached image? Reply with only that word.",
    threadId,
    workspaceId,
  });
  expect(deepRead.assistantText.toUpperCase()).toContain(deepWord);
  evidence.push({
    answer: deepRead.assistantText,
    check: "70 MP 16-bit PNG",
    expected: deepWord,
    runId: deepRead.runId,
    sources: sources([deep]),
  });
  console.info(`${input.label}: read rotated, several and deep images`);

  if (input.steering) {
    // The photo arrives while the agent's command is running, through the
    // engine's mid-turn path rather than the prompt that started the turn.
    const steeredWord = randomWord();
    const steeredPhoto = await stack.uploadAttachment({
      bytes: await wordPhoto(steeredWord, "#7cff4f"),
      mediaType: "image/jpeg",
      name: "IMG_8004.jpeg",
      workspaceId,
    });
    const steered = await stack.sendMessage({
      onQueued: async (runId) => {
        await stack.waitForToolStart(runId);
        await stack.steerMessage({
          attachments: [attachmentReference(steeredPhoto)],
          text: "While that command runs: what word is written in large letters in the attached photo? Put that word in your final reply.",
          threadId,
        });
      },
      text: "Use your shell tool to run exactly `sleep 30` and wait for it to finish. Then reply with DONE, plus the answer to any question you received meanwhile.",
      threadId,
      workspaceId,
    });
    expect(steered.assistantText.toUpperCase()).toContain(steeredWord);
    evidence.push({
      answer: steered.assistantText,
      check: "24 MP photo steered into a running turn",
      expected: steeredWord,
      runId: steered.runId,
      sources: sources([steeredPhoto]),
    });
    console.info(`${input.label}: read a photo steered into a running turn`);
  }
  return evidence;
}

/** Five letters no model confuses with digits or each other in a bold sans-serif. */
function randomWord(): string {
  const letters = "ACEFHKLMNPRTUVWXY";
  return Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join("");
}

/** A 5712×4284 photo, noisy enough to exceed 5 MiB, with one large word. */
async function wordPhoto(word: string, color: string): Promise<Buffer> {
  const width = 5712;
  const height = 4284;
  const grain = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#808080",
      noise: { type: "gaussian", mean: 128, sigma: 24 },
    },
  })
    .raw()
    .toBuffer();
  const lettering = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1e3a8a" fill-opacity="0.55"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="950" fill="${color}">${word}</text></svg>`,
  );
  return sharp(grain, { raw: { width, height, channels: 3 } })
    .composite([{ input: lettering }])
    .jpeg({ quality: 94 })
    .toBuffer();
}

/** Stored 1200×900 with red left and blue right; EXIF 6 shows red on top. */
async function turnedPhoto(): Promise<Buffer> {
  const halves = Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="900" fill="#d61f1f"/><rect x="600" width="600" height="900" fill="#1f3fd6"/></svg>`,
  );
  return sharp(halves).jpeg().withMetadata({ orientation: 6 }).toBuffer();
}

/** 9700×7200 16-bit RGBA with one large word: 558 MB decoded, a few MB stored. */
async function deepWordImage(word: string): Promise<Buffer> {
  const width = 9700;
  const height = 7200;
  const lettering = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="1800" fill="#ffffff">${word}</text></svg>`,
  );
  return sharp({
    create: { width, height, channels: 4, background: { r: 32, g: 48, b: 74, alpha: 1 } },
    limitInputPixels: false,
  })
    .composite([{ input: lettering, limitInputPixels: false }])
    .toColourspace("rgb16")
    .png()
    .toBuffer();
}

function qualificationFailure(engine: QualifiedEngine, error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (
    engine.signInGuidance &&
    /authentication-required|not authenticated|not logged in|not signed in|sign in/iu.test(
      failure.message,
    )
  ) {
    return new Error(
      `${engine.label} is not signed in. ${engine.signInGuidance} Then rerun \`pnpm test:engines -- -t '${engine.label}'\`.`,
      { cause: failure },
    );
  }
  return failure;
}

/** Answers one engine approval exactly as a connected client does. */
async function approvePendingHarnessRequest(active: VerticalStack, runId: string): Promise<string> {
  let pending:
    | {
        readonly id: string;
        readonly kind: string;
        readonly presentation: unknown;
      }
    | undefined;
  await vi.waitFor(
    async () => {
      pending = await active.host.store.database
        .selectFrom("requests")
        .select(["id", "kind", "presentation"])
        .where("originatingRunId", "=", runId as never)
        .where("status", "=", "pending")
        .executeTakeFirst();
      expect(pending, "The supervised engine did not open an approval Request").toBeDefined();
    },
    { interval: 250, timeout: 180_000 },
  );
  if (!pending) throw new Error("The supervised engine did not open an approval Request");
  expect(pending.kind).toBe("harness.approval");
  const presentation = RequestPresentationSchema.parse(pending.presentation);
  if (presentation.kind !== "choice") {
    throw new Error(`The engine approval used ${presentation.kind}, not a choice`);
  }
  const allow = presentation.options.find((option) => !requestOptionDeclines(option));
  if (!allow) throw new Error("The engine approval offered no allow choice");
  const key = `qualification-approval-${randomUUID()}`;
  const answered = await active.api["commands.dispatch"]({
    idempotencyKey: key,
    requestId: pending.id,
    response: { kind: "choice", optionId: allow.id },
    type: "request.respond",
  });
  if (!answered.ok) throw new Error(answered.error.message);
  return pending.id;
}

async function waitForRunStatus(
  active: VerticalStack,
  runId: string,
  status: "completed" | "running",
): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const run = await active.host.store.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId as never)
      .executeTakeFirstOrThrow();
    if (run.status === status) return;
    if (["completed", "failed", "interrupted"].includes(run.status))
      throw new Error(`The Run ended ${run.status} while waiting for ${status}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the Run to be ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until the Run has begun writing its answer, live or recorded. */
async function waitForAssistantText(active: VerticalStack, runId: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const live = await active.api["thread.live.get"]({ threadId: await threadOf(active, runId) });
    const written = live.ok
      ? live.data.runs
          .filter((run) => run.progress.runId === runId)
          .flatMap((run) => run.progress.items)
          .filter((item) => item.stream === "assistant")
          .reduce((length, item) => length + item.text.length, 0)
      : 0;
    if (written > 200) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the answer to start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function threadOf(active: VerticalStack, runId: string) {
  const run = await active.host.store.database
    .selectFrom("runs")
    .select("threadId")
    .where("id", "=", runId as never)
    .executeTakeFirstOrThrow();
  return run.threadId;
}
