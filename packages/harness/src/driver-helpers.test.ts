import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpensteerError } from "@opensteer/core";
import { afterAll, describe, expect, it } from "vitest";
import { runHarnessCliLogout, type HarnessLogoutProcess } from "./cli-logout.js";
import { Deferred } from "./deferred.js";
import { toHarnessError, toHarnessTransportError } from "./errors.js";
import { clampConnectionLabel, reasoningEffortLabel } from "./labels.js";
import { providerSecretFile } from "./provider-secret-file.js";
import { secretInputAuthentication } from "./secret-authentication.js";
import { HarnessSessionRegistry } from "./session-registry.js";
import { opensteerToolIdentity } from "./tool-identity.js";
import { TurnPublisher, runEndedEvent, runStartedEvent } from "./turn-publisher.js";
import type { HarnessProviderState } from "./types.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opensteer-harness-helpers-"));
  temporaryDirectories.push(path);
  return path;
}

function providerState(directory: string, kind: "ambient" | "isolated"): HarnessProviderState {
  return {
    continuationKey: "store",
    kind,
    privateStateRoot: directory,
    providerHomeDirectory: kind === "isolated" ? join(directory, "home") : undefined,
    store: { directory: join(directory, "store"), id: "store" },
  };
}

describe("Deferred", () => {
  it("settles once and ignores the losers of a race", async () => {
    const deferred = new Deferred<string>();
    deferred.resolve("first");
    deferred.resolve("second");
    await expect(deferred.promise).resolves.toBe("first");
  });
});

describe("harness error normalization", () => {
  it("passes a described failure through untouched", () => {
    const described = new OpensteerError({ code: "conflict", message: "already running" });
    expect(toHarnessError(described, "Turn failed")).toBe(described);
    expect(toHarnessTransportError(described, "Turn failed")).toBe(described);
  });

  it("names the operation in front of an undescribed provider message", () => {
    const error = toHarnessError(new Error("ECONNRESET"), "Codex turn failed");
    expect(error.code).toBe("harness_error");
    expect(error.message).toBe("Codex turn failed: ECONNRESET");
  });

  it("reads a deadline and an overload out of a transport message", () => {
    const timedOut = toHarnessTransportError(new Error("Request timed out"), "failed");
    expect(timedOut.code).toBe("timeout");
    expect(timedOut.retryable).toBe(true);

    const overloaded = toHarnessTransportError(new Error("Upstream is overloaded"), "failed");
    expect(overloaded.code).toBe("harness_error");
    expect(overloaded.retryable).toBe(true);

    const other = toHarnessTransportError(new Error("bad request"), "failed");
    expect(other.code).toBe("harness_error");
    expect(other.retryable).toBe(false);
    // The provider's own words reach the reader, never a prefixed restatement.
    expect(other.message).toBe("bad request");
  });
});

describe("connection labels", () => {
  it("spells xhigh out and titles every other effort", () => {
    expect(reasoningEffortLabel("xhigh")).toBe("Extra high");
    expect(reasoningEffortLabel("medium")).toBe("Medium");
  });

  it("clamps a label to what the protocol accepts and drops a blank one", () => {
    expect(clampConnectionLabel(undefined)).toBeUndefined();
    expect(clampConnectionLabel("   ")).toBeUndefined();
    expect(clampConnectionLabel("  team  ")).toBe("team");
    expect(clampConnectionLabel("x".repeat(400))).toHaveLength(200);
  });
});

describe("opensteerToolIdentity", () => {
  it("names Opensteer's own servers and keeps every other behind mcp:", () => {
    expect(opensteerToolIdentity("opensteer", "thread_read")).toEqual({
      name: "thread_read",
      namespace: "opensteer",
    });
    expect(opensteerToolIdentity("opensteer_integrations", "gateway_call")).toEqual({
      name: "gateway_call",
      namespace: "opensteer.integrations",
    });
    expect(opensteerToolIdentity("linear", "create_issue")).toEqual({
      name: "create_issue",
      namespace: "mcp:linear",
    });
  });

  it("names what a provider left unspoken rather than dropping the call", () => {
    expect(opensteerToolIdentity(undefined, undefined)).toEqual({
      name: "unknown",
      namespace: "mcp:unknown",
    });
  });
});

describe("providerSecretFile", () => {
  it("round-trips a secret at mode 0600 inside the profile's home", async () => {
    const directory = await temporaryDirectory();
    const secret = providerSecretFile(providerState(directory, "isolated"), ".key", {
      description: "endpoint API key",
      maximumBytes: 8 * 1_024,
    });

    expect(await secret.read()).toBeUndefined();
    await secret.write("endpoint-key\n");
    expect(await secret.read()).toBe("endpoint-key");
    expect((await stat(secret.path)).mode & 0o777).toBe(0o600);

    await secret.remove();
    expect(await secret.read()).toBeUndefined();
  });

  it("refuses a secret other accounts on the computer can read", async () => {
    const directory = await temporaryDirectory();
    const state = providerState(directory, "isolated");
    const secret = providerSecretFile(state, ".key", {
      description: "Anthropic API key",
      maximumBytes: 8 * 1_024,
    });
    await mkdir(join(directory, "home"), { recursive: true });
    await writeFile(secret.path, "leaked", { mode: 0o600 });
    await chmod(secret.path, 0o644);

    await expect(secret.read()).rejects.toMatchObject({
      message: "The stored Anthropic API key is readable by other accounts on this computer",
    });
  });

  it("refuses to exist at all for a profile that shares the computer's home", () => {
    expect(() =>
      providerSecretFile(providerState("/tmp/opensteer-ambient", "ambient"), ".key", {
        description: "endpoint API key",
        maximumBytes: 1_024,
      }),
    ).toThrow(/isolated profile/u);
  });
});

describe("secretInputAuthentication", () => {
  const options = {
    cancelledDetail: "The API key was not entered",
    engineLabel: "Codex",
    inputLabel: "API key",
    requiredMessage: "API key is required",
    storeFailedDetail: "The endpoint API key could not be stored",
  };

  it("carries the value once, trimmed, and settles ready", async () => {
    const stored: string[] = [];
    const flow = secretInputAuthentication({
      ...options,
      store: async (secret) => void stored.push(secret),
    });
    if (flow.status !== "pending") throw new Error("Expected a pending flow");
    expect(flow.challenge).toEqual({ inputLabel: "API key", kind: "secret-input" });

    await flow.submit?.(" endpoint-key\n");
    expect(stored).toEqual(["endpoint-key"]);
    await expect(flow.result).resolves.toEqual({ status: "ready" });
  });

  it("refuses an empty field and one beyond the provider's length", async () => {
    const flow = secretInputAuthentication({
      ...options,
      maximumLength: 8,
      store: async () => undefined,
    });
    if (flow.status !== "pending") throw new Error("Expected a pending flow");
    await expect(flow.submit?.("  ")).rejects.toMatchObject({
      code: "bad_request",
      message: "API key is required",
    });
    await expect(flow.submit?.("x".repeat(9))).rejects.toMatchObject({ code: "bad_request" });
  });

  it("settles failed when the secret could not be written", async () => {
    const flow = secretInputAuthentication({
      ...options,
      store: async () => {
        throw new Error("read-only filesystem");
      },
    });
    if (flow.status !== "pending") throw new Error("Expected a pending flow");
    await flow.submit?.("endpoint-key");
    await expect(flow.result).resolves.toEqual({
      detail: "The endpoint API key could not be stored",
      status: "failed",
    });
  });

  it("settles as cancelled and refuses a late submission", async () => {
    const lifetime = new AbortController();
    const flow = secretInputAuthentication({
      ...options,
      signal: lifetime.signal,
      store: async () => undefined,
    });
    if (flow.status !== "pending") throw new Error("Expected a pending flow");
    lifetime.abort(new Error("the caller walked away"));
    await expect(flow.result).resolves.toEqual({
      detail: "The API key was not entered",
      status: "failed",
    });
    await expect(flow.submit?.("endpoint-key")).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("runHarnessCliLogout", () => {
  function logoutProcess(options: {
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly onTerminate?: () => void;
  }): HarnessLogoutProcess & { readonly drained: string[] } {
    const drained: string[] = [];
    const stream = async function* (label: string): AsyncIterable<Buffer> {
      drained.push(label);
      yield Buffer.from("a credential nobody should keep");
    };
    return {
      drained,
      exited: options.exited,
      stderr: stream("stderr"),
      stdout: stream("stdout"),
      terminate: async () => options.onTerminate?.(),
    };
  }

  it("drains both pipes and accepts a clean exit", async () => {
    const process = logoutProcess({ exited: Promise.resolve({ code: 0, signal: null }) });
    await expect(
      runHarnessCliLogout({ engineLabel: "Codex", process, timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();
    expect(process.drained.sort()).toEqual(["stderr", "stdout"]);
  });

  it("reports the exit code the CLI refused with", async () => {
    const process = logoutProcess({ exited: Promise.resolve({ code: 3, signal: null }) });
    await expect(
      runHarnessCliLogout({ engineLabel: "Claude", process, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "harness_error",
      message: "Claude sign out failed (exit 3)",
    });
  });

  it("terminates a sign-out that outlives its deadline", async () => {
    let terminated = false;
    const process = logoutProcess({
      exited: new Promise(() => undefined),
      onTerminate: () => {
        terminated = true;
      },
    });
    await expect(
      runHarnessCliLogout({ engineLabel: "Codex", process, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "timeout", message: "Codex sign out timed out" });
    expect(terminated).toBe(true);
  });
});

describe("HarnessSessionRegistry", () => {
  class FakeSession {
    readonly providerSessionReference: string;
    stopped = 0;
    constructor(providerSessionReference: string) {
      this.providerSessionReference = providerSessionReference;
    }
    async stop(): Promise<void> {
      this.stopped += 1;
    }
  }

  it("refuses a second open against a reference it already holds", async () => {
    const registry = new HarnessSessionRegistry<FakeSession>("Codex");
    await registry.open("thread-1", async () => new FakeSession("thread-1"));

    await expect(
      registry.open("thread-1", async () => new FakeSession("thread-1")),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Codex session thread-1 is already active in this harness instance",
    });
  });

  it("claims a reference for the whole of an open that is still in flight", async () => {
    const registry = new HarnessSessionRegistry<FakeSession>("Claude");
    let finish!: (session: FakeSession) => void;
    const first = registry.open(
      "thread-1",
      () => new Promise<FakeSession>((resolve) => (finish = resolve)),
    );

    await expect(
      registry.open("thread-1", async () => new FakeSession("thread-1")),
    ).rejects.toMatchObject({ code: "conflict" });
    finish(new FakeSession("thread-1"));
    await first;
  });

  it("stops a session that opened into a closed adapter", async () => {
    const registry = new HarnessSessionRegistry<FakeSession>("Codex");
    const orphan = new FakeSession("thread-1");
    let finish!: (session: FakeSession) => void;
    const opening = registry.open(
      "thread-1",
      () => new Promise<FakeSession>((resolve) => (finish = resolve)),
    );
    const closing = registry.close();
    finish(orphan);

    await expect(opening).rejects.toMatchObject({
      code: "harness_error",
      message: "Codex harness adapter is closed",
    });
    await closing;
    expect(orphan.stopped).toBeGreaterThan(0);
  });

  it("claims an unreferenced session only once the provider has named it", async () => {
    const registry = new HarnessSessionRegistry<FakeSession>("Codex");
    const first = await registry.openUnreferenced(async () => new FakeSession("thread-1"));
    expect(registry.holds("thread-1")).toBe(true);

    const duplicate = new FakeSession("thread-1");
    await expect(registry.openUnreferenced(async () => duplicate)).rejects.toMatchObject({
      code: "conflict",
    });
    // The provider process is live and unreachable, so it is never left running.
    expect(duplicate.stopped).toBe(1);
    expect(first.stopped).toBe(0);
  });

  it("forgets a session that stopped itself, and stops the rest on close", async () => {
    const registry = new HarnessSessionRegistry<FakeSession>("Claude");
    const closed = await registry.open("thread-1", async () => new FakeSession("thread-1"));
    const live = await registry.open("thread-2", async () => new FakeSession("thread-2"));
    registry.release(closed);
    expect(registry.holds("thread-1")).toBe(false);

    await registry.close();
    expect(closed.stopped).toBe(0);
    expect(live.stopped).toBe(1);
    expect(registry.closed).toBe(true);
  });
});

describe("TurnPublisher", () => {
  it("lets exactly one caller end a turn", () => {
    const publisher = new TurnPublisher({ maxBytes: 4_096, maxItems: 16 });
    const turn = { terminal: false };
    expect(publisher.claimTerminal(turn)).toBe(true);
    expect(publisher.claimTerminal(turn)).toBe(false);
  });

  it("keeps the first failure that made the session unusable", () => {
    const publisher = new TurnPublisher({ maxBytes: 4_096, maxItems: 16 });
    const cause = new OpensteerError({ code: "harness_error", message: "connection lost" });
    publisher.latchUnusable(cause);
    publisher.latchUnusable(new OpensteerError({ code: "harness_error", message: "and again" }));
    expect(publisher.unusable).toBe(cause);
  });

  it("marks the stream closed when an event it must deliver will not fit", () => {
    const publisher = new TurnPublisher({ maxBytes: 8, maxItems: 4 });
    expect(() => publisher.publish(runStartedEvent())).toThrow();
    expect(publisher.streamClosed).toBe(true);
  });

  it("delivers the events it published, in order, and then closes", async () => {
    const publisher = new TurnPublisher({ maxBytes: 4_096, maxItems: 16 });
    publisher.publish(runStartedEvent());
    publisher.publish(runEndedEvent("completed"));
    publisher.closeStream();

    const types: string[] = [];
    for await (const event of publisher.events) types.push(event.type);
    expect(types).toEqual(["run.started", "run.completed"]);
  });
});

describe("providerSecretFile content bounds", () => {
  it("refuses a file larger than the secret could be", async () => {
    const directory = await temporaryDirectory();
    const secret = providerSecretFile(providerState(directory, "isolated"), ".key", {
      description: "endpoint API key",
      maximumBytes: 16,
    });
    await mkdir(join(directory, "home"), { recursive: true });
    await writeFile(secret.path, "x".repeat(64), { mode: 0o600 });

    await expect(secret.read()).rejects.toMatchObject({
      message: "The stored endpoint API key could not be read",
    });
    expect(await readFile(secret.path, "utf8")).toHaveLength(64);
  });
});
