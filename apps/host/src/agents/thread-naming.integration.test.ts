import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, type ModelSelection, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * Naming a task is Host-owned background work: the Host picks a light model,
 * asks the Runner holding that account for text, and applies the answer
 * through its fence. Each journey drives the real Host, Runner and Codex
 * driver against a fake app server whose naming turns a script decides per
 * model, so a candidate can fail, hold, or answer.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const taskModel = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const waitOptions = { timeout: 20_000, interval: 50 };
const scoutModel = ModelSelectionSchema.parse({
  modelId: "llama-4-scout",
  options: { effort: "low" },
  providerId: "meta",
});

interface Captured {
  readonly method?: string;
  readonly captureProcessId?: number;
  readonly params?: { readonly clientInfo?: { readonly name?: string } };
  readonly fakeTitleTurn?: { readonly pid: number; readonly model: string };
}
type TitleScript = Record<string, { reply?: string; error?: string; hold?: string }>;

integration("Task naming through the Runner", () => {
  let stack: VerticalStack | undefined;
  const scratches: string[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    for (const path of scratches.splice(0)) await rm(path, { force: true, recursive: true });
  }, 60_000);

  async function start() {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-naming-"));
    scratches.push(scratch);
    const captureFile = join(scratch, "capture.jsonl");
    const scriptFile = join(scratch, "titles.json");
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new CodexHarnessDriver({
            launch: {
              arguments: [
                fakeCodexAppServer,
                "--scenario=vertical",
                `--capture=${captureFile}`,
                "--capture-process-id",
                "--unique-threads",
                "--background-models",
                `--title-script=${scriptFile}`,
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const active = stack;
    const captured = async (): Promise<Captured[]> =>
      (await readFile(captureFile, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Captured);
    return {
      active,
      captured,
      script: (script: TitleScript) => writeFile(scriptFile, JSON.stringify(script)),
      hold: (name: string) => join(scratch, name),
      release: (file: string) => writeFile(file, ""),
      /** The models naming turns ran on, in order. */
      turns: async () =>
        (await captured()).flatMap((line) => (line.fakeTitleTurn ? [line.fakeTitleTurn] : [])),
      task: async (text: string, modelSelection: ModelSelection = taskModel) => {
        const threadId = await active.createThread({
          generateTitle: true,
          modelSelection,
          title: text.slice(0, 40),
          workspaceId: active.mainWorkspaceId,
          idempotencyKey: `naming-${randomUUID()}`,
        });
        return threadId;
      },
      send: (threadId: ThreadId, text: string) =>
        active.sendMessage({ text, threadId, workspaceId: active.mainWorkspaceId }),
      thread: (threadId: ThreadId) =>
        active.host.store.database
          .selectFrom("threads")
          .select(["title", "titleSource", "icon", "iconSource"])
          .where("id", "=", threadId)
          .executeTakeFirstOrThrow(),
    };
  }

  it("names a new task through its account's Runner without holding up the Run", async () => {
    const f = await start();
    const held = f.hold("first");
    await f.script({ "gpt-6-luna": { reply: "Help desk migration\nplane", hold: held } });
    const threadId = await f.task("Plan moving our support team to a new help desk");
    const turn = await f.send(threadId, "Plan moving our support team to a new help desk");
    // The Run completed while its task's naming was still held open.
    expect(turn.events.map((event) => event.type)).toContain("run.completed");
    await vi.waitFor(async () => expect(await f.turns()).toHaveLength(1), waitOptions);
    expect(await f.thread(threadId)).toMatchObject({
      titleSource: "provisional",
      iconSource: "provisional",
    });
    await f.release(held);
    await vi.waitFor(
      async () =>
        expect(await f.thread(threadId)).toEqual({
          title: "Help desk migration",
          titleSource: "generated",
          icon: "plane",
          iconSource: "generated",
        }),
      waitOptions,
    );
    const capture = await f.captured();
    const [naming] = await f.turns();
    expect(naming!.model).toBe("gpt-6-luna");
    // One engine process answered, and it listed no models.
    const namingProcess = capture.filter((line) => line.captureProcessId === naming!.pid);
    expect(namingProcess.filter((line) => line.method === "initialize")).toHaveLength(1);
    expect(namingProcess.some((line) => line.method === "model/list")).toBe(false);
    expect(
      capture.filter(
        (line) =>
          line.method === "initialize" && line.params?.clientInfo?.name === "opensteer_titles",
      ),
    ).toHaveLength(1);
  });
  it("moves past a usage-limited model after refreshing its catalog, falls back to the task model, and asks again on the next Run", async () => {
    const f = await start();
    const named = async (threadId: ThreadId, title: string) =>
      vi.waitFor(
        async () =>
          expect(await f.thread(threadId)).toMatchObject({ title, titleSource: "generated" }),
        waitOptions,
      );
    const models = async () => (await f.turns()).map((turn) => turn.model);

    await f.script({
      "gpt-6-luna": { error: "You've hit your usage limit. Try again later." },
      "gpt-5.6-luna": { reply: "Quarterly plan\ncalendar" },
    });
    const limited = await f.task("Draft the quarterly plan");
    await f.send(limited, "Draft the quarterly plan");
    await named(limited, "Quarterly plan");
    expect(await models()).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    // The failed account's catalog was asked for afresh before the next attempt.
    const capture = await f.captured();
    const failed = capture.findIndex((line) => line.fakeTitleTurn?.model === "gpt-6-luna");
    const next = capture.findIndex((line) => line.fakeTitleTurn?.model === "gpt-5.6-luna");
    expect(capture.slice(failed, next).some((line) => line.method === "model/list")).toBe(true);

    await f.script({
      "gpt-6-luna": { error: "You've hit your usage limit." },
      "gpt-5.6-luna": { error: "Model unavailable." },
      "gpt-5.6-sol": { reply: "Fallback name\nmap" },
    });
    const fallback = await f.task("Book the venue for the offsite");
    await f.send(fallback, "Book the venue for the offsite");
    await named(fallback, "Fallback name");
    expect((await models()).slice(2)).toEqual(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol"]);

    await f.script({
      "gpt-6-luna": { error: "You've hit your usage limit." },
      "gpt-5.6-luna": { error: "Model unavailable." },
      "gpt-5.6-sol": { error: "You've hit your usage limit." },
    });
    const unnamed = await f.task("Sort the receipts from March");
    await f.send(unnamed, "Sort the receipts from March");
    // Every attempt failed and the last one's catalog refresh has been asked for.
    await vi.waitFor(async () => {
      const lines = await f.captured();
      const last = lines.findLastIndex((line) => line.fakeTitleTurn !== undefined);
      expect((await models()).slice(5)).toEqual(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol"]);
      expect(lines.slice(last).some((line) => line.method === "model/list")).toBe(true);
    }, waitOptions);
    expect(await f.thread(unnamed)).toMatchObject({
      titleSource: "provisional",
      iconSource: "provisional",
    });
    await f.script({ "gpt-6-luna": { reply: "March receipts\nmail" } });
    await f.send(unnamed, "Start with the hotel ones");
    await named(unnamed, "March receipts");
    expect((await models()).slice(8)).toEqual(["gpt-6-luna"]);
  });

  it("keeps a person's rename made while naming is in flight", async () => {
    const f = await start();
    const held = f.hold("rename");
    await f.script({ "gpt-6-luna": { reply: "Generated name\nplane", hold: held } });
    const threadId = await f.task("Find a dentist near the office");
    await f.send(threadId, "Find a dentist near the office");
    await vi.waitFor(async () => expect(await f.turns()).toHaveLength(1), waitOptions);
    const renamed = await f.active.api["commands.dispatch"]({
      type: "thread.rename",
      threadId,
      title: "Dentist",
      idempotencyKey: `rename-${randomUUID()}`,
    });
    if (!renamed.ok) throw new Error(renamed.error.message);
    await f.release(held);
    // The icon was still provisional, so it settles; the person's title stays.
    await vi.waitFor(
      async () =>
        expect(await f.thread(threadId)).toEqual({
          title: "Dentist",
          titleSource: "chosen",
          icon: "plane",
          iconSource: "generated",
        }),
      waitOptions,
    );
  });

  it("rejects a disconnected attempt's late answer and names through the reconnected Runner", async () => {
    const f = await start();
    const stale = f.hold("stale");
    const fresh = f.hold("fresh");
    await f.script({ "gpt-6-luna": { reply: "Stale name\nplane", hold: stale } });
    const threadId = await f.task("Renew the car insurance");
    await f.send(threadId, "Renew the car insurance");
    await vi.waitFor(async () => expect(await f.turns()).toHaveLength(1), waitOptions);
    const [held] = await f.turns();
    // Later attempts, on any candidate, answer freshly once released.
    const answer = { reply: "Fresh name\nmail", hold: fresh };
    await f.script({ "gpt-6-luna": answer, "gpt-5.6-luna": answer, "gpt-5.6-sol": answer });
    f.active.network.drop();
    // The Host gave up the dropped attempt at once and asked the reconnected Runner.
    await vi.waitFor(async () => expect(await f.turns()).toHaveLength(2), waitOptions);
    await f.release(stale);
    await vi.waitFor(() => expect(alive(held!.pid)).toBe(false), waitOptions);
    expect(await f.thread(threadId)).toMatchObject({ titleSource: "provisional" });
    await f.release(fresh);
    await vi.waitFor(
      async () =>
        expect(await f.thread(threadId)).toEqual({
          title: "Fresh name",
          titleSource: "generated",
          icon: "mail",
          iconSource: "generated",
        }),
      waitOptions,
    );
  });

  it("skips another provider's model until the person allows it, then uses it", async () => {
    const f = await start();
    await f.script({
      "gpt-6-luna": { reply: "Luna name\nplane" },
      "llama-4-scout": { reply: "Scout name\nmail" },
    });
    const light = async () => {
      const read = await f.active.api["backgroundModels.get"]({});
      if (!read.ok) throw new Error(read.error.message);
      return read.data.light;
    };
    const consent = async (acknowledged: boolean) => {
      const result = await f.active.api["commands.dispatch"]({
        type: "backgroundModels.consent.set",
        providerId: ModelSelectionSchema.shape.providerId.parse("openai"),
        acknowledged,
        idempotencyKey: `consent-${randomUUID()}`,
      });
      if (!result.ok) throw new Error(result.error.message);
    };
    expect(
      (await light()).candidates.find(
        (candidate) => candidate.modelSelection.modelId === "gpt-6-luna",
      )?.skipReason,
    ).toBe("consent-required");

    // A task on Scout keeps its naming with Scout's provider.
    const before = await f.task("Compare the two lease offers", scoutModel);
    await f.send(before, "Compare the two lease offers");
    await vi.waitFor(
      async () => expect(await f.thread(before)).toMatchObject({ title: "Scout name" }),
      waitOptions,
    );
    expect((await f.turns()).map((turn) => turn.model)).toEqual(["llama-4-scout"]);

    await consent(true);
    expect((await light()).effectivePick?.modelSelection.modelId).toBe("gpt-6-luna");
    const after = await f.task("Plan the garden beds", scoutModel);
    await f.send(after, "Plan the garden beds");
    await vi.waitFor(
      async () => expect(await f.thread(after)).toMatchObject({ title: "Luna name" }),
      waitOptions,
    );
    expect((await f.turns()).map((turn) => turn.model)).toEqual(["llama-4-scout", "gpt-6-luna"]);

    await consent(false);
    expect(
      (await light()).candidates.find(
        (candidate) => candidate.modelSelection.modelId === "gpt-6-luna",
      )?.skipReason,
    ).toBe("consent-required");
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
