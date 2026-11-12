import { describe, expect, it, vi } from "vitest";
import type {
  PersonalRemoteAdministrationIntent,
  PersonalRemoteAdministrationOperation,
  PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import { HostClientRequestError } from "./client.js";
import {
  RemoteAccessPortError,
  RemoteAccessRunner,
  remoteAccessActionGoal,
  remoteAccessView,
  type RemoteAccessFacts,
  type RemoteAccessPort,
  type RemoteAccessRunState,
} from "./remote-access.js";

type Access = PersonalRemoteAdministrationStatus["access"];
const route = (origin: string) =>
  ({ document: { route: { origin } } }) as unknown as NonNullable<Access["route"]>;
const active = { state: "active" } as Access["accountLink"];
const activating = { state: "activating" } as Access["accountLink"];

function status(
  access: Partial<Access> = {},
  overrides: Partial<PersonalRemoteAdministrationStatus> = {},
): PersonalRemoteAdministrationStatus {
  return {
    access: {
      accountLink: active,
      generation: 1,
      mode: "off",
      route: null,
      schemaVersion: 2,
      ...access,
    },
    accountIssuer: "https://accounts.opensteer.test",
    executorConnected: true,
    operation: null,
    revision: 1,
    ...overrides,
  } as PersonalRemoteAdministrationStatus;
}

function operation(
  intent: PersonalRemoteAdministrationIntent,
  state: PersonalRemoteAdministrationOperation["state"],
  detail: string | null = null,
): PersonalRemoteAdministrationOperation {
  const id = crypto.randomUUID();
  return { detail, executionId: id, id, intent, state } as PersonalRemoteAdministrationOperation;
}

const connect = { action: "configure", mode: "connect", privateOrigin: null } as const;
const off = { action: "configure", mode: "off", privateOrigin: null } as const;

function facts(overrides: Partial<RemoteAccessFacts> = {}): RemoteAccessFacts {
  return {
    computerName: "Studio Mac",
    link: null,
    signedIn: null,
    status: status(),
    statusUnreadable: false,
    ...overrides,
  };
}

const on = status({ mode: "connect", route: route("https://studio.connect.test") });
const running = (goal: "turn-on", step: "sign-in" | "link"): RemoteAccessRunState => ({
  goal,
  kind: "running",
  step,
});

describe("remoteAccessView", () => {
  it.each<{
    readonly name: string;
    readonly facts: RemoteAccessFacts;
    readonly run?: RemoteAccessRunState;
    readonly expected: Record<string, unknown>;
  }>([
    {
      name: "loading",
      facts: facts({ status: null }),
      expected: { state: "loading", title: "Checking…", primary: null },
    },
    {
      name: "status unreadable",
      facts: facts({ status: null, statusUnreadable: true }),
      expected: { state: "unreadable", tone: "attention", primary: null },
    },
    {
      name: "Connect unavailable in this build",
      facts: facts({ status: status({ accountLink: null }, { accountIssuer: null }) }),
      expected: { state: "connect-unavailable", primary: null },
    },
    {
      name: "off",
      facts: facts(),
      expected: {
        state: "off",
        title: "Off",
        sentence: "Only Studio Mac can use Opensteer.",
        primary: { id: "turn-on", label: "Turn on", confirm: null },
        on: false,
      },
    },
    {
      name: "off, without a name",
      facts: facts({ computerName: null }),
      expected: { sentence: "Only this computer can use Opensteer." },
    },
    {
      name: "off and signed out: Turn on signs in first",
      facts: facts({ signedIn: false, status: status({ accountLink: null }) }),
      expected: { state: "off-signed-out", primary: { id: "turn-on" } },
    },
    {
      name: "turning on, on this device",
      facts: facts({ signedIn: false, status: status({ accountLink: null }) }),
      run: running("turn-on", "sign-in"),
      expected: {
        state: "turning-on",
        tone: "busy",
        sentence: "Finish signing in to your Opensteer account.",
        secondary: [{ id: "cancel", label: "Cancel", confirm: null }],
        steps: [
          { label: "Sign in to your Opensteer account", state: "active" },
          { label: "Add Studio Mac to your account", state: "todo" },
          { label: "Turn on the connection", state: "todo" },
        ],
      },
    },
    {
      name: "turning on, started on another device",
      facts: facts({
        status: status(
          {},
          { operation: operation(connect, "running", "Setting up the connection…") },
        ),
      }),
      expected: {
        state: "turning-on",
        sentence: "Setting up the connection…",
        steps: [
          { label: "Add Studio Mac to your account", state: "done" },
          { label: "Turn on the connection", state: "active" },
        ],
      },
    },
    {
      name: "waiting for the computer's app while a change is outstanding",
      facts: facts({
        status: status({}, { executorConnected: false, operation: operation(connect, "pending") }),
      }),
      expected: {
        state: "waiting-for-app",
        sentence: "Open Opensteer on Studio Mac to finish this change.",
        secondary: [{ id: "cancel" }],
      },
    },
    {
      name: "no executor and nothing outstanding is just the state",
      facts: facts({ status: status({}, { executorConnected: false }) }),
      expected: { state: "off" },
    },
    {
      name: "on via Connect",
      facts: facts({ status: on }),
      expected: {
        state: "on-connect",
        tone: "on",
        on: true,
        address: "https://studio.connect.test",
        sentence: "Your phone and signed-in computers can open Studio Mac from anywhere.",
        primary: { id: "turn-off", label: "Turn off" },
        secondary: [{ id: "reset-key" }, { id: "remove-link" }],
      },
    },
    {
      name: "on via private network",
      facts: facts({
        status: status({ mode: "private", route: route("https://studio.tailnet.test") }),
      }),
      expected: {
        state: "on-private",
        address: "https://studio.tailnet.test",
        primary: { id: "add-device", label: "Add a device" },
        secondary: [{ id: "turn-off" }],
      },
    },
    {
      name: "failed turn-on",
      facts: facts({
        status: status(
          {},
          { operation: operation(connect, "failed", "Couldn’t reach Opensteer.") },
        ),
      }),
      expected: {
        state: "turn-on-failed",
        title: "Couldn’t turn on",
        sentence: "Couldn’t reach Opensteer.",
        primary: { id: "try-again", label: "Try again" },
      },
    },
    {
      name: "failed turn-off while access is still on",
      facts: facts({
        status: { ...on, operation: operation(off, "failed", "Couldn’t reach Opensteer.") },
      }),
      expected: {
        state: "change-failed",
        title: "Couldn’t turn off",
        on: true,
        sentence: "Couldn’t reach Opensteer. Studio Mac can still be opened from anywhere.",
        primary: { id: "try-again" },
        secondary: [],
      },
    },
    {
      name: "failed key reset while on",
      facts: facts({ status: { ...on, operation: operation({ action: "rotate" }, "failed") } }),
      expected: {
        state: "change-failed",
        title: "Couldn’t reset",
        secondary: [{ id: "turn-off" }],
      },
    },
    {
      name: "failed link removal while on",
      facts: facts({ status: { ...on, operation: operation({ action: "unlink" }, "failed") } }),
      expected: { state: "change-failed", title: "Couldn’t remove" },
    },
    {
      name: "a failed turn-on that came true anyway no longer stands",
      facts: facts({ status: { ...on, operation: operation(connect, "failed") } }),
      expected: { state: "on-connect" },
    },
    {
      name: "a link left activating",
      facts: facts({ status: status({ accountLink: activating }) }),
      expected: {
        state: "link-activating",
        primary: { id: "finish-adding", label: "Finish adding" },
        secondary: [{ id: "remove-link" }],
      },
    },
    {
      name: "a link that needs repair",
      facts: facts({ link: "needs-repair" }),
      expected: { state: "link-needs-repair", primary: { id: "repair-link" } },
    },
    {
      name: "linked to another account",
      facts: facts({ link: "linked-elsewhere" }),
      expected: { state: "linked-elsewhere", primary: { id: "remove-link", label: "Remove link" } },
    },
    {
      name: "removing the link",
      facts: facts({
        status: status({}, { operation: operation({ action: "unlink" }, "running") }),
      }),
      expected: { state: "removing-link", tone: "busy", primary: null },
    },
    {
      name: "turning off keeps no other action",
      facts: facts({ status: { ...on, operation: operation(off, "running") } }),
      expected: { state: "turning-off", primary: null, secondary: [] },
    },
    {
      name: "a local failure before anything was sent",
      facts: facts(),
      run: { goal: "turn-on", kind: "failed", message: "Signing in didn’t finish. Try again." },
      expected: { state: "turn-on-failed", sentence: "Signing in didn’t finish. Try again." },
    },
  ])("$name", ({ expected, facts: input, run }) => {
    expect(remoteAccessView(input, run)).toMatchObject(expected);
  });

  it("asks before every action that signs devices out, and only those", () => {
    const view = remoteAccessView(facts({ status: on }));
    expect([view.primary, ...view.secondary].map((action) => action?.confirm !== null)).toEqual([
      true,
      true,
      true,
    ]);
    expect(remoteAccessView(facts()).primary?.confirm).toBeNull();
  });

  it("tries a failed change again as the change that failed", () => {
    const failedOff = facts({ status: { ...on, operation: operation(off, "failed") } });
    expect(remoteAccessActionGoal("try-again", failedOff, { kind: "idle" })).toBe("turn-off");
    expect(
      remoteAccessActionGoal("try-again", facts(), {
        goal: "remove-link",
        kind: "failed",
        message: "x",
      }),
    ).toBe("remove-link");
  });
});

/** A Host whose status changes only when the test says so. */
function harness(
  initial: RemoteAccessFacts,
  port: Partial<RemoteAccessPort> = {},
  settleMilliseconds = 1_000,
) {
  let current = initial;
  const requests: PersonalRemoteAdministrationIntent[] = [];
  const request = vi.fn(async (intent: PersonalRemoteAdministrationIntent) => {
    requests.push(intent);
    const sent = operation(intent, "pending");
    queueMicrotask(() =>
      runner.update(
        (current = {
          ...current,
          status: current.status && { ...current.status, operation: sent },
        }),
      ),
    );
    return sent;
  });
  const fullPort: RemoteAccessPort = {
    link: vi.fn(async () => {}),
    ...port,
  };
  const runner = new RemoteAccessRunner({
    facts: initial,
    port: fullPort,
    request,
    settleMilliseconds,
  });
  const states: RemoteAccessRunState[] = [];
  runner.subscribe(() => states.push(runner.getSnapshot()));
  const settled = () =>
    vi.waitFor(
      () => {
        const state = runner.getSnapshot();
        if (state.kind === "running") throw new Error(`The runner is still at ${state.step}`);
        return state;
      },
      { timeout: 2_000 },
    );
  const set = (next: Partial<RemoteAccessFacts>) =>
    runner.update((current = { ...current, ...next }));
  return { port: fullPort, request, requests, runner, set, settled, states };
}

describe("RemoteAccessRunner", () => {
  it("finishes an activating link through resume, never a fresh link, then turns on", async () => {
    const test = harness(facts({ status: status({ accountLink: activating }) }));
    vi.mocked(test.port.link).mockImplementation(async () => {
      test.set({ status: status() });
    });
    test.runner.start("turn-on");
    await expect(test.settled()).resolves.toEqual({ kind: "idle" });
    expect(test.port.link).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ activating: true }),
    );
    expect(test.requests).toEqual([connect]);
  });

  it("skips Account sign-in and linking for an already active link", async () => {
    const signIn = vi.fn(async () => {});
    const test = harness(facts({ signedIn: false }), { signIn });
    test.runner.start("turn-on");
    await test.settled();
    expect(signIn).not.toHaveBeenCalled();
    expect(test.port.link).not.toHaveBeenCalled();
    expect(test.requests).toEqual([connect]);
  });

  it("signs in, links, then turns on, each only once", async () => {
    const test = harness(facts({ signedIn: false, status: status({ accountLink: null }) }), {
      signIn: async () => test.set({ signedIn: true }),
    });
    vi.mocked(test.port.link).mockImplementation(async () => test.set({ status: status() }));
    test.runner.start("turn-on");
    await expect(test.settled()).resolves.toEqual({ kind: "idle" });
    expect(test.states.flatMap((state) => (state.kind === "running" ? [state.step] : []))).toEqual([
      "sign-in",
      "link",
      "request",
    ]);
  });

  it("joins a turn-on another device already started instead of sending a second", async () => {
    const test = harness(
      facts({ status: status({}, { operation: operation(connect, "running") }) }),
    );
    test.runner.start("turn-on");
    await expect(test.settled()).resolves.toEqual({ kind: "idle" });
    expect(test.request).not.toHaveBeenCalled();
  });

  it("sends a failed change again as recover, so it keeps its identity", async () => {
    const test = harness(
      facts({ status: status({}, { operation: operation(connect, "failed") }) }),
    );
    test.runner.start("turn-on");
    await test.settled();
    expect(test.requests).toEqual([{ action: "recover" }]);
  });

  it("lets Off supersede a pending turn-on rather than failing", async () => {
    const test = harness(
      facts({
        status: status({}, { executorConnected: false, operation: operation(connect, "pending") }),
      }),
    );
    test.runner.start("turn-off");
    await expect(test.settled()).resolves.toEqual({ kind: "idle" });
    expect(test.requests).toEqual([off]);
  });

  it("stops undispatched steps when stopped mid-flow, and never sends the change", async () => {
    let signal: AbortSignal | undefined;
    const test = harness(facts({ status: status({ accountLink: null }) }));
    vi.mocked(test.port.link).mockImplementation(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          // The link answers after the person left; nothing must follow it.
          input.signal.addEventListener("abort", () => {
            test.set({ status: status() });
            resolve();
          });
        }),
    );
    test.runner.start("turn-on");
    await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 1_000 });
    test.runner.stop();
    await expect(test.settled()).resolves.toEqual({ kind: "idle" });
    expect(signal?.aborted).toBe(true);
    expect(test.request).not.toHaveBeenCalled();
  });

  it("reports a step that never shows up instead of repeating it", async () => {
    const test = harness(facts({ status: status({ accountLink: activating }) }), {}, 20);
    test.runner.start("turn-on");
    await expect(test.settled()).resolves.toEqual({
      goal: "turn-on",
      kind: "failed",
      message: "Couldn’t add Studio Mac to your account. Try again.",
    });
    expect(test.port.link).toHaveBeenCalledOnce();
  });

  it("shows the Host's refusal and the port's own sentence, never a raw fault", async () => {
    const refused = harness(facts());
    refused.request.mockRejectedValueOnce(
      new HostClientRequestError({
        code: "conflict",
        message: "Already in progress.",
        status: 409,
      }),
    );
    refused.runner.start("turn-on");
    await expect(refused.settled()).resolves.toMatchObject({ message: "Already in progress." });

    const cancelled = harness(facts({ status: status({ accountLink: null }) }));
    vi.mocked(cancelled.port.link).mockRejectedValueOnce(
      new RemoteAccessPortError("Signing in was cancelled."),
    );
    cancelled.runner.start("turn-on");
    await expect(cancelled.settled()).resolves.toMatchObject({
      message: "Signing in was cancelled.",
    });

    const raw = harness(facts({ status: status({ accountLink: null }) }));
    vi.mocked(raw.port.link).mockRejectedValueOnce(new Error("ECONNRESET /Users/tim/secret"));
    raw.runner.start("turn-on");
    await expect(raw.settled()).resolves.toMatchObject({
      message: "Couldn’t add Studio Mac to your account. Try again.",
    });
  });

  it("drops a failure once what it tried is true anyway", async () => {
    const test = harness(facts({ status: status({ accountLink: null }) }));
    vi.mocked(test.port.link).mockRejectedValueOnce(new RemoteAccessPortError("No."));
    test.runner.start("turn-on");
    await expect(test.settled()).resolves.toMatchObject({ kind: "failed" });
    test.set({ status: on });
    expect(test.runner.getSnapshot()).toEqual({ kind: "idle" });
  });
});
