// @vitest-environment happy-dom

import type { SurfaceModel } from "@opensteer/client/host";
import { requestAgentProposedDetail, type Request } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockTmdbProposal } from "@opensteer/client/mock";
import { createThreadMutationGate } from "./thread-mutation-gate.js";

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Sending…</span>,
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Keyboard: { dismiss: vi.fn() },
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  TextInput: (props: object) => <input {...props} />,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../theme.js", () => ({
  color: {},
  controlBorderWidth: 1,
  controlFontScaleLimit: 2,
  radius: {},
  space: {},
  touchTarget: 44,
  type: { body: { lineHeight: 20 } },
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({
    action,
    detail,
    title,
  }: {
    action?: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action === undefined ? null : <button onClick={action.onPress}>{action.label}</button>}
    </div>
  ),
  PrimaryButton: ({
    busy,
    disabled,
    label,
    onPress,
  }: {
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled || busy} onClick={onPress}>
      {busy ? "Sending…" : label}
    </button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SecondaryButton: ({
    busy,
    disabled,
    label,
    onPress,
  }: {
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled || busy} onClick={onPress}>
      {busy ? "Sending…" : label}
    </button>
  ),
  StatusDot: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./integration-connect-sheet.js", () => ({ IntegrationConnectSheet: () => null }));

const { RequestCard } = await import("./request-card.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

/*
 * How a saved-password sign-in Request could mislead on a phone:
 * - it falls through to "Answer this on a computer" instead of naming the Mac
 *   where the sign-in waits, or calls that Mac "this Mac";
 * - it offers anything but Don’t allow, or the privacy line does not name the site;
 * - Don’t allow sends `request.respond`, which the Host refuses for this kind;
 * - a retried decline mints a second idempotency key;
 * - the agent's reason is shown twice, or unlabelled as if Opensteer said it;
 * - a settled sign-in reads "no longer waiting" instead of what happened.
 */
describe("RequestCard saved-password sign-ins", () => {
  it("names the Mac where it waits and declines with its own command", async () => {
    let answer: ((value: unknown) => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await render(surface(passwordSignInRequest()), dispatch);
    expect(text()).toContain("Sign in to github.com");

    await click("Review request");
    expect(text()).toContain("Waiting for you on Studio");
    expect(text()).toContain(
      "Opensteer fills your password into github.com for them — it never sends it to the agent, but the website page holds it once filled.",
    );
    expect(text()).toContain("Agent’s reason");
    expect(text().split("Open the pull request").length - 1).toBe(1);
    expect(text()).toMatch(/Expires in \d+ minutes/u);
    expect(text()).not.toContain("this Mac");
    expect(text()).not.toContain("Answer this on a computer");

    await click("Don’t allow");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      requestId: passwordSignInRequest().id,
      type: "browser.password-sign-in.decline",
    });
    // Its own busy state: the decline control is the one that says Sending….
    expect(button("Sending…").disabled).toBe(true);
    await act(async () =>
      answer?.({ status: "declined", type: "browser.password-sign-in.decline" }),
    );
  });

  it("retries a failed decline with the same idempotency key", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ status: "declined", type: "browser.password-sign-in.decline" });
    await render(surface(passwordSignInRequest()), dispatch);

    await click("Review request");
    await click("Don’t allow");
    expect(text()).toContain("Could not confirm your answer was sent.");
    await click("Don’t allow");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it.each([
    [{ method: "saved-password", outcome: "signed-in" }, "Signed in to github.com"],
    [
      { outcome: "failed", reason: "needs-fresh-session" },
      "This needs a new browser session. Ask your agent to open one and try again",
    ],
    [{ outcome: "unavailable", reason: "passwords-off" }, "Agent sign-ins are off on Studio"],
    [null, "Not allowed"],
  ] as const)("says how a settled sign-in ended: %o", async (response, words) => {
    const settled = {
      ...passwordSignInRequest(),
      resolvedAt: "2026-09-18T12:05:00.000Z",
      resolvedBy: "usr_00000000-0000-4000-8000-000000000001",
      response: { kind: "external", value: response ?? { decision: "declined" } },
      status: response === null ? "declined" : "fulfilled",
    } as unknown as Request;
    await render(surface(settled), vi.fn());
    await click("View request");
    expect(text()).toContain(words);
    expect(text()).not.toContain("Don’t allow");
  });
});

/*
 * How a Request only to install could mislead on a phone:
 * - Install and Not now with nothing on what would be installed;
 * - an agent's proposal not said to be one, without what the agent said it does,
 *   or its research source a full URL;
 * - nothing on where its key would go, or whether it is checked;
 * - promising an account or access, which installing does not give;
 * - Install sending anything but the Request's own choice.
 */
describe("RequestCard install requests", () => {
  it("reviews an agent's proposal in the web's words before Install", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(installRequest()), dispatch);

    await click("Review request");
    for (const line of [
      "TMDB",
      requestAgentProposedDetail,
      "Movie and TV show details, search and ratings.",
      "Researched from developer.themoviedb.org.",
      "Your key is stored encrypted by your Opensteer and sent to api.themoviedb.org when used.",
      "Opensteer checks the key with TMDB before saving it.",
      "Installing adds it to this deployment. Connecting an account and allowing access are each asked for separately.",
    ]) {
      expect(text()).toContain(line);
    }
    expect(text()).not.toContain("https://");

    const install = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Install",
    );
    await act(async () => install?.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      requestId: installRequest().id,
      response: { kind: "choice", optionId: "installed" },
      type: "request.respond",
    });
  });
});

describe("RequestCard external requests", () => {
  it("guides the requester to the target Mac and offers only decline", async () => {
    const request = fullDiskAccessRequest();
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(request), dispatch);

    await click("Review request");
    expect(text()).toContain("macOS permission needed on Build Mac");
    expect(text()).toContain(
      "Complete setup on Build Mac. Grant Full Disk Access to the app that runs Opensteer on that Mac.",
    );
    expect(text()).toContain("Not now");
    expect(text()).not.toContain("Open System Settings");

    await click("Not now");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      requestId: request.id,
      response: { kind: "external", value: { decision: "declined" } },
      type: "request.respond",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ value: { decision: "fulfilled" } }),
      }),
    );
  });

  it("keeps requester-only decline unavailable to another viewer", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(fullDiskAccessRequest(), "requester"), dispatch);

    await click("View request");
    expect(text()).toContain("Someone else answers this");
    expect(text()).not.toContain("Not now");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps decline visible but disabled while the Host is offline", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(fullDiskAccessRequest()), dispatch, { canRespond: false });

    await click("Review request");
    const decline = button("Not now");
    expect(decline.disabled).toBe(true);
    decline.click();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retries a failed decline with the same idempotency key", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ type: "request.respond" });
    await render(surface(fullDiskAccessRequest()), dispatch);

    await click("Review request");
    await click("Not now");
    expect(text()).toContain("Could not confirm your answer was sent.");
    await click("Not now");

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("names the Mac an app request is approved on and declines it with its own control", async () => {
    let answer: ((value: unknown) => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await render(surface(computerAppRequest()), dispatch);

    await click("Review request");
    expect(text()).toContain("Approve on Studio");
    expect(text()).toContain(
      "Can see and control. Opensteer shows the approval on Studio by itself.",
    );
    expect(text()).not.toContain("that Mac");
    expect(text()).not.toContain("Not now");

    await click("Decline");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      requestId: computerAppRequest().id,
      response: { kind: "external", value: { decision: "declined" } },
      type: "request.respond",
    });
    // Its own busy state: the Decline control is the one that says Sending….
    expect(button("Sending…").disabled).toBe(true);
    await act(async () => answer?.({ type: "request.respond" }));
  });

  it("follows Chrome live: no Chrome, then offline, where Allow finishes by itself", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(inspection([]))
      .mockResolvedValue(inspection([candidate(macChrome, "Chrome on Mac", "offline")]));
    const dispatch = vi.fn(async () => ({
      outcome: {
        problem: "chrome-offline",
        site: "https://github.com",
        sourceName: "Chrome on Mac",
        status: "problem",
      },
      type: "browser.sign-in.respond",
    }));
    vi.useFakeTimers();
    try {
      await render(surface(signInRequest()), dispatch, { inspect });
      await settle();
      expect(inspect).toHaveBeenCalledWith({ url: "https://github.com" });
      expect(text()).toContain("Sign in to github.com");
      expect(text()).toContain("Chrome isn’t connected yet");

      await click("Review request");
      expect(text()).toContain("Your agent wants to use your github.com sign-in from Chrome.");
      expect(text()).toContain("Agents in Research will be able to use github.com as you.");
      expect(text()).toContain("Connect Chrome from Opensteer on your computer.");
      expect(button("Allow").disabled).toBe(true);

      // Chrome connects on the computer; the open card sees it without a tap.
      await act(async () => vi.advanceTimersByTime(5_000));
      await settle();
      expect(text()).toContain("Chrome on Mac is offline");
      expect(text()).toContain("Allow now; this finishes by itself when Chrome opens.");
      expect(button("Allow").disabled).toBe(false);

      await click("Allow");
      await settle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({
        decision: { decision: "allow", sourceId: macChrome },
        idempotencyKey: expect.any(String),
        requestId: signInRequest().id,
        type: "browser.sign-in.respond",
      });
      expect(text()).toContain("Allowed. Waiting for Chrome on Mac");
      expect(() => button("Allow")).toThrow();
      expect(button("Don’t allow").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks which Chrome when several are signed in, names the problem ones, and declines", async () => {
    const inspect = vi.fn(async () =>
      inspection([
        candidate(macChrome, "Chrome on Mac", "available"),
        candidate(workChromeId, "Work Chrome", "available"),
        candidate(oldChrome, "Old laptop", "stopped"),
      ]),
    );
    const dispatch = vi.fn(async () => ({ outcome: null, type: "browser.sign-in.respond" }));
    await render(surface(signInRequest()), dispatch, { inspect });
    await settle();

    await click("Review request");
    expect(text()).toContain("Several Chrome profiles are signed in to github.com");
    expect(text()).toContain("Sharing github.com is stopped");
    expect(button("Old laptop").disabled).toBe(true);
    expect(button("Allow").disabled).toBe(true);

    await click("Work Chrome");
    expect(text()).toContain("from Work Chrome.");
    expect(button("Allow").disabled).toBe(false);

    await click("Don’t allow");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        decision: { decision: "decline" },
        type: "browser.sign-in.respond",
      }),
    );
  });

  it("says how to fix a Chrome that stopped sharing the site", async () => {
    const inspect = vi.fn(async () =>
      inspection([candidate(macChrome, "Chrome on Mac", "stopped")]),
    );
    await render(surface(signInRequest()), vi.fn(), { inspect });
    await settle();

    await click("Review request");
    expect(text()).toContain("Sharing github.com is stopped in Chrome on Mac");
    expect(text()).toContain("Open the Opensteer extension in Chrome and choose Share again.");
    expect(button("Allow").disabled).toBe(true);
  });
});

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await act(async () => undefined);
}

async function render(
  model: SurfaceModel,
  dispatch: ReturnType<typeof vi.fn>,
  options: {
    readonly canRespond?: boolean;
    readonly inspect?: ReturnType<typeof vi.fn>;
    readonly machines?: readonly MachineSummary[];
  } = {},
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RequestCard
        canRespond={options.canRespond ?? true}
        canStartResponse={() => true}
        disabledReason={null}
        highlighted={false}
        hostClient={
          {
            dispatch,
            getSnapshot: () => ({
              identityConfig: { deployment: { name: "Alex’s Opensteer" } },
              workspaces: [{ id: workspaceId, name: "Research" }],
            }),
            rpc: { "browser.sources.inspect": options.inspect ?? vi.fn() },
          } as never
        }
        machines={options.machines ?? [studio]}
        mutationGate={createThreadMutationGate(null, () => undefined)}
        onPresent={() => undefined}
        onSettle={() => undefined}
        surface={model}
      />,
    );
  });
}

async function click(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const target = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label")?.includes(label) ||
      candidate.textContent?.includes(label),
  );
  if (!(target instanceof HTMLButtonElement)) {
    throw new Error(`No button matching ${label}: ${text()}`);
  }
  return target;
}

function text(): string {
  return document.body.textContent ?? "";
}

function surface(request: Request, denied: SurfaceModel["denied"] = null): SurfaceModel {
  return {
    denied,
    queued: 0,
    queuedTitle: null,
    request,
    textRole: "message",
  };
}

function fullDiskAccessRequest(): Request {
  return {
    ...requestBase(),
    kind: "machine.full-disk-access",
    payload: {
      kind: "machine.full-disk-access",
      machineId: "rnr_00000000-0000-4000-8000-000000000001",
      machineName: "Build Mac",
      reason: "Read protected Messages data",
    },
    presentation: {
      detail: "Read protected Messages data",
      kind: "external",
      subject: { id: "rnr_00000000-0000-4000-8000-000000000001", kind: "machine" },
      title: "Allow macOS permission on Build Mac",
    },
  } as Request;
}

function installRequest(): Request {
  return {
    ...requestBase(),
    kind: "integration.install",
    payload: {
      kind: "integration.install",
      manifest: mockTmdbProposal.manifest,
      reason: "Look up movies and TV shows on TMDB.",
    },
    presentation: {
      agentProposed: true,
      kind: "choice",
      options: [
        { hint: "reject-once", id: "declined", label: "Not now" },
        { hint: "confirm", id: "installed", label: "Install" },
      ],
      title: "Install TMDB?",
    },
    requiredActor: "administrator",
  } as unknown as Request;
}

const studioId = "rnr_00000000-0000-4000-8000-000000000002";
const studio = { id: studioId, name: "Studio" } as MachineSummary;

function computerAppRequest(): Request {
  return {
    ...requestBase(),
    id: "req_00000000-0000-4000-8000-000000000002",
    kind: "computer.app.access",
    payload: {
      access: "read-write",
      app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
      definitionId: "macos-app",
      kind: "computer.app.access",
      reason: "Move the plan into Notes",
      runnerId: studioId,
      setupRequestId: "00000000-0000-4000-8000-000000000003",
      workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
    },
    presentation: {
      detail: "Move the plan into Notes",
      kind: "external",
      subject: { id: studioId, kind: "machine" },
      title: "Wants to use Notes on Studio",
    },
  } as unknown as Request;
}

const workspaceId = "wsp_00000000-0000-4000-8000-000000000001";
const workChromeId = "bsr_00000000-0000-4000-8000-000000000001";

const macChrome = "bsr_00000000-0000-4000-8000-000000000003";
const oldChrome = "bsr_00000000-0000-4000-8000-000000000004";

function signInRequest(): Request {
  return {
    ...requestBase(),
    id: "req_00000000-0000-4000-8000-000000000004",
    kind: "browser.sign-in",
    payload: {
      kind: "browser.sign-in",
      reason: "Open the pull request",
      sessionId: "bss_1",
      site: "https://github.com",
    },
    presentation: {
      detail: "Open the pull request",
      kind: "external",
      subject: { id: "https://github.com", kind: "browser-site" },
      title: "Sign in to github.com",
    },
  } as unknown as Request;
}

function passwordSignInRequest(): Request {
  return {
    ...requestBase(),
    id: "req_00000000-0000-4000-8000-000000000005",
    kind: "browser.password-sign-in",
    payload: {
      computerName: "Studio",
      expiresAt: new Date(Date.now() + 14 * 60_000 + 30_000).toISOString(),
      kind: "browser.password-sign-in",
      operationId: "00000000-0000-4000-8000-000000000006",
      reason: "Open the pull request",
      runnerId: studioId,
      sessionId: "bss_1",
      site: "https://github.com",
    },
    presentation: {
      detail: "Open the pull request",
      kind: "external",
      subject: { id: "https://github.com", kind: "browser-site" },
      title: "Sign in to github.com",
    },
  } as unknown as Request;
}

function candidate(sourceId: string, name: string, status: string) {
  return { name, sourceId, status };
}

function inspection(candidates: readonly object[]) {
  return { data: { candidates, site: "https://github.com" }, ok: true };
}

function requestBase() {
  return {
    callId: "call-1",
    cancellationReason: null,
    createdAt: "2026-09-18T12:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: "run_00000000-0000-4000-8000-000000000001",
    originatingThreadId: "thr_00000000-0000-4000-8000-000000000001",
    originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  } as const;
}
