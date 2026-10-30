import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  ComputerAppIdentitySchema,
  ComputerUseActParamsSchema,
  WindowInfoSchema,
  OwnerWindowInfoSchema,
  ComputerUseSessionWindowsParamsSchema,
  ComputerUseSessionBindParamsSchema,
  ComputerUseActResultSchema,
  ComputerUseActionSchema,
  ComputerUseActionsSchema,
  ComputerUseBridgeFrameSchema,
  ComputerUseErrorCodeSchema,
  ComputerUseHelperEnvelopeSchema,
  ComputerUseHelperMethodSchema,
  ComputerUseObservationSchema,
  ComputerUseScreenshotSchema,
  ComputerUseSessionActParamsSchema,
  ComputerUseSessionObserveParamsSchema,
  ComputerUseSessionOpenParamsSchema,
  ComputerUseSessionOpenResultSchema,
  ComputerUseInstalledAppsParamsSchema,
  ComputerUseInstalledAppsResultSchema,
  MachineComputerUseSchema,
  computerAppIdentityKey,
  computerUseHelperProtocolVersion,
  computerUseHelperResults,
  computerUseMaxActions,
  computerUseMaxTimeoutMs,
  computerUsePerformedMaxLength,
  computerUseScreenshotMaxLongSide,
  computerUseScreenshotMaxPixels,
  computerUseTreeMaxBytes,
} from "./computer-use.js";
import {
  ComputerViewOpenCommandSchema,
  ComputerViewSchema,
  macOwnerViewVersion,
} from "./computer-view.js";
import { runnerSupportsComputerUse } from "./runner.js";
import {
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
} from "./computer-apps.js";

const identity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: null,
} as const;

const sessionId = "cus_00000000-0000-4000-8000-000000000001";
/** The app one call targets, as every observe and act now carries it. */
const target = { access: "read-write", identity } as const;

const observation = {
  app: identity,
  capturedAt: "2026-09-21T12:00:00.000Z",
  elementCount: 2,
  focusChanged: false,
  geometry: { width: 900, height: 600 },
  snapshot: "obs-1",
  windows: [],
  blockedBy: [],
  alone: false,
  screenshot: null,
  tree: '[0] window "Notes" (0,0 900x600)\n  [1] button "New" (12,40 64x24)',
  truncated: false,
  window: {
    ref: "window-1",
    id: 42,
    frame: { height: 600, width: 900, x: 120, y: 80 },
    scale: 2,
    title: "Notes",
  },
} as const;

const fence = {
  auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000001",
  bootId: "rbt_00000000-0000-4000-8000-000000000002",
  connectionGeneration: 1,
  connectionId: "rcn_00000000-0000-4000-8000-000000000003",
  connectionLeaseId: "rls_00000000-0000-4000-8000-000000000004",
  module: "integrations",
  runnerId: createId("runner"),
} as const;

const runId = createId("run");

describe("computer app identity", () => {
  it("keys an approval by the lowercased bundle id and refuses an unusable one", () => {
    expect(computerAppIdentityKey(ComputerAppIdentitySchema.parse(identity))).toBe(
      "com.apple.notes",
    );
    expect(
      computerAppIdentityKey(
        ComputerAppIdentitySchema.parse({ ...identity, bundleId: "COM.APPLE.NOTES" }),
      ),
    ).toBe("com.apple.notes");

    expect(ComputerAppIdentitySchema.safeParse({ ...identity, teamId: "ABCDE12345" }).success).toBe(
      true,
    );
    // Ten of the team alphabet, and nothing else: a lowercased or shortened
    // team would name a different signer than the one macOS reports.
    expect(ComputerAppIdentitySchema.safeParse({ ...identity, teamId: "abcde12345" }).success).toBe(
      false,
    );
    expect(ComputerAppIdentitySchema.safeParse({ ...identity, teamId: "ABCDE1234" }).success).toBe(
      false,
    );
    // A NUL cannot survive the C string the Mac resolves the app with.
    expect(
      ComputerAppIdentitySchema.safeParse({ ...identity, bundleId: "com.apple\0.Notes" }).success,
    ).toBe(false);
    expect(ComputerAppIdentitySchema.safeParse({ ...identity, displayName: "" }).success).toBe(
      false,
    );
    expect(ComputerAppIdentitySchema.safeParse({ ...identity, extra: true }).success).toBe(false);
  });
});

describe("computer use actions", () => {
  it("fills the defaults a click leaves out and refuses an unknown action", () => {
    expect(ComputerUseActionSchema.parse({ target: { index: 12 }, type: "click" })).toEqual({
      button: "left",
      count: 1,
      target: { index: 12 },
      type: "click",
    });
    expect(
      ComputerUseActionSchema.parse({
        button: "right",
        count: 2,
        target: { x: 40, y: 12 },
        type: "click",
      }),
    ).toEqual({ button: "right", count: 2, target: { x: 40, y: 12 }, type: "click" });

    expect(ComputerUseActionSchema.safeParse({ type: "drag" }).success).toBe(false);
    expect(ComputerUseActionSchema.safeParse({ type: "launch", app: "Notes" }).success).toBe(false);
    // A target is one thing or the other; naming both is two targets.
    expect(
      ComputerUseActionSchema.safeParse({ target: { index: 1, x: 2, y: 3 }, type: "click" })
        .success,
    ).toBe(false);
    expect(
      ComputerUseActionSchema.safeParse({ count: 4, target: { index: 1 }, type: "click" }).success,
    ).toBe(false);
    expect(ComputerUseActionSchema.safeParse({ ms: 5_001, type: "wait" }).success).toBe(false);
    expect(ComputerUseActionSchema.safeParse({ text: "", type: "type" }).success).toBe(false);
  });

  it("bounds a batch at both ends", () => {
    expect(ComputerUseActionsSchema.safeParse([]).success).toBe(false);
    expect(
      ComputerUseActionsSchema.safeParse(
        Array.from({ length: 32 }, () => ({ keys: "cmd+s", type: "key" })),
      ).success,
    ).toBe(true);
    expect(
      ComputerUseActionsSchema.safeParse(
        Array.from({ length: 33 }, () => ({ keys: "cmd+s", type: "key" })),
      ).success,
    ).toBe(false);
  });

  it("requires an explicit window and nullable snapshot and rejects launch", () => {
    const actions = [{ keys: "cmd+s", type: "key" }];
    expect(
      ComputerUseActParamsSchema.parse({ actions, window: "window-1", snapshot: null }),
    ).toEqual({ actions, window: "window-1", snapshot: null });
    for (const snapshot of [undefined, ""]) {
      expect(
        ComputerUseActParamsSchema.safeParse({ actions, window: "window-1", snapshot }).success,
      ).toBe(false);
      expect(
        ComputerUseSessionActParamsSchema.safeParse({
          actions,
          snapshot,
          window: "window-1",
          app: target,
          sessionId,
        }).success,
      ).toBe(false);
    }
    expect(ComputerUseActParamsSchema.safeParse({ actions, snapshot: null }).success).toBe(false);
    expect(
      ComputerUseActParamsSchema.safeParse({
        actions,
        window: "window-1",
        snapshot: null,
        observationId: "legacy",
      }).success,
    ).toBe(false);
    expect(ComputerUseActionSchema.safeParse({ type: "launch" }).success).toBe(false);
    for (const x of [-1, 1.5])
      expect(
        ComputerUseActionSchema.safeParse({ type: "click", target: { x, y: 1 } }).success,
      ).toBe(false);
  });
});

describe("computer use observation", () => {
  it("round-trips a full snapshot and refuses a tree measured past its budget", () => {
    expect(ComputerUseObservationSchema.parse(observation)).toEqual(observation);
    expect(ComputerUseObservationSchema.safeParse({ ...observation, window: null }).success).toBe(
      false,
    );

    // The cap is bytes, not characters: a tree of astral characters is inside
    // the length bound and well past the budget the frame is measured in.
    const astral = "\u{1F5A5}".repeat(computerUseTreeMaxBytes / 4 + 1);
    expect(astral.length).toBeLessThanOrEqual(computerUseTreeMaxBytes);
    expect(ComputerUseObservationSchema.safeParse({ ...observation, tree: astral }).success).toBe(
      false,
    );
    expect(
      ComputerUseObservationSchema.safeParse({
        ...observation,
        tree: "a".repeat(computerUseTreeMaxBytes + 1),
      }).success,
    ).toBe(false);

    // Nothing here is a difference from anything, so the fields that once said
    // so are refused rather than quietly ignored.
    expect(ComputerUseObservationSchema.safeParse({ ...observation, diff: true }).success).toBe(
      false,
    );
    expect(
      ComputerUseObservationSchema.safeParse({
        ...observation,
        screenshot: {
          base64: "AAAA",
          height: 600,
          mime: "image/png",
          origin: { x: 0, y: 0 },
          width: 900,
        },
      }).success,
    ).toBe(false);
  });
});

describe("computer use errors", () => {
  it("names every refusal the helper and the Host can produce", () => {
    expect(ComputerUseErrorCodeSchema.options).toEqual([
      "permission-required",
      "app-not-allowed",
      "app-not-found",
      "app-not-running",
      "no-session",
      "busy",
      "stale-observation",
      "stopped-by-user",
      "unsupported",
      "failed",
      "outcome-unknown",
      "delivery-unconfirmed",
      "incompatible-version",
    ]);
    expect(ComputerUseErrorCodeSchema.safeParse("invalid-arguments").success).toBe(false);
  });
});

describe("action outcomes", () => {
  it("returns receipts without observing and retains partial progress on failure", () => {
    const performed = ['Clicked "Save"', 'Typed "Venue shortlist" into "Title"'];
    expect(ComputerUseActResultSchema.parse({ error: null, performed })).toEqual({
      error: null,
      performed,
    });
    expect(
      ComputerUseActResultSchema.safeParse({ error: null, observation, performed }).success,
    ).toBe(false);
    const error = { code: "busy", message: "The person is using the app." };
    expect(ComputerUseActResultSchema.parse({ error, performed: performed.slice(0, 1) })).toEqual({
      error,
      performed: performed.slice(0, 1),
    });
    expect(
      ComputerUseActResultSchema.safeParse({
        error: { code: "stale-observation", message: "Observe this window again." },
        performed,
      }).success,
    ).toBe(false);
  });

  it("names each completed action in a bounded, non-empty description", () => {
    const result = (performed: unknown) =>
      ComputerUseActResultSchema.safeParse({ error: null, performed }).success;
    expect(result([])).toBe(true);
    expect(result([""])).toBe(false);
    expect(result(["x".repeat(computerUsePerformedMaxLength + 1)])).toBe(false);
    expect(result(Array.from({ length: computerUseMaxActions + 1 }, () => "Pressed ⌘S"))).toBe(
      false,
    );
    expect(
      ComputerUseActResultSchema.safeParse({ completedActions: 1, error: null, observation })
        .success,
    ).toBe(false);
  });
});

describe("computer use helper protocol", () => {
  it("pairs a result schema with every method the helper answers", () => {
    expect(Object.keys(computerUseHelperResults).sort()).toEqual(
      [...ComputerUseHelperMethodSchema.options].sort(),
    );
  });

  it("round-trips requests, answers, refusals and events", () => {
    const hello = {
      id: 1,
      method: "hello",
      params: { clientVersion: "0.1.79", protocolVersion: computerUseHelperProtocolVersion },
    } as const;
    const act = {
      id: 2,
      method: "session.act",
      params: {
        actions: [{ button: "left", count: 1, target: { index: 3 }, type: "click" }],
        app: target,
        window: "window-1",
        snapshot: "obs-1",
        sessionId,
      },
      timeoutMs: 30_000,
    } as const;
    const nextAct = {
      id: 3,
      method: "session.act",
      params: {
        actions: [{ target: { index: 4 }, text: "Agenda", type: "type" }],
        app: target,
        window: "window-1",
        snapshot: "obs-1",
        sessionId,
      },
    } as const;
    const answer = {
      id: 2,
      result: { error: null, performed: ['Clicked "Save"'] },
    } as const;
    const refusal = {
      error: { code: "stale-observation", message: "Observe Notes again before acting." },
      id: 2,
    } as const;
    const stopped = { event: "session.stopped", params: { reason: "user", sessionId } } as const;

    for (const frame of [hello, act, nextAct, answer, refusal, stopped]) {
      expect(ComputerUseHelperEnvelopeSchema.parse(frame)).toEqual(frame);
    }
    expect(computerUseHelperResults["session.act"].parse(answer.result)).toEqual(answer.result);

    // A hello whose params belong to another method is not a hello.
    expect(
      ComputerUseHelperEnvelopeSchema.safeParse({ id: 1, method: "hello", params: { sessionId } })
        .success,
    ).toBe(false);
    expect(
      ComputerUseHelperEnvelopeSchema.safeParse({ id: 3, method: "session.stop" }).success,
    ).toBe(false);
    // Neither a result nor a refusal may also be the other.
    expect(
      ComputerUseHelperEnvelopeSchema.safeParse({
        error: { code: "failed", message: "No." },
        id: 2,
        result: null,
      }).success,
    ).toBe(false);
  });

  it("carries the helper's methods over the bridge, minus the handshake", () => {
    const request = {
      id: 7,
      kind: "request",
      method: "session.observe",
      params: { app: target, window: "window-1", includeScreenshot: true, sessionId },
      timeoutMs: 29_500,
    } as const;
    const response = { id: 7, kind: "response", result: { observation } } as const;
    const event = {
      event: "session.stopped",
      kind: "event",
      params: { reason: "user", sessionId },
    } as const;

    for (const frame of [request, response, event]) {
      expect(ComputerUseBridgeFrameSchema.parse(frame)).toEqual(frame);
    }
    // The version handshake is desktop main's business with the helper.
    expect(ComputerUseBridgeFrameSchema.safeParse({ ...request, method: "hello" }).success).toBe(
      false,
    );
  });
});

describe("computer use on the integrations stream", () => {
  const computerUse = {
    ...fence,
    access: "read-write",
    app: identity,
    operation: "act",
    params: { actions: [{ keys: "cmd+s", type: "key" }], window: "window-1", snapshot: "obs-1" },
    requestId: "computer-use-1",
    runId,
    sessionId,
    threadTitle: "Plan the offsite",
    timeoutMs: 30_000,
    type: "host.integrations.computer-use",
  } as const;

  it("round-trips the frame pair beside invoke and result", () => {
    expect(HostToIntegrationsModuleMessageSchema.parse(computerUse)).toEqual(computerUse);
    // Required so every sender states it; null is an untitled Thread.
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({ ...computerUse, threadTitle: null })
        .success,
    ).toBe(true);
    const { threadTitle: _threadTitle, ...untitled } = computerUse;
    expect(HostToIntegrationsModuleMessageSchema.safeParse(untitled).success).toBe(false);

    const result = {
      ...fence,
      requestId: "computer-use-1",
      result: { kind: "ok", value: { observation } },
      type: "runner.integrations.computer-use-result",
    } as const;
    expect(IntegrationsModuleEventSchema.parse(result)).toEqual(result);

    const refused = {
      ...fence,
      requestId: "computer-use-1",
      result: {
        code: "busy",
        kind: "error",
        message: "Alex is using Notes. Observe it again before acting.",
      },
      type: "runner.integrations.computer-use-result",
    } as const;
    expect(IntegrationsModuleEventSchema.parse(refused)).toEqual(refused);
  });

  /**
   * The app and the access are the Host's resolution of a connection and a
   * grant, so the two operations that name one app must carry both, and the
   * three that are about the Mac must carry neither.
   */
  it("binds the app and the access to exactly the operations that name one app", () => {
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({ ...computerUse, app: null }).success,
    ).toBe(false);
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({ ...computerUse, access: null }).success,
    ).toBe(false);
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({
        ...computerUse,
        access: null,
        app: null,
        operation: "installed_apps",
        params: {},
      }).success,
    ).toBe(true);
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({
        ...computerUse,
        operation: "permissions",
        params: {},
      }).success,
    ).toBe(false);
  });

  it("refuses a computer-use answer that does not fit the integrations frame", () => {
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        requestId: "computer-use-1",
        result: {
          kind: "ok",
          value: { observation: { ...observation, tree: "a".repeat(1_024 * 1_024) } },
        },
        type: "runner.integrations.computer-use-result",
      }).success,
    ).toBe(false);
  });
});

describe("computer use helper protocol 10", () => {
  it("requires an explicit single permission on the current wire protocol", () => {
    const request = { id: 1, method: "permissions.request" };
    for (const pane of ["screen-recording", "accessibility"]) {
      expect(ComputerUseHelperEnvelopeSchema.parse({ ...request, params: { pane } })).toEqual({
        ...request,
        params: { pane },
      });
    }
    for (const params of [{}, { pane: "all" }, { pane: "screen-recording", extra: true }]) {
      expect(ComputerUseHelperEnvelopeSchema.safeParse({ ...request, params }).success).toBe(false);
    }
  });

  it("opens a session as bookkeeping only, naming no app", () => {
    expect(computerUseHelperProtocolVersion).toBe(10);
    // The app set a session once declared is gone: a list on the open, or on
    // its answer, is a frame from protocol 2 and is refused.
    expect(
      ComputerUseSessionOpenParamsSchema.safeParse({
        apps: [target],
        sessionId,
        threadTitle: null,
      }).success,
    ).toBe(false);
    expect(ComputerUseSessionOpenResultSchema.parse({ sessionId })).toEqual({ sessionId });
    expect(
      ComputerUseSessionOpenResultSchema.safeParse({ apps: [target], sessionId }).success,
    ).toBe(false);
  });

  it("names the app and its access on every observe and act, never a bare bundle id", () => {
    expect(
      ComputerUseSessionObserveParamsSchema.parse({
        app: target,
        includeScreenshot: true,
        window: "window-1",
        sessionId,
      }),
    ).toEqual({
      app: target,
      includeScreenshot: true,
      window: "window-1",
      sessionId,
    });
    expect(
      ComputerUseSessionObserveParamsSchema.safeParse({ app: identity.bundleId, sessionId })
        .success,
    ).toBe(false);
    expect(
      ComputerUseSessionObserveParamsSchema.safeParse({ app: { identity }, sessionId }).success,
    ).toBe(false);
    expect(
      ComputerUseSessionActParamsSchema.safeParse({
        actions: [{ keys: "cmd+s", type: "key" }],
        app: identity.bundleId,
        window: "window-1",
        snapshot: "obs-1",
        sessionId,
      }).success,
    ).toBe(false);
  });

  it("carries one deadline on any helper or bridge request, inside its bound", () => {
    const request = { id: 1, method: "permissions.get", params: {} };
    expect(ComputerUseHelperEnvelopeSchema.safeParse(request).success).toBe(true);
    for (const timeoutMs of [1, computerUseMaxTimeoutMs]) {
      expect(ComputerUseHelperEnvelopeSchema.safeParse({ ...request, timeoutMs }).success).toBe(
        true,
      );
      expect(
        ComputerUseBridgeFrameSchema.safeParse({
          id: 1,
          kind: "request",
          method: "apps.installed",
          params: {},
          timeoutMs,
        }).success,
      ).toBe(true);
    }
    for (const timeoutMs of [0, -1, 1.5, computerUseMaxTimeoutMs + 1]) {
      expect(ComputerUseHelperEnvelopeSchema.safeParse({ ...request, timeoutMs }).success).toBe(
        false,
      );
      expect(
        ComputerUseBridgeFrameSchema.safeParse({
          id: 1,
          kind: "request",
          method: "apps.installed",
          params: {},
          timeoutMs,
        }).success,
      ).toBe(false);
    }
  });

  it("lets typing name its target, and still types into the focus without one", () => {
    expect(ComputerUseActionSchema.parse({ text: "Agenda", type: "type" })).toEqual({
      text: "Agenda",
      type: "type",
    });
    expect(
      ComputerUseActionSchema.parse({ target: { x: 10, y: 20 }, text: "Agenda", type: "type" }),
    ).toEqual({ target: { x: 10, y: 20 }, text: "Agenda", type: "type" });
    expect(
      ComputerUseActionSchema.safeParse({ target: { index: -1 }, text: "Agenda", type: "type" })
        .success,
    ).toBe(false);
  });

  it("bounds a screenshot by its long side and by its pixels", () => {
    const screenshot = { base64: "AAAA", height: 798, mime: "image/jpeg", width: 1_440 } as const;
    expect(screenshot.width * screenshot.height).toBeLessThanOrEqual(
      computerUseScreenshotMaxPixels,
    );
    expect(ComputerUseScreenshotSchema.safeParse(screenshot).success).toBe(true);
    expect(
      ComputerUseScreenshotSchema.safeParse({
        ...screenshot,
        width: computerUseScreenshotMaxLongSide + 1,
      }).success,
    ).toBe(false);
    // Both sides inside the long-side bound, and the picture still too big.
    expect(
      ComputerUseScreenshotSchema.safeParse({ ...screenshot, height: 1_000, width: 1_200 }).success,
    ).toBe(false);
    expect(computerUseTreeMaxBytes).toBe(32_000);
  });
});

describe("computer use discovery and approval push", () => {
  it("carries paginated app identities and optional icons without exposing paths", () => {
    expect(ComputerUseInstalledAppsParamsSchema.parse({})).toEqual({
      query: "",
      limit: 50,
      offset: 0,
      icons: false,
    });
    const result = { apps: [{ identity, running: true }], total: 10 };
    expect(ComputerUseInstalledAppsResultSchema.parse(result)).toEqual(result);
    expect(
      ComputerUseInstalledAppsResultSchema.safeParse({
        apps: [{ identity, running: false, path: "/Applications/Notes.app" }],
        total: 1,
      }).success,
    ).toBe(false);
    expect(ComputerUseInstalledAppsResultSchema.safeParse({ apps: [] }).success).toBe(false);
  });
  it("carries approvals on the bridge, never to the helper, and requires thread title on opens", () => {
    const setupRequestId = "00000000-0000-4000-8000-000000000001";
    const request = {
      id: setupRequestId,
      deploymentId: createId("deployment"),
      ownerUserId: createId("user"),
      runnerId: fence.runnerId,
      definitionId: "macos-app",
      definitionDigest: "digest",
      access: "read",
      kind: "app",
      policyAppApproval: null,
      app: identity,
      reason: "Read the note.",
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
      workspaceName: "Home",
      threadTitle: "Plan",
      createdAt: "2026-09-22T00:00:00.000Z",
      expiresAt: "2026-09-29T00:00:00.000Z",
    };
    const list = { approvalKeyId: null, approvals: [{ request }] };
    expect(
      ComputerUseBridgeFrameSchema.safeParse({
        id: 1,
        kind: "request",
        method: "approvals.list",
        params: list,
      }).success,
    ).toBe(true);
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({
        ...fence,
        ...list,
        type: "host.integrations.computer-app-approvals",
      }).success,
    ).toBe(true);
    const approval = {
      expiresAt: "2026-09-22T00:00:30.000Z",
      requestId: setupRequestId,
      signature: "A".repeat(86),
    };
    const answer = { answer: { approval, kind: "allow" }, setupRequestId };
    expect(
      ComputerUseBridgeFrameSchema.safeParse({
        event: "approval.answer",
        kind: "event",
        params: answer,
      }).success,
    ).toBe(true);
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        ...answer,
        type: "runner.integrations.computer-app-approval-answer",
      }).success,
    ).toBe(true);
    // A signature over one request never answers another.
    const elsewhere = { ...answer, setupRequestId: "00000000-0000-4000-8000-000000000002" };
    expect(
      ComputerUseBridgeFrameSchema.safeParse({
        event: "approval.answer",
        kind: "event",
        params: elsewhere,
      }).success,
    ).toBe(false);
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        ...elsewhere,
        type: "runner.integrations.computer-app-approval-answer",
      }).success,
    ).toBe(false);
    for (const method of ["review_approvals", "approvals.list", "approvals.outcome"]) {
      expect(ComputerUseHelperMethodSchema.safeParse(method).success).toBe(false);
    }
    expect(
      ComputerUseBridgeFrameSchema.safeParse({
        id: 1,
        kind: "request",
        method: "review_approvals",
        params: { setupRequestId },
      }).success,
    ).toBe(false);
    const open = { sessionId, threadTitle: null };
    expect(ComputerUseSessionOpenParamsSchema.parse(open)).toEqual(open);
    expect(
      ComputerUseSessionOpenParamsSchema.safeParse({ ...open, threadTitle: undefined }).success,
    ).toBe(false);
    expect(
      MachineComputerUseSchema.safeParse({
        appApproval: null,
        approvalKeyId: null,
        sessions: [],
        detail: null,
        permissions: null,
        state: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      MachineComputerUseSchema.safeParse({
        appApproval: "ask",
        sessions: [],
        detail: null,
        permissions: null,
        state: "unavailable",
      }).success,
    ).toBe(false);
  });
  it("requires geometry even without a screenshot and rejects the retired event and error", () => {
    expect(
      ComputerUseObservationSchema.safeParse({ ...observation, geometry: undefined }).success,
    ).toBe(false);
    expect(ComputerUseErrorCodeSchema.safeParse("user-intervened").success).toBe(false);
    expect(
      ComputerUseBridgeFrameSchema.safeParse({
        event: "session.intervened",
        kind: "event",
        params: { app: identity.bundleId, sessionId },
      }).success,
    ).toBe(false);
  });
});

describe("window-addressed computer use", () => {
  const window = {
    ref: "window-1",
    id: 42,
    title: "Notes",
    focused: true,
    main: true,
    minimized: false,
    onScreen: true,
    modal: false,
    current: true,
    frame: { x: 0, y: 0, width: 900, height: 600 },
  };
  it("refuses malformed window identities, oversized inventories and leaked owner refs", () => {
    for (const patch of [
      { ref: "" },
      { ref: "x".repeat(129) },
      { id: -1 },
      { id: 1.5 },
      { title: "x".repeat(1025) },
      { current: undefined },
      { extra: true },
    ])
      expect(WindowInfoSchema.safeParse({ ...window, ...patch }).success).toBe(false);
    const { ref: _ref, frame: _frame, modal: _modal, current: _current, ...owner } = window;
    expect(OwnerWindowInfoSchema.parse(owner)).toEqual(owner);
    expect(OwnerWindowInfoSchema.safeParse({ ...owner, ref: window.ref }).success).toBe(false);
    expect(
      computerUseHelperResults["session.windows"].safeParse({ windows: Array(65).fill(window) })
        .success,
    ).toBe(false);
    expect(
      ComputerUseObservationSchema.safeParse({
        ...observation,
        blockedBy: Array(9).fill({ id: 1, title: "Save", kind: "dialog" }),
      }).success,
    ).toBe(false);
    expect(
      ComputerUseObservationSchema.safeParse({ ...observation, observationId: "legacy" }).success,
    ).toBe(false);
    expect(ComputerUseActionSchema.safeParse({ type: "wait", ms: 1 }).success).toBe(false);
  });
  it("claims and binds windows explicitly, including the current-window selector", () => {
    expect(ComputerUseSessionWindowsParamsSchema.parse({ sessionId, app: target })).toEqual({
      sessionId,
      app: target,
    });
    for (const selected of [null, 42])
      expect(
        ComputerUseSessionBindParamsSchema.parse({ sessionId, app: target, window: selected })
          .window,
      ).toBe(selected);
    for (const selected of [undefined, -1, 1.5, "window-1"])
      expect(
        ComputerUseSessionBindParamsSchema.safeParse({ sessionId, app: target, window: selected })
          .success,
      ).toBe(false);
    expect(computerUseHelperResults["session.bind"].parse({ window })).toEqual({ window });
    expect(computerUseHelperResults["session.windows"].parse({ windows: [window] })).toEqual({
      windows: [window],
    });
  });
});

describe("owner window compatibility", () => {
  it("requires version 3 for exact-window opens and keeps response readers tolerant", () => {
    expect(macOwnerViewVersion).toBe(3);
    const command = {
      type: "computer.view.open",
      machineId: fence.runnerId,
      target: { kind: "app", app: identity, window: 42 },
      idempotencyKey: "open-window",
    };
    expect(ComputerViewOpenCommandSchema.parse(command)).toEqual(command);
    for (const window of [-1, 1.5, "42"])
      expect(
        ComputerViewOpenCommandSchema.safeParse({
          ...command,
          target: { ...command.target, window },
        }).success,
      ).toBe(false);
    const view = {
      connectionId: "connection",
      machineId: fence.runnerId,
      target: command.target,
      viewId: "cvw_00000000-0000-4000-8000-000000000001",
      generation: 1,
      state: "ready",
      window: { id: 42, title: "Notes", future: true },
      openedAt: "2026-10-26T00:00:00.000Z",
      expiresAt: "2026-10-26T00:10:00.000Z",
      unavailableReason: null,
      future: true,
    };
    expect(ComputerViewSchema.parse(view).window).toEqual({ id: 42, title: "Notes" });
    expect(ComputerViewSchema.parse({ ...view, window: undefined }).window).toBeNull();
    expect(
      runnerSupportsComputerUse({ platform: "darwin", protocolVersion: 5, computerUseVersion: 2 }),
    ).toBe(true);
    for (const module of [
      undefined,
      { platform: "darwin" as const, protocolVersion: 5 },
      { platform: "android" as const, protocolVersion: 4, computerUseVersion: 2 as const },
    ])
      expect(runnerSupportsComputerUse(module)).toBe(false);
  });
});
