import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { HarnessSetupMethod, HostApiCommandOutput } from "@opensteer/protocol";
import type { HarnessAuthenticationEnvelope, HostSnapshot } from "./client.js";
import { startAccountSignIn, type AccountSignInTarget } from "./harness-authentication.js";

const environmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");
const duplicateId = createId("harnessInstance");

const methods: HarnessSetupMethod[] = [
  { kind: "device-code", methodId: "device", label: "Device", connectionSlot: "primary" },
  { kind: "device-code", methodId: "other", label: "Other", connectionSlot: "secondary" },
];
const request = {
  type: "harness.create",
  environmentId: environmentId,
  driverKind: "codex",
  sourceId: "openai",
  stateKind: "isolated",
  name: "Codex 2",
  idempotencyKey: "create-account",
} as const;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  options: {
    existing?: boolean;
    holdCreate?: boolean;
    loseCreateAnswer?: boolean;
    holdBegin?: boolean;
    holdCancel?: boolean;
    duplicate?: boolean;
    disabledDuplicate?: boolean;
    readyCatalog?: boolean;
    refuseRemoval?: boolean;
    refuseCancel?: boolean;
    setupMethods?: HarnessSetupMethod[];
    catalogStatus?: string;
    allowed?: boolean;
  } = {},
) {
  const harness = {
    id: harnessInstanceId,
    environmentId: environmentId,
    driverKind: "codex",
    name: "Codex 2",
    enabled: true,
    isDefault: false,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated" as const,
  };
  let accounts = options.existing ? [harness] : [];
  if (options.duplicate)
    accounts = [{ ...harness, id: duplicateId, enabled: !options.disabledDuplicate }, ...accounts];
  const connection = { status: "connected", accountLabel: "person@example.com" };
  const makeCatalog = (status = options.catalogStatus ?? "authentication-required") => ({
    harnessInstanceId: harness.id,
    driverKind: "codex",
    status,
    detail: "Sign in to this account",
    models: [],
    connections: status === "ready" ? [connection] : [],
    setupMethods: options.setupMethods ?? methods,
  });
  let catalogs = options.existing ? [makeCatalog()] : [];
  if (options.duplicate)
    catalogs = [{ ...makeCatalog("ready"), harnessInstanceId: duplicateId }, ...catalogs];
  let envelope: HarnessAuthenticationEnvelope = {
    environmentStatus: "connected",
    authentication: {
      status: "pending",
      challenge: {
        kind: "device-code",
        userCode: "ABCD-1234",
        verificationUrl: "https://example.com/device",
      },
    },
  };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const create = deferred<void>();
  const begin = deferred<void>();
  const cancelResponse = deferred<void>();
  const attempts = new Set<string>();
  const slots: string[] = [];
  const client: Parameters<typeof startAccountSignIn>[0]["client"] = {
    getSnapshot: () =>
      ({
        harnesses: accounts,
        environments: [
          {
            id: environmentId,
            harnessAuthenticationAllowed: options.allowed ?? true,
            harnessCatalogs: catalogs,
          },
        ],
      }) as unknown as HostSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: vi.fn(async () => undefined),
    rpc: { "harness.authentication.get": async () => ({ ok: true, data: envelope }) },
    dispatch: async (command): Promise<HostApiCommandOutput> => {
      switch (command.type) {
        case "harness.create": {
          if (options.holdCreate) await create.promise;
          if (!accounts.some((item) => item.id === harness.id)) {
            accounts = [...accounts, harness];
            catalogs = [...catalogs, makeCatalog()];
            changed();
          }
          if (options.loseCreateAnswer) {
            options.loseCreateAnswer = false;
            throw new Error("The connection dropped");
          }
          return { type: command.type, harness: { ...harness, config: {} } };
        }
        case "harness.authentication.begin": {
          if (options.holdBegin && command.methodId === "device") await begin.promise;
          attempts.add(command.methodId);
          slots.push(command.connectionSlot ?? "");
          return { ...envelope, type: command.type };
        }
        case "harness.authentication.submit":
          return { ...envelope, type: command.type };
        case "harness.authentication.cancel": {
          if (options.refuseCancel) throw new Error("Cancellation refused");
          attempts.clear();
          if (options.holdCancel) await cancelResponse.promise;
          return {
            type: command.type,
            authentication: { status: "not-started" },
            environmentStatus: "connected",
          };
        }
        case "harness.delete": {
          if (options.refuseRemoval) throw new Error("Removal refused; account retained");
          accounts = accounts.filter((item) => item.id !== command.harnessInstanceId);
          catalogs = catalogs.filter(
            (item) => item.harnessInstanceId !== command.harnessInstanceId,
          );
          changed();
          return { type: command.type };
        }
        default:
          throw new Error(`Unexpected ${command.type}`);
      }
    },
  };
  const target: AccountSignInTarget = options.existing
    ? { kind: "existing", environmentId: environmentId, harnessInstanceId: harness.id }
    : { kind: "create", request };
  const flow = startAccountSignIn({
    client,
    target,
    errorMessage: (cause) => (cause instanceof Error ? cause.message : "Failed"),
  });
  return {
    flow,
    attempts,
    slots,
    client,
    accounts: () => accounts,
    listeners: () => listeners.size,
    resolveCreate: () => create.resolve(),
    resolveBegin: () => begin.resolve(),
    resolveCancel: () => cancelResponse.resolve(),
    status(environmentStatus: "connected" | "disconnected", status: "not-started" | "ready") {
      envelope = { environmentStatus, authentication: { status } };
      if (status === "ready" && options.readyCatalog !== false) {
        catalogs = catalogs.map((item) =>
          item.harnessInstanceId === harness.id ? makeCatalog("ready") : item,
        );
        changed();
      }
    },
    updateCatalog(status: string) {
      catalogs = catalogs.map((item) =>
        item.harnessInstanceId === harness.id ? makeCatalog(status) : item,
      );
      changed();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("account sign-in ownership", () => {
  it("removes an account whose create committed though its answer was lost", async () => {
    const test = fixture({ loseCreateAnswer: true });
    await flush();
    expect(test.flow.getState()).toMatchObject({ kind: "failed" });
    expect(test.accounts()).toHaveLength(1);
    await test.flow.cancel();
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
    expect(test.accounts()).toHaveLength(0);
  });

  it("owns a create that resolves after cancellation", async () => {
    const test = fixture({ holdCreate: true, holdBegin: true });
    const cancelled = test.flow.cancel();
    expect(test.flow.cancel()).toBe(cancelled);
    test.resolveCreate();
    test.resolveBegin();
    await cancelled;
    expect(test.accounts()).toEqual([]);
    expect([...test.attempts]).toEqual([]);
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
    test.updateCatalog("ready");
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
    expect(test.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans a late begin even after cancel overtakes it at the five-second bound", async () => {
    const test = fixture({ holdBegin: true });
    await flush();
    const cancelled = test.flow.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    test.resolveBegin();
    await cancelled;
    expect(test.accounts()).toEqual([]);
    expect([...test.attempts]).toEqual([]);
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never removes an existing account on cancel", async () => {
    const test = fixture({ existing: true, holdBegin: true });
    const cancelled = test.flow.cancel();
    test.resolveBegin();
    await cancelled;
    expect(test.accounts()).toHaveLength(1);
    expect([...test.attempts]).toEqual([]);
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
  });

  it("releases a late begin even when the earlier cancel response arrives last", async () => {
    const test = fixture({ existing: true, holdBegin: true, holdCancel: true });
    const cancelled = test.flow.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    test.resolveBegin();
    await flush();
    test.resolveCancel();
    await cancelled;
    expect([...test.attempts]).toEqual([]);
    expect(test.accounts()).toHaveLength(1);
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
  });

  it("releases the old method before beginning its replacement, including late ensures", async () => {
    const test = fixture({ holdBegin: true, existing: true });
    test.flow.chooseMethod("other");
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...test.attempts]).toEqual([]);
    test.resolveBegin();
    await flush();
    expect([...test.attempts]).toEqual(["other"]);
    expect(test.slots).toEqual(["primary", "secondary"]);
    expect(test.flow.getState()).toMatchObject({ kind: "signing-in", methodId: "other" });
    await test.flow.cancel();
  });

  it("reports cleanup failure instead of claiming an existing attempt was cancelled", async () => {
    const test = fixture({ existing: true, refuseCancel: true });
    await flush();
    await test.flow.cancel();
    expect(test.flow.getState()).toEqual({ kind: "failed", message: "Cancellation refused" });
    expect(test.accounts()).toHaveLength(1);
    expect(test.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("account completion", () => {
  it("finishes removing a duplicate when Try again follows a refused removal", async () => {
    const options = { duplicate: true, refuseRemoval: true };
    const test = fixture(options);
    await flush();
    test.status("connected", "ready");
    await vi.advanceTimersByTimeAsync(1_500);
    await test.flow.removeDuplicate();
    expect(test.flow.getState()).toMatchObject({ kind: "failed" });
    expect(test.accounts()).toHaveLength(2);

    options.refuseRemoval = false;
    test.flow.retry();
    await flush();
    expect(test.flow.getState()).toEqual({ kind: "cancelled" });
    expect(test.accounts()).toHaveLength(1);
  });

  it("waits for a duplicate decision without deleting anything, then keeps both", async () => {
    const test = fixture({ duplicate: true });
    await flush();
    test.status("connected", "ready");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(test.flow.getState()).toMatchObject({
      kind: "duplicate",
      accountLabel: "person@example.com",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.accounts()).toHaveLength(2);
    expect(test.listeners()).toBe(0);
    test.flow.keepDuplicate();
    await test.flow.cancel();
    expect(test.flow.getState()).toMatchObject({ kind: "done" });
    expect(test.accounts()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "removes a duplicate only on request (removal refused: %s)",
    async (refuseRemoval) => {
      const test = fixture({ duplicate: true, refuseRemoval });
      await flush();
      test.status("connected", "ready");
      await vi.advanceTimersByTimeAsync(1_500);
      await test.flow.removeDuplicate();
      expect(test.accounts()).toHaveLength(refuseRemoval ? 2 : 1);
      expect(test.flow.getState()).toMatchObject(
        refuseRemoval
          ? { kind: "failed", message: "Removal refused; account retained" }
          : { kind: "cancelled" },
      );
    },
  );

  it("ignores disabled duplicates and existing-account duplicates", async () => {
    for (const options of [
      { duplicate: true, disabledDuplicate: true },
      { duplicate: true, existing: true },
    ]) {
      const test = fixture(options);
      await flush();
      test.status("connected", "ready");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(test.flow.getState()).toMatchObject({
        kind: "done",
        accountLabel: "person@example.com",
      });
    }
  });

  it("finishes with no label after fifteen seconds even if refresh is stuck", async () => {
    const test = fixture({ readyCatalog: false });
    await flush();
    vi.mocked(test.client.refresh).mockImplementation(() => new Promise<void>(() => undefined));
    test.status("connected", "ready");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(test.flow.getState()).toMatchObject({ kind: "finishing" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.flow.getState()).toMatchObject({ kind: "done", accountLabel: null });
    expect(test.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers when a disconnected Runner returns during sign-in", async () => {
    const test = fixture();
    await flush();
    test.status("disconnected", "not-started");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(test.flow.getState()).toMatchObject({
      kind: "signing-in",
      session: { view: { kind: "disconnected" } },
    });
    test.status("connected", "not-started");
    await vi.advanceTimersByTimeAsync(4_500);
    test.status("connected", "ready");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(test.flow.getState()).toMatchObject({
      kind: "done",
      accountLabel: "person@example.com",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds watching even when the Runner never reconnects", async () => {
    const test = fixture();
    await flush();
    test.status("disconnected", "not-started");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(test.flow.getState()).toMatchObject({
      kind: "signing-in",
      error: expect.stringContaining("timed out"),
    });
    await test.flow.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "unavailable"])("surfaces the catalog's %s detail", async (catalogStatus) => {
    const test = fixture({ catalogStatus });
    await flush();
    expect(test.flow.getState()).toEqual({ kind: "failed", message: "Sign in to this account" });
    await test.flow.cancel();
  });

  it.each([{ setupMethods: [] }, { allowed: false }])(
    "uses the catalog detail when sign-in cannot be offered: %o",
    async (options) => {
      const test = fixture(options);
      await flush();
      expect(test.flow.getState()).toEqual({ kind: "failed", message: "Sign in to this account" });
      await test.flow.cancel();
    },
  );

  it("finishes a freshly created account that is already ready without starting sign-in", async () => {
    const test = fixture({ catalogStatus: "ready", setupMethods: [] });
    await flush();
    expect(test.flow.getState()).toMatchObject({
      kind: "done",
      accountLabel: "person@example.com",
    });
    expect([...test.attempts]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits on preparing catalogs and automatically imports a local credential", async () => {
    const test = fixture({
      catalogStatus: "preparing",
      setupMethods: [
        { kind: "local-import", methodId: "device", label: "Use local", connectionSlot: "local" },
      ],
    });
    await flush();
    expect(test.flow.getState()).toEqual({ kind: "preparing" });
    test.updateCatalog("authentication-required");
    await flush();
    expect(test.slots).toEqual(["local"]);
    await test.flow.cancel();
  });
});
