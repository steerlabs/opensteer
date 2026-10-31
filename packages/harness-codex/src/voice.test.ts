import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createId } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { CodexHarnessDriver } from "./codex-driver.js";
import { isCodexVoiceAdapter, VOICE_PROMPT, type CodexVoiceCall } from "./voice.js";

const directories: string[] = [];
const calls: CodexVoiceCall[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(calls.splice(0).map((call) => call.stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(scenario = "happy") {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-voice-test-"));
  directories.push(directory);
  const capture = join(directory, "capture.jsonl");
  const adapter = await new CodexHarnessDriver({
    launch: {
      executable: process.execPath,
      arguments: [
        fileURLToPath(new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url)),
        `--scenario=${scenario}`,
        `--capture=${capture}`,
      ],
    },
  }).create({ instanceId: createId("harnessInstance"), config: {}, sourceId: "openai" });
  if (!isCodexVoiceAdapter(adapter)) throw new Error("Codex adapter must support voice");
  const root = join(directory, "voice");
  const open = (agent = false) =>
    adapter.startVoiceCall({
      agent,
      offer: "private-offer",
      signal: new AbortController().signal,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        CODEX_HOME: join(directory, "codex-home"),
      },
      providerState: {
        kind: "ambient",
        providerHomeDirectory: undefined,
        continuationKey: "voice-test",
        privateStateRoot: directory,
        store: { directory: join(directory, "store"), id: "voice-test" },
      },
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      workingDirectory: root,
    });
  return {
    open,
    root,
    capture: async () =>
      (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line): Record<string, unknown> => JSON.parse(line)),
    adapter,
  };
}
describe("Codex voice calls", () => {
  it("confines the agent, validates tools, redelivers, expires and drains calls", async () => {
    const f = await fixture("voice-agent");
    const call = await f.open(true);
    calls.push(call);
    await call.context("visible chat");
    await Promise.all([call.context("visible chat"), call.context("visible chat")]);
    await call.say("invalid");
    await vi.waitFor(async () =>
      expect(
        (await f.capture()).filter(
          (r) => r.result && (r.result as { success?: boolean }).success === false,
        ),
      ).toHaveLength(4),
    );
    await call.say("queue");
    await vi.waitFor(async () =>
      expect(
        (await f.capture()).filter(
          (r) => r.result && (r.result as { success?: boolean }).success === false,
        ),
      ).toHaveLength(5),
    );
    const first = await call.next(new AbortController().signal);
    expect(first).toMatchObject({
      tool: "send_to_chat",
      input: { messages: 1 },
      heard: ["Book a flight & hotel"],
    });
    expect(await call.next(new AbortController().signal)).toEqual(first);
    await call.answerCall(first!.id, true, "Sent.");
    await call.answerCall(first!.id, false, "Ignored.");
    expect((await call.next(new AbortController().signal))?.id).not.toBe(first!.id);
    await call.stop();
    const records = await f.capture();
    expect(records.some((r) => r.method === "turn/interrupt")).toBe(false);
    const start = records.find((r) => r.method === "thread/start")!;
    expect(start.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: "",
      selectedCapabilityRoots: [],
      environments: [],
      runtimeWorkspaceRoots: [],
      config: {
        model_reasoning_effort: "low",
        project_doc_max_bytes: 0,
        features: { code_mode_host: true, shell_tool: false },
      },
    });
    expect(
      (start.params as { dynamicTools: { name: string }[] }).dynamicTools.map((t) => t.name),
    ).toEqual(["show", "send_to_chat"]);
    const realtime = records.find((r) => r.method === "thread/realtime/start")!;
    expect(realtime.params).not.toHaveProperty("prompt");
    expect(realtime.params).not.toHaveProperty("clientManagedHandoffs");
    expect(records.filter((r) => r.method === "thread/inject_items")).toHaveLength(3);
    const responses = records.filter((r) => r.result && "success" in (r.result as object));
    expect(responses.filter((r) => (r.result as { success: boolean }).success)).toHaveLength(1);
    expect(responses.filter((r) => JSON.stringify(r).includes("The call ended."))).toHaveLength(7);
    await f.adapter.close();
  });
  it("bounds empty next and tool deadlines and cancels waiting readers", async () => {
    const f = await fixture("voice-agent");
    const call = await f.open(true);
    calls.push(call);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const empty = call.next(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await empty).toBeNull();
    const cancelled = new AbortController();
    const waiting = call.next(cancelled.signal);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    cancelled.abort(new Error("cancelled"));
    await rejected;
    await call.say("one");
    const tool = await call.next(new AbortController().signal);
    expect(tool?.tool).toBe("show");
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    await call.answerCall(tool!.id, true, "Late.");
    await call.stop();
    expect(
      (await f.capture()).some((r) => JSON.stringify(r).includes("device didn't answer")),
    ).toBe(true);
    await f.adapter.close();
  });

  it("isolates a v3 call, interrupts handoffs, relays text and removes its state on stop", async () => {
    const f = await fixture("ambient-extensions");
    const call = await f.open();
    calls.push(call);
    expect(call.answer).toBe("fake-answer");
    const [name] = await readdir(f.root);
    expect((await stat(join(f.root, name!))).mode & 0o777).toBe(0o700);
    await call.say("Delivery 42 at 9am.");
    await call.stop();
    await call.stop();
    expect(await readdir(f.root)).toEqual([]);
    const records = await f.capture();
    const threadId = z
      .object({ params: z.object({ threadId: z.string() }) })
      .parse(records.find((record) => record.method === "thread/realtime/start")).params.threadId;
    expect(records).toContainEqual(
      expect.objectContaining({
        method: "initialize",
        params: expect.objectContaining({
          clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
          capabilities: expect.objectContaining({
            experimentalApi: true,
            requestAttestation: false,
          }),
        }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          dynamicTools: [],
          developerInstructions: "",
          config: expect.objectContaining({
            features: expect.objectContaining({ shell_tool: false, apps: false, plugins: false }),
            project_doc_max_bytes: 0,
            developer_instructions: "",
            "skills.bundled.enabled": false,
            "cloud.skills.enabled": false,
            "skills.include_instructions": false,
            "tools.experimental_request_user_input.enabled": false,
            "tools.update_plan.enabled": false,
            web_search: "disabled",
            mcp_servers: { "company.docs": { enabled: false }, github: { enabled: false } },
          }),
        }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        method: "thread/realtime/start",
        params: {
          threadId,
          transport: { type: "webrtc", sdp: "private-offer" },
          version: "v3",
          clientManagedHandoffs: true,
          includeStartupContext: false,
          outputModality: "audio",
          prompt: VOICE_PROMPT,
        },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId, turnId: "voice-handoff" },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        method: "thread/realtime/appendSpeech",
        params: { threadId, text: "Delivery 42 at 9am." },
      }),
    );
    const processRecord = records.find((record) => "fakeCodexProcess" in record)?.fakeCodexProcess;
    expect(processRecord).toMatchObject({
      argv: expect.arrayContaining([
        `log_dir=${JSON.stringify(join(f.root, name!))}`,
        "project_doc_max_bytes=0",
        'developer_instructions=""',
      ]),
    });
    // A fresh state home blocks app-server startup until it backfills every
    // session in the Codex home, so the call keeps the account's own.
    const launched = processRecord as {
      readonly argv: readonly string[];
      readonly environment: { readonly CODEX_SQLITE_HOME: string | null };
    };
    expect(launched.argv.some((arg) => arg.startsWith("sqlite_home="))).toBe(false);
    expect(launched.environment.CODEX_SQLITE_HOME).not.toBe(join(f.root, name!));
    expect(records).toContainEqual(expect.objectContaining({ method: "thread/realtime/stop" }));
    await f.adapter.close();
  });
  it.each([
    ["voice-refused", "voice-refused"],
    ["voice-closed", "voice-refused"],
    ["voice-unsupported", "voice-engine-unsupported"],
    ["voice-policy", "voice-refused"],
  ])("maps %s safely and cleans failed startup", async (scenario, reason) => {
    const f = await fixture(scenario);
    await expect(f.open()).rejects.toMatchObject({ reason, details: undefined });
    expect(await readdir(f.root)).toEqual([]);
    await f.adapter.close();
  });
  it.each(["voice-exit", "voice-interaction", "voice-close-after-say"])(
    "cleans up after %s",
    async (scenario) => {
      const f = await fixture(scenario);
      const call = await f.open();
      calls.push(call);
      await call.say("private relay").catch(() => undefined);
      await withTimeout(call.closed, 2_000, {
        timeoutError: () => new Error("Voice process did not close and clean up"),
      });
      expect(await readdir(f.root)).toEqual([]);
      await expect(call.say("too late")).rejects.toMatchObject({ reason: "voice-ended" });
      await f.adapter.close();
    },
  );
});
