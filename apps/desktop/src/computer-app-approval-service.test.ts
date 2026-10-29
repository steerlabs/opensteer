import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import type { ComputerAppSetupRequest } from "@opensteer/integration-core";
import type {
  ComputerAppApprovalAnswerFrame,
  ComputerAppApprovalPrompt,
  ComputerUseResolvedApp,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ComputerAppApprovalService,
  computerAppApprovalKeyMissingSentence,
  type ComputerAppApprovalPresentation,
} from "./computer-app-approval-service.js";

const deploymentId = DeploymentIdSchema.parse("dep_2f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071");
const otherDeploymentId = DeploymentIdSchema.parse("dep_3a4b5c6d-7e8f-4901-8a2b-3c4d5e6f7081");
const runnerId = "rnr_5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const threadId = "thr_6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e1f";
const workspaceId = "wsp_7f8091a2-b3c4-4d5e-8f60-7a8b9c0d1e2f";
const keyId = `sha256:${"k".repeat(43)}`;
const notesId = "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const calendarId = "8d2b3c5d-6e7f-4a91-8b2c-3d4e5f607182";
/** What a picker or policy request carries: no task asked for it. */
const noTask = {
  reason: null,
  threadId: null,
  threadTitle: null,
  workspaceId: null,
  workspaceName: null,
} as const;

describe("showing the approvals a Runner relays", () => {
  it("verifies the target before it resolves or shows anything, and never asks it again while listed", async () => {
    const harness = approvalHarness();
    harness.local.assertComputerAppSetupTarget.mockRejectedValue(
      new Error("Computer app setup request does not target this Mac's enrolled Runner"),
    );

    harness.list([prompt(setupRequest())]);
    await harness.idle();
    harness.list([prompt(setupRequest())]);
    await harness.idle();

    expect(harness.resolveApp).not.toHaveBeenCalled();
    expect(harness.panels).toEqual([]);
    expect(harness.answers).toEqual([]);
    expect(harness.local.assertComputerAppSetupTarget).toHaveBeenCalledOnce();
  });

  it("shows the app the helper resolved, names the task, and signs with the approval key", async () => {
    const harness = approvalHarness();

    harness.list([prompt(setupRequest(), "Main")]);
    const panel = await harness.panel();

    // The bundle identifier goes to the Mac; the panel shows the identity the
    // request names, as this Mac resolved it.
    expect(harness.resolveApp).toHaveBeenCalledWith("com.apple.Notes");
    expect(panel.presentation).toEqual({
      access: "read-write",
      accessLabel: "Can see and control",
      accessSummary: expect.any(String),
      app: {
        bundleId: "com.apple.Notes",
        displayName: "Notes",
        iconPng: "aWNvbg==",
        path: "/System/Applications/Notes.app",
        reason: "Operating this app reaches past the app itself.",
        risk: "elevated",
      },
      deploymentName: "Alex's Deployment",
      kind: "app",
      machineName: "Alex's MacBook Pro",
      reason: "To add the meeting notes to the shared note.",
      threadTitle: "Plan the offsite",
      workspaceName: "Main",
    });
    expect(harness.sign).not.toHaveBeenCalled();

    panel.answer(true);
    await harness.idle();

    expect(harness.sign).toHaveBeenCalledWith(setupRequest(), "allow");
    expect(harness.answers).toEqual([
      {
        deploymentId,
        frame: {
          answer: { approval: signatureFor(notesId), kind: "allow" },
          setupRequestId: notesId,
        },
      },
    ]);
  });

  it("asks about the automatic policy instead of an app, and signs that request", async () => {
    const harness = approvalHarness();
    harness.list([prompt(policyRequest())]);
    const panel = await harness.panel();
    expect(panel.presentation).toEqual({
      appApproval: "automatic",
      deploymentName: "Alex's Deployment",
      kind: "policy",
      machineName: "Alex's MacBook Pro",
    });
    panel.answer(true);
    await harness.idle();
    expect(harness.sign).toHaveBeenCalledWith(policyRequest(), "allow");
    expect(harness.answers[0]?.frame.answer.kind).toBe("allow");
  });

  it("signs a refusal when the person declines", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    (await harness.panel()).answer(false);
    await harness.idle();
    expect(harness.sign).toHaveBeenCalledWith(setupRequest(), "deny");
    expect(harness.answers).toEqual([
      {
        deploymentId,
        frame: {
          answer: { approval: signatureFor(notesId), kind: "deny" },
          setupRequestId: notesId,
        },
      },
    ]);
  });

  it("refuses an app the helper says is not allowed, without asking anybody", async () => {
    const harness = approvalHarness();
    harness.resolveApp.mockResolvedValueOnce({
      allowed: false,
      identity: { bundleId: "com.apple.Terminal", displayName: "Terminal", teamId: null },
      path: "/System/Applications/Utilities/Terminal.app",
      reason: "Terminals can run anything.",
      risk: "standard",
      running: false,
    });
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.panels).toEqual([]);
    expect(harness.answers).toEqual([
      {
        deploymentId,
        frame: {
          answer: { approval: signatureFor(notesId), kind: "deny" },
          setupRequestId: notesId,
        },
      },
    ]);
  });

  it("refuses a GUI app when this platform has no helper to resolve it", async () => {
    const harness = approvalHarness({ withHelper: false });
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.panels).toEqual([]);
    expect(harness.answers[0]?.frame.answer).toEqual({
      approval: signatureFor(notesId),
      kind: "deny",
    });
  });

  it("neither shows nor declines an app whose identity changed, and does not ask it again while listed", async () => {
    const harness = approvalHarness();
    harness.resolveApp.mockResolvedValue({
      allowed: true,
      identity: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "ABCDE12345" },
      path: "/Applications/Notes.app",
      reason: null,
      risk: "standard",
      running: false,
    });
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.panels).toEqual([]);
    expect(harness.answers).toEqual([]);
    expect(harness.resolveApp).toHaveBeenCalledOnce();
  });

  it("reads a bundle identifier's case the way macOS does", async () => {
    const harness = approvalHarness();
    harness.list([
      prompt(
        setupRequest({ app: { bundleId: "COM.APPLE.NOTES", displayName: "Notes", teamId: null } }),
      ),
    ]);
    expect((await harness.panel()).presentation).toMatchObject({ kind: "app" });
  });

  it("asks again, rather than declining, when the helper could not be reached", async () => {
    const harness = approvalHarness();
    harness.resolveApp.mockRejectedValueOnce(new Error("The helper is not running."));
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.answers).toEqual([]);
    expect(harness.panels).toEqual([]);
    // The next list — any change on this Mac, or the Runner coming back — asks.
    harness.list([prompt(setupRequest())]);
    expect((await harness.panel()).presentation).toMatchObject({ kind: "app" });
  });

  it("ignores a listed request that names another Deployment than the slot that listed it", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest({ deploymentId: otherDeploymentId }))]);
    await harness.idle();
    expect(harness.local.assertComputerAppSetupTarget).not.toHaveBeenCalled();
    expect(harness.panels).toEqual([]);
    expect(harness.log).toHaveBeenCalledWith(
      "desktop.computer-app.approval-foreign",
      expect.anything(),
    );
  });
});

describe("one panel at a time, and the ones that ended close", () => {
  it("closes the open panel when its request ends elsewhere, and shows the next one", async () => {
    const harness = approvalHarness();
    const notes = setupRequest();
    const calendar = setupRequest({ app: calendarApp, id: calendarId });
    harness.resolveApp.mockImplementation(async (bundleId) =>
      resolvedApp(bundleId === calendarApp.bundleId ? calendarApp : notesApp),
    );
    harness.list([prompt(notes), prompt(calendar)]);
    const first = await harness.panel();
    expect(first.presentation).toMatchObject({ app: { displayName: "Notes" } });
    // Declined from the phone: Notes is no longer in this Mac's list.
    harness.list([prompt(calendar)]);
    await vi.waitFor(() => expect(first.closed).toBe(true));
    const second = await harness.panel(1);
    expect(second.presentation).toMatchObject({ app: { displayName: "Calendar" } });
    // Nothing was answered for the panel that closed: somebody else did.
    expect(harness.answers).toEqual([]);
  });

  it("shows panels from different Deployments one at a time, and an answer advances the queue", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    harness.list([prompt(setupRequest({ deploymentId: otherDeploymentId }))], otherDeploymentId);
    const first = await harness.panel();
    await harness.idle();
    expect(harness.panels).toHaveLength(1);
    first.answer(false);
    const second = await harness.panel(1);
    expect(second.presentation).toMatchObject({ deploymentName: "Alex's Other Deployment" });
    second.answer(true);
    await harness.idle();
    expect(harness.answers.map(({ deploymentId: slot }) => slot)).toEqual([
      deploymentId,
      otherDeploymentId,
    ]);
  });

  it("shows a request listed twice once", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    await harness.panel();
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.panels).toHaveLength(1);
  });

  it("asks again after an answer was lost with its Runner connection", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    (await harness.panel()).answer(true);
    await harness.idle();
    expect(harness.answers).toHaveLength(1);
    harness.service.disconnected(deploymentId);
    harness.list([prompt(setupRequest())]);
    expect((await harness.panel(1)).presentation).toMatchObject({ kind: "app" });
  });

  it("closes only the disconnected slot's panel and advances another Deployment", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    harness.list(
      [prompt(setupRequest({ deploymentId: otherDeploymentId, id: calendarId, app: calendarApp }))],
      otherDeploymentId,
    );
    const first = await harness.panel();
    harness.service.disconnected(deploymentId);
    expect(first.closed).toBe(true);
    expect((await harness.panel(1)).presentation).toMatchObject({
      deploymentName: "Alex's Other Deployment",
    });
    expect(harness.answers).toEqual([]);
  });

  it("withdraws a stalled app lookup so the next Deployment can show its panel", async () => {
    const harness = approvalHarness();
    let release: ((value: ComputerUseResolvedApp) => void) | undefined;
    const held = new Promise<ComputerUseResolvedApp>((resolve) => {
      release = resolve;
    });
    harness.resolveApp.mockImplementationOnce(async () => held);
    harness.list([prompt(setupRequest())]);
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledOnce());
    harness.list(
      [prompt(setupRequest({ deploymentId: otherDeploymentId, id: calendarId, app: calendarApp }))],
      otherDeploymentId,
    );
    harness.list([]);
    expect((await harness.panel()).presentation).toMatchObject({
      deploymentName: "Alex's Other Deployment",
    });
    release?.(resolvedApp(notesApp));
    await harness.idle();
    expect(harness.panels).toHaveLength(1);
    expect(harness.answers).toEqual([]);
  });

  it("does not let a withdrawn lookup erase a re-listed request with the same id", async () => {
    const harness = approvalHarness();
    let release: ((value: ComputerUseResolvedApp) => void) | undefined;
    const held = new Promise<ComputerUseResolvedApp>((resolve) => {
      release = resolve;
    });
    harness.resolveApp.mockImplementationOnce(async () => held);
    harness.list([prompt(setupRequest())]);
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledOnce());
    harness.list([]);
    harness.list([prompt(setupRequest())]);
    const replacement = await harness.panel();
    release?.(resolvedApp(notesApp));
    await harness.idle();
    expect(replacement.closed).toBe(false);
    expect(harness.panels).toHaveLength(1);
    replacement.answer(true);
    await harness.idle();
    expect(harness.answers).toHaveLength(1);
  });

  it("shows and signs the same request while a relist changes its label during key lookup", async () => {
    const harness = approvalHarness();
    let release: ((value: { keyId: string }) => void) | undefined;
    harness.publicKey.mockImplementationOnce(
      async () =>
        new Promise<{ keyId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const original = setupRequest();
    harness.list([prompt(original)]);
    await vi.waitFor(() => expect(harness.publicKey).toHaveBeenCalledOnce());
    harness.list([prompt({ ...original, workspaceName: "Forged workspace" })]);
    release?.({ keyId });
    const panel = await harness.panel();
    expect(panel.presentation).toMatchObject({ workspaceName: "Main" });
    panel.answer(true);
    await harness.idle();
    expect(harness.sign).toHaveBeenCalledWith(original, "allow");
  });

  it("closes the open panel unanswered on quit, and shows nothing more", async () => {
    const harness = approvalHarness();
    harness.list([
      prompt(setupRequest()),
      prompt(setupRequest({ app: calendarApp, id: calendarId })),
    ]);
    const panel = await harness.panel();
    const waiting = harness.service.review(deploymentId, calendarId);
    harness.service.close();
    await expect(waiting).rejects.toThrow(/quitting/u);
    expect(panel.closed).toBe(true);
    await harness.idle();
    expect(harness.panels).toHaveLength(1);
    expect(harness.answers).toEqual([]);
  });
});

describe("the approval key", () => {
  it("holds requests while the Host accepts no key from this Mac, and asks them once this key is registered", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())], deploymentId, null);
    await expect(harness.service.review(deploymentId, notesId)).rejects.toThrow(
      computerAppApprovalKeyMissingSentence,
    );
    expect(harness.panels).toEqual([]);
    harness.list([prompt(setupRequest())], deploymentId, null);
    await harness.idle();
    expect(harness.log).toHaveBeenCalledTimes(1);

    // Another desktop's key is no better.
    harness.list([prompt(setupRequest())], deploymentId, `sha256:${"o".repeat(43)}`);
    await harness.idle();
    expect(harness.panels).toEqual([]);

    harness.list([prompt(setupRequest())]);
    expect((await harness.panel()).presentation).toMatchObject({ kind: "app" });
  });
});

describe("a page on this Mac waiting for its answer", () => {
  it("resolves with the Host's outcome, not with the person's click", async () => {
    const harness = approvalHarness();
    const waiting = harness.service.review(deploymentId, notesId);
    harness.list([prompt(setupRequest(noTask))]);
    (await harness.panel()).answer(true);
    await harness.idle();
    let settled = false;
    void waiting.then(() => (settled = true));
    await harness.idle();
    expect(settled).toBe(false);
    harness.service.outcome(deploymentId, {
      outcome: { kind: "allowed" },
      setupRequestId: notesId,
    });
    await expect(waiting).resolves.toEqual({ allowed: true });
  });

  it("is told false for a decline and for a request that ended elsewhere", async () => {
    const harness = approvalHarness();
    harness.list([
      prompt(setupRequest()),
      prompt(setupRequest({ app: calendarApp, id: calendarId })),
    ]);
    const declined = harness.service.review(deploymentId, notesId);
    const withdrawn = harness.service.review(deploymentId, calendarId);
    (await harness.panel()).answer(false);
    await harness.idle();
    harness.service.outcome(deploymentId, {
      outcome: { kind: "declined" },
      setupRequestId: notesId,
    });
    await expect(declined).resolves.toEqual({ allowed: false });
    harness.list([]);
    await expect(withdrawn).resolves.toEqual({ allowed: false });
  });

  it("shows the request a page waits for before older ones", async () => {
    const harness = approvalHarness();
    harness.list([
      prompt(setupRequest()),
      prompt(setupRequest({ ...noTask, app: calendarApp, id: calendarId })),
      prompt(policyRequest()),
    ]);
    const first = await harness.panel();
    void harness.service.review(deploymentId, policyRequest().id);
    first.answer(false);
    expect((await harness.panel(1)).presentation).toMatchObject({ kind: "policy" });
  });

  it("carries the Host's refusal to the page, does not ask again unasked, and asks again when the page does", async () => {
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    const first = harness.service.review(deploymentId, notesId);
    (await harness.panel()).answer(true);
    await harness.idle();
    harness.service.outcome(deploymentId, {
      outcome: { kind: "refused", message: "Approve this access in Opensteer on the computer." },
      setupRequestId: notesId,
    });
    await expect(first).rejects.toThrow("Approve this access in Opensteer on the computer.");
    harness.list([prompt(setupRequest())]);
    await harness.idle();
    expect(harness.panels).toHaveLength(1);

    const second = harness.service.review(deploymentId, notesId);
    (await harness.panel(1)).answer(false);
    await harness.idle();
    harness.service.outcome(deploymentId, {
      outcome: { kind: "declined" },
      setupRequestId: notesId,
    });
    await expect(second).resolves.toEqual({ allowed: false });
  });

  it("gives up when the request never reaches this Mac", async () => {
    const harness = approvalHarness({ arrivalTimeoutMs: 20 });
    await expect(harness.service.review(deploymentId, notesId)).rejects.toThrow(
      /did not reach this Mac/u,
    );
  });

  it("is told when the answer could not be sent, and the next list asks again", async () => {
    const harness = approvalHarness();
    // Nothing was delivered, so it is not an answer the Host saw.
    harness.sendAnswer.mockImplementationOnce(() => false);
    harness.list([prompt(setupRequest())]);
    const waiting = harness.service.review(deploymentId, notesId);
    (await harness.panel()).answer(true);
    await expect(waiting).rejects.toThrow(/lost its connection/u);
    harness.list([prompt(setupRequest())]);
    (await harness.panel(1)).answer(true);
    await harness.idle();
    expect(harness.answers).toHaveLength(1);
  });
});

describe("setting up an app the helper serves once it is allowed", () => {
  it("hands it to setup once, only after the Host accepts Allow, at the access allowed", async () => {
    // Failure: clicking Allow starts setup before the Host accepts the answer.
    // Failure: a duplicate outcome or re-list starts setup again without another Allow.
    // Failure: the approval itself lists macOS steps; the setup guide shows them.
    const harness = approvalHarness();
    const request = setupRequest({
      access: "read-write",
      app: null,
      definitionId: "apple-messages",
    });
    harness.list([prompt(request)]);
    const waiting = harness.service.review(deploymentId, notesId);
    const panel = await harness.panel();
    expect(panel.presentation).not.toHaveProperty("nextStep");
    panel.answer(true);
    await harness.idle();
    expect(harness.setUp).not.toHaveBeenCalled();
    const outcome = { outcome: { kind: "allowed" as const }, setupRequestId: notesId };
    harness.service.outcome(deploymentId, outcome);
    await expect(waiting).resolves.toEqual({ allowed: true });
    expect(harness.setUp).toHaveBeenCalledExactlyOnceWith({
      access: "read-write",
      definitionId: "apple-messages",
    });
    harness.service.outcome(deploymentId, outcome);
    harness.list([prompt(request)]);
    await harness.panel(1);
    harness.service.outcome(deploymentId, outcome);
    expect(harness.setUp).toHaveBeenCalledTimes(1);
    harness.service.close();
  });

  it.each(["declined", "refused", "withdrawn", "undelivered", "disconnected", "quit"] as const)(
    "sets nothing up when the answer is %s",
    async (ending) => {
      // Failure: an answer the Host never accepted still opens setup.
      const harness = approvalHarness();
      harness.list([prompt(setupRequest({ app: null, definitionId: "apple-messages" }))]);
      const panel = await harness.panel();
      if (ending === "undelivered") harness.sendAnswer.mockReturnValueOnce(false);
      panel.answer(ending !== "declined");
      await harness.idle();
      if (ending === "declined")
        harness.service.outcome(deploymentId, {
          outcome: { kind: "declined" },
          setupRequestId: notesId,
        });
      if (ending === "refused")
        harness.service.outcome(deploymentId, {
          outcome: { kind: "refused", message: "Try again." },
          setupRequestId: notesId,
        });
      if (ending === "withdrawn") harness.list([]);
      if (ending === "disconnected") harness.service.disconnected(deploymentId);
      if (ending === "quit") harness.service.close();
      if (ending !== "refused")
        harness.service.outcome(deploymentId, {
          outcome: { kind: "allowed" },
          setupRequestId: notesId,
        });
      await harness.idle();
      expect(harness.setUp).not.toHaveBeenCalled();
      harness.service.close();
    },
  );

  it("sets nothing up for a GUI app or the automatic policy", async () => {
    // Failure: an app operated through its interface, or the policy, opens a
    // data-grant setup it has nothing to do with.
    const harness = approvalHarness();
    harness.list([prompt(setupRequest())]);
    (await harness.panel()).answer(true);
    await harness.idle();
    harness.service.outcome(deploymentId, {
      outcome: { kind: "allowed" },
      setupRequestId: notesId,
    });
    await harness.idle();
    expect(harness.setUp).not.toHaveBeenCalled();
    harness.service.close();
  });
});

const notesApp = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null } as const;
const calendarApp = { bundleId: "com.apple.iCal", displayName: "Calendar", teamId: null } as const;

function resolvedApp(identity: typeof notesApp | typeof calendarApp): ComputerUseResolvedApp {
  return {
    allowed: true,
    identity,
    path: `/System/Applications/${identity.displayName}.app`,
    reason: "Operating this app reaches past the app itself.",
    risk: "elevated",
    running: false,
  };
}

function setupRequest(overrides: Partial<ComputerAppSetupRequest> = {}): ComputerAppSetupRequest {
  return {
    access: "read-write",
    app: notesApp,
    createdAt: "2026-09-21T00:00:00.000Z",
    definitionDigest: "sha256:abc",
    definitionId: "macos-app",
    deploymentId,
    expiresAt: "2026-09-21T01:00:00.000Z",
    id: notesId,
    kind: "app",
    ownerUserId: "usr_1a2b3c4d-5e6f-4071-8a9b-0c1d2e3f4051",
    policyAppApproval: null,
    reason: "To add the meeting notes to the shared note.",
    runnerId,
    threadId,
    threadTitle: "Plan the offsite",
    workspaceId,
    workspaceName: "Main",
    ...overrides,
  } as ComputerAppSetupRequest;
}

function policyRequest(): ComputerAppSetupRequest {
  return setupRequest({
    ...noTask,
    access: "read-write",
    app: null,
    id: "af4d5e7f-8091-4a23-8d4e-5f6071829304",
    kind: "policy",
    policyAppApproval: "automatic",
  });
}

function prompt(
  request: ComputerAppSetupRequest,
  workspaceName: string | null = request.workspaceName,
): ComputerAppApprovalPrompt {
  return { request: { ...request, workspaceName } };
}

function signatureFor(requestId: string) {
  return { expiresAt: "2026-09-21T00:00:30.000Z", requestId, signature: "s".repeat(86) };
}

interface FakePanel {
  answer(allow: boolean): void;
  closed: boolean;
  readonly presentation: ComputerAppApprovalPresentation;
}

function approvalHarness(behavior: { arrivalTimeoutMs?: number; withHelper?: boolean } = {}) {
  const local = {
    assertComputerAppSetupTarget: vi.fn(
      async (_request: ComputerAppSetupRequest): Promise<void> => undefined,
    ),
    checkComputerUseRunnerTarget: vi.fn(async () => ({ local: true as const })),
  };
  const personal = {
    assertComputerAppSetupTarget: vi.fn(
      async (_request: ComputerAppSetupRequest): Promise<void> => undefined,
    ),
    checkComputerUseRunnerTarget: vi.fn(async () => ({ local: true as const })),
    status: { deploymentId: null as string | null },
  };
  const panels: FakePanel[] = [];
  const confirm = (presentation: ComputerAppApprovalPresentation, signal: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      const panel: FakePanel = {
        answer: (allow) => {
          panel.closed = true;
          resolve(allow);
        },
        closed: false,
        presentation,
      };
      signal.addEventListener("abort", () => {
        panel.closed = true;
        reject(new Error("This approval ended somewhere else."));
      });
      panels.push(panel);
    });
  const resolveApp = vi.fn(async (app: string): Promise<ComputerUseResolvedApp> =>
    resolvedApp(app.toLowerCase() === calendarApp.bundleId.toLowerCase() ? calendarApp : notesApp),
  );
  const answers: { deploymentId: DeploymentId; frame: ComputerAppApprovalAnswerFrame }[] = [];
  const sendAnswer = vi.fn((slot: DeploymentId, frame: ComputerAppApprovalAnswerFrame) => {
    answers.push({ deploymentId: slot, frame });
    return true;
  });
  const sign = vi.fn(async (request: ComputerAppSetupRequest, _decision: "allow" | "deny") =>
    signatureFor(request.id),
  );
  const prove = vi.fn(async (challenge: { challengeId: string }) => ({
    challengeId: challenge.challengeId,
    signature: "s".repeat(86),
  }));
  const publicKey = vi.fn(async () => ({ keyId }));
  const log = vi.fn();
  const setUp = vi.fn();
  const service = new ComputerAppApprovalService({
    appIcon: async () => "aWNvbg==",
    approvalKey: { publicKey, prove, sign },
    ...(behavior.arrivalTimeoutMs === undefined
      ? {}
      : { arrivalTimeoutMs: behavior.arrivalTimeoutMs }),
    catalog: {
      load: async () => ({
        deployments: [
          { authority: { document: { deploymentId } }, name: "Alex's Deployment" },
          {
            authority: { document: { deploymentId: otherDeploymentId } },
            name: "Alex's Other Deployment",
          },
        ],
      }),
    },
    confirm,
    definitions: integrationDefinitions,
    ...(behavior.withHelper === false ? {} : { setUp }),
    local,
    log,
    machineName: async () => "Alex's MacBook Pro",
    personal,
    ...(behavior.withHelper === false ? {} : { resolveApp }),
    sendAnswer,
  });
  const idle = async () => {
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    answers,
    idle,
    list: (
      approvals: readonly ComputerAppApprovalPrompt[],
      slot: DeploymentId = deploymentId,
      approvalKeyId: string | null = keyId,
    ) => service.list(slot, { approvalKeyId, approvals: [...approvals] }),
    local,
    log,
    /** The nth panel shown, once it is open. */
    panel: async (index = 0) => {
      await vi.waitFor(() => expect(panels[index]).toBeDefined());
      const shown = panels[index];
      if (!shown) throw new Error("No panel");
      return shown;
    },
    panels,
    publicKey,
    resolveApp,
    setUp,
    sendAnswer,
    service,
    sign,
  };
}
