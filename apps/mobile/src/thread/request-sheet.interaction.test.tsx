import { authenticatePasswordApproval } from "./password-approval-auth.js";
// @vitest-environment happy-dom

import type { SurfaceModel } from "@opensteer/client/host";
import {
  createId,
  UserIdSchema,
  WaitingRequestSchema,
  RequestSchema,
  requestAgentProposedDetail,
  type Request,
} from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockCardUseRequest, mockTmdbProposal } from "@opensteer/client/mock";
import { createThreadMutationGate, type ThreadMutationGate } from "./thread-mutation-gate.js";

vi.mock("./agent-mark.js", () => ({
  AgentEngine: ({ children }: { readonly children: unknown }) => children,
  AskerMark: () => null,
  threadEngine: () => null,
}));
vi.mock("./password-approval-auth.js", () => ({
  authenticatePasswordApproval: vi.fn(async () => true),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  Modal: ({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
    visible ? <div data-modal="">{children}</div> : null,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios", Version: "26" },
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
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {typeof children === "function" ? children({ pressed: false }) : children}
    </button>
  ),
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  TextInput: ({
    onChangeText,
    ...props
  }: {
    onChangeText?: (value: string) => void;
    [key: string]: unknown;
  }) => <input {...props} onChange={(event) => onChangeText?.(event.target.value)} />,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Chip: ({
    accessibilityLabel,
    disabled,
    label,
    onPress,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
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
  SectionLabel: ({ children }: { children: string }) => <h3>{children}</h3>,
  SecondaryButton: ({
    accessibilityLabel,
    busy,
    disabled,
    label,
    onPress,
  }: {
    accessibilityLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled || busy} onClick={onPress}>
      {busy ? "Sending…" : label}
    </button>
  ),
  StatusDot: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({
    children,
    onClose,
    open,
  }: {
    children?: ReactNode;
    onClose: () => void;
    open: boolean;
  }) =>
    open ? (
      <div data-modal="">
        <button onClick={onClose}>Close sheet</button>
        {children}
      </div>
    ) : null,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../computers/here-device.js", () => ({ useHereDeviceId: () => null }));
vi.mock("../ui/sheet-bar.js", () => ({
  SheetBarButton: ({ onPress }: { onPress: () => void }) => (
    <button onClick={onPress}>Close sheet</button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: vi.fn(),
  useMobileState: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));
vi.mock("./integration-connect-sheet.js", () => ({
  IntegrationConnectCard: () => <span>Inline Connect card</span>,
}));
vi.mock("./composer-menu.js", () => ({
  NativeMenu: (props: {
    options: readonly { id: string; label: string; onPress: () => void }[];
  }) => (
    <div>
      {props.options.map((option) => (
        <button key={option.id} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

const { RequestSheetContent } = await import("./request-sheet.js");
const { resetRequestSessionsForTests } = await import("./request-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  resetRequestSessionsForTests();
  vi.mocked(authenticatePasswordApproval).mockImplementation(async () => true);
});

/*
 * How a saved-password sign-in Request could mislead on a phone:
 * - it falls through to "Answer this on a computer" instead of naming the Mac
 *   where the sign-in waits, or calls that Mac "this Mac";
 * - it offers anything but Don’t Allow, or the privacy line does not name the site;
 * - Don’t Allow sends `request.respond`, which the Host refuses for this kind;
 * - a retried decline mints a second idempotency key;
 * - the agent's reason is shown twice, or unlabelled as if Opensteer said it.
 */
describe("RequestSheetContent computer owner approvals", () => {
  it.each(["macos-app", "android-phone"] as const)(
    "reviews %s from the phone and sends the owner command",
    async (definitionId) => {
      const request = computerAppRequest();
      if (request.payload.kind !== "computer.app.access") throw new Error("Expected app request");
      request.payload.definitionId = definitionId;
      const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
      const review = computerAppReview(request);
      await render(surface(request), dispatch, { review });
      expect(review).not.toHaveBeenCalled();
      await click("Allow");
      if (definitionId === "macos-app") {
        expect(review).toHaveBeenCalledOnce();
        // iOS shows one modal at a time, so the review must be in the open sheet.
        expect(document.querySelectorAll("[data-modal]")).toHaveLength(0);
        expect(text()).toContain("Don't allow");
        await click("Allow");
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "integration.computer.setup.respond",
            decision: "allow",
          }),
        );
        expect(dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "integration.computer.setup.set" }),
        );
      } else {
        expect(review).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "integration.computer.setup.set" }),
        );
      }
      expect(document.querySelector("[data-modal]")).toBeNull();
    },
  );

  it("ends a Mac app review when its sheet closes, so Allow works again", async () => {
    const request = computerAppRequest();
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    const review = computerAppReview(request);
    await render(surface(request), dispatch, { review });
    await click("Allow");
    await closeAndReopen();
    expect(document.querySelector("[data-modal]")).toBeNull();
    await click("Allow");
    expect(review).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets a review closed mid-answer reopen without sending a second answer", async () => {
    const request = computerAppRequest();
    let fail: ((error: Error) => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const review = computerAppReview(request);
    await render(surface(request), dispatch, { review });
    await click("Allow");
    await click("Allow");
    await closeAndReopen();
    await click("Allow");
    expect(review).toHaveBeenCalledTimes(2);
    expect(button("Allow").disabled).toBe(true);
    await act(async () => fail?.(new Error("offline")));
    await click("Allow");
    expect(dispatch).toHaveBeenCalledTimes(2);
    // An answer on its way outlives its sheet, so this one has to finish too.
    await act(async () => fail?.(new Error("offline")));
  });

  it("settles a reopened review when the answer sent before closing lands", async () => {
    const request = computerAppRequest();
    let land: ((value: { type: string }) => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    await render(surface(request), dispatch, { review: computerAppReview(request) });
    await click("Allow");
    await click("Allow");
    await closeAndReopen();
    await click("Allow");
    await act(async () => land?.({ type: "integration.computer.setup.respond" }));
    expect(document.querySelector("[data-modal]")).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("closes quietly while the review is still loading", async () => {
    const request = computerAppRequest();
    const review = vi.fn(
      (_input: unknown, call?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          call?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await render(surface(request), vi.fn(), { review });
    await click("Allow");
    await closeAndReopen();
    expect(text()).not.toContain("Could not confirm your answer was sent.");
    expect(button("Allow").disabled).toBe(false);
  });
});

function computerAppReview(request: Request): ReturnType<typeof vi.fn> {
  if (request.payload.kind !== "computer.app.access") throw new Error("Expected app request");
  const { definitionId, setupRequestId } = request.payload;
  return vi.fn(async () => ({
    ok: true,
    data: {
      request: { id: setupRequestId, definitionId, kind: "app", access: "read-write", app: null },
      app: null,
    },
  }));
}

describe("saved card consent", () => {
  it.each(["allow", "cancel", "settled"] as const)(
    "authenticates card use and fences %s",
    async (mode) => {
      const request = mockCardUseRequest();
      let finish: ((value: boolean) => void) | undefined;
      vi.mocked(authenticatePasswordApproval).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const dispatch = vi.fn(async () => ({
        type: "browser.password-sign-in.respond",
        status: "fulfilled",
      }));
      const passwordRead = vi.fn(async () => ({
        ok: true,
        data: {
          stage: "card-approval",
          permissionVersion: 7,
          cards: [
            {
              id: "00000000-0000-4000-8000-000000000042",
              revision: 2,
              brand: "Visa",
              lastFour: "4242",
              label: null,
              expiryMonth: 12,
              expiryYear: 2030,
            },
          ],
        },
      }));
      await render(surface(request), dispatch, { passwordRead });
      expect(text()).not.toContain("Sign in to");
      await click("Allow card use");
      expect(authenticatePasswordApproval).toHaveBeenCalledWith("card");
      expect(dispatch).not.toHaveBeenCalled();
      if (mode === "settled")
        await render(
          surface(
            RequestSchema.parse({
              ...request,
              status: "declined",
              resolvedAt: new Date().toISOString(),
              resolvedBy: request.requestedBy,
              response: { kind: "external", value: { decision: "declined" } },
            }),
          ),
          dispatch,
          { passwordRead, root: roots.at(-1)! },
        );
      await act(async () => {
        finish?.(mode !== "cancel");
      });
      if (mode === "allow")
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            decision: {
              kind: "approve-card",
              cardId: "00000000-0000-4000-8000-000000000042",
              revision: 2,
              permissionVersion: 7,
            },
          }),
        );
      else expect(dispatch).not.toHaveBeenCalled();
    },
  );
});

describe("RequestSheetContent saved-password sign-ins", () => {
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

    expect(text()).toContain("Sign in to github.com");
    expect(text()).toContain(
      "Your agents can type your saved login on github.com and in apps they use, like on your phone. Agents never see it, but a tricked agent could reveal it.",
    );
    expect(text()).toContain("Agent’s reason");
    expect(text().split("Open the pull request").length - 1).toBe(1);
    expect(text()).toMatch(/Expires in \d+ minutes/u);
    expect(text()).not.toContain("this Mac");
    expect(text()).not.toContain("Answer this on a computer");

    await click("Don’t Allow");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      requestId: passwordSignInRequest().id,
      type: "browser.password-sign-in.respond",
      decision: { kind: "decline" },
    });
    // Its own busy state: the decline control is the one that says Sending….
    expect(button("Sending…").disabled).toBe(true);
    await act(async () =>
      answer?.({ status: "declined", type: "browser.password-sign-in.respond" }),
    );
  });

  it("requires successful device-owner authentication before allowing the pinned account", async () => {
    const account = {
      id: "00000000-0000-4000-8000-000000000001",
      revision: 7,
      username: "person@example.com",
      host: "github.com",
      onPage: false,
      updatedAt: new Date().toISOString(),
      label: null,
    };
    const dispatch = vi.fn(async () => ({
      type: "browser.password-sign-in.respond",
      status: "fulfilled",
    }));
    const passwordRead = vi.fn(async () => ({
      ok: true,
      data: { stage: "approval", permissionVersion: 6, accounts: [account] },
    }));
    vi.mocked(authenticatePasswordApproval)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await render(surface(passwordSignInRequest()), dispatch, { passwordRead });
    expect(text()).toContain("Allow lets your agents sign in as person@example.com from now on.");
    await click("Allow");
    expect(dispatch).not.toHaveBeenCalled();
    await click("Only this time");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        decision: {
          kind: "approve",
          loginId: account.id,
          revision: 7,
          remember: false,
          permissionVersion: 6,
        },
      }),
    );
    expect(passwordRead).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps account host groups and page matches (onPage=%s)",
    async (onPage) => {
      const accounts = ["github.com", "enterprise.github.com", "login.github.com"].map(
        (host, index) => ({
          id: `00000000-0000-4000-8000-00000000000${index + 1}`,
          revision: index + 1,
          username: "same@example.com",
          host,
          onPage: onPage && index === 0,
          updatedAt: new Date().toISOString(),
          label: null,
        }),
      );
      const passwordRead = vi.fn(async () => ({
        ok: true,
        data: { stage: "approval", permissionVersion: 6, accounts },
      }));
      const dispatch = vi.fn(async () => ({
        type: "browser.password-sign-in.respond",
        status: "fulfilled",
      }));
      await render(surface(passwordSignInRequest()), dispatch, { passwordRead });
      if (onPage) {
        expect(text()).not.toContain("enterprise.github.com");
        await click("Other accounts on github.com (2)");
      }
      for (const host of ["enterprise.github.com", "login.github.com"]) {
        expect(text()).toContain(host);
        expect(button(`Sign in as same@example.com · ${host}`)).toBeDefined();
      }
      await click("Sign in as same@example.com · enterprise.github.com");
      expect(text()).toContain("Allow lets your agents sign in as same@example.com from now on.");
      await click("Allow");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: {
            kind: "approve",
            loginId: accounts[1]!.id,
            revision: 2,
            remember: true,
            permissionVersion: 6,
          },
        }),
      );
      expect(passwordRead).toHaveBeenCalledOnce();
    },
  );

  it("retries a failed decline with the same idempotency key", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ status: "declined", type: "browser.password-sign-in.respond" });
    await render(surface(passwordSignInRequest()), dispatch);

    await click("Don’t Allow");
    expect(text()).toContain("Could not confirm your answer was sent.");
    await click("Don’t Allow");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0].idempotencyKey,
    );
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
describe("RequestSheetContent install requests", () => {
  it("reviews an agent's proposal in the web's words before Install", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(installRequest()), dispatch);

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

describe("RequestSheetContent browser profile requests", () => {
  it("names a new profile with one tap and creates it", async () => {
    const request = {
      ...requestBase(),
      kind: "browser.access",
      payload: {
        kind: "browser.access",
        reason: "Sign in to Brex",
        suggestion: { kind: "new", suggestedName: "Brex" },
      },
      presentation: {
        detail: "Sign in to Brex",
        kind: "external",
        subject: { id: "bpr_00000000-0000-4000-8000-000000000001", kind: "browserProfile" },
        title: "Browser profile",
      },
    } as Request;
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(request), dispatch, {
      snapshot: {
        browserProfiles: [{ id: "bpr_00000000-0000-4000-8000-000000000001", name: "Personal" }],
      },
    });

    // Personal is taken, so it is never offered as a new name.
    expect(() => button("Name it Personal")).toThrow();
    await click("Name it Finance");
    await click("Create and allow");

    expect(dispatch).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      requestId: request.id,
      response: {
        kind: "external",
        value: { createProfile: { name: "Finance", homeRunnerId: null }, decision: "fulfilled" },
      },
      type: "request.respond",
    });
  });
});

describe("RequestSheetContent external requests", () => {
  it("guides the requester to the target Mac and offers only decline", async () => {
    const request = fullDiskAccessRequest();
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(request), dispatch);

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

  it("turns a device's switch on in the Host change that fulfils it, or leaves it off", async () => {
    const request = deviceAccessRequest();
    const policy = {
      apps: false,
      browser: true,
      commands: false,
      forwarding: false,
      reach: "owner" as const,
      shares: [],
    };
    const laptop = {
      access: { activeSessions: [], ownerReachAvailable: true, policy, revision: 7 },
      id: "rnr_00000000-0000-4000-8000-000000000001",
      name: "MacBook Pro (2)",
    } as unknown as MachineSummary;
    const dispatch = vi.fn(async (command: { type: string }) => ({
      outcome: "updated",
      revision: 8,
      type: command.type,
    }));
    await render(surface(request), dispatch, { machines: [laptop] });
    expect(text()).toContain("Let your agent use Apps on MacBook Pro (2)?");
    await click("Turn it on");
    expect(dispatch).toHaveBeenCalledWith({
      expectedRevision: 7,
      idempotencyKey: expect.any(String),
      policy: { reach: policy.reach, commands: false, forwarding: false, shares: [], apps: true },
      runnerId: laptop.id,
      type: "machine.access.update",
    });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "request.respond" }));

    resetRequestSessionsForTests();
    const declining = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(deviceAccessRequest()), declining, { machines: [laptop] });
    await click("Not now");
    expect(declining).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      requestId: request.id,
      response: { kind: "external", value: { decision: "declined" } },
      type: "request.respond",
    });
  });

  it("restores Files without enabling commands or forwarding", async () => {
    const request = deviceAccessRequest();
    if (request.payload.kind !== "device.access") throw new Error("Expected device Request");
    const files = { ...request, payload: { ...request.payload, access: "files" as const } };
    const laptop = {
      id: request.payload.machineId,
      access: {
        revision: 7,
        policy: {
          reach: "nobody",
          commands: false,
          forwarding: false,
          shares: [{ path: "/read-only", mode: "read" }],
        },
      },
    } as unknown as MachineSummary;
    const dispatch = vi.fn(async () => ({
      type: "machine.access.update",
      outcome: "updated",
      revision: 8,
    }));
    await render(surface(files), dispatch, { machines: [laptop] });
    await click("Turn it on");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: {
          reach: "owner",
          commands: false,
          forwarding: false,
          shares: [{ path: "/read-only", mode: "read" }],
        },
      }),
    );
  });

  it("keeps requester-only decline unavailable to another viewer", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(fullDiskAccessRequest(), "requester"), dispatch);

    expect(text()).toContain("Someone else answers this");
    expect(text()).not.toContain("Not now");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps decline visible but disabled while the Host is offline", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(fullDiskAccessRequest()), dispatch, { canRespond: false });

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

    expect(text()).toContain("Allow on this device");
    expect(text()).toContain("Can see and control. You can give agents access to Studio here.");
    expect(text()).not.toContain("that Mac");
    expect(text()).not.toContain("Not now");

    await click("Don’t Allow");
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

      expect(text()).toContain("Your agent wants to use your github.com sign-in from Chrome.");
      expect(text()).toContain("Your agent will be able to use github.com as you.");
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
      expect(
        [...document.querySelectorAll("button")].some(({ textContent }) => textContent === "Allow"),
      ).toBe(false);
      expect(button("Don’t Allow").disabled).toBe(false);
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

    expect(text()).toContain("Several Chrome profiles are signed in to github.com");
    expect(text()).toContain("Sharing github.com is stopped");
    expect(button("Old laptop").disabled).toBe(true);
    expect(button("Allow").disabled).toBe(true);

    await click("Work Chrome");
    expect(text()).toContain("from Work Chrome.");
    expect(button("Allow").disabled).toBe(false);

    await click("Don’t Allow");
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
  dispatch: (command: { readonly type: string; readonly [key: string]: unknown }) => unknown,
  options: {
    readonly root?: Root;
    readonly canRespond?: boolean;
    readonly gate?: ThreadMutationGate;
    readonly inspect?: ReturnType<typeof vi.fn>;
    readonly machines?: readonly MachineSummary[];
    readonly passwordRead?: ReturnType<typeof vi.fn>;
    readonly reason?: boolean;
    readonly review?: ReturnType<typeof vi.fn>;
    readonly snapshot?: object;
  } = {},
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = options.root ?? createRoot(container);
  if (!options.root) roots.push(root);
  // The sheet is a route: closing it unmounts it, and opening it is a new mount.
  latest = () => render(model, dispatch, { ...options, root });
  const snapshot = {
    machines: options.machines ?? [],
    harnesses: [],
    identityConfig: { deployment: { name: "Alex’s Opensteer" } },
    threads: [],
    ...options.snapshot,
  };
  await act(async () => {
    root.render(
      <RequestSheetContent
        canRespond={options.canRespond ?? true}
        canStartResponse={() => true}
        disabledReason={null}
        gate={options.gate ?? createThreadMutationGate(null, () => undefined)}
        hostClient={
          {
            dispatch,
            load: async () => undefined,
            refresh: async () => undefined,
            subscribe: () => () => undefined,
            getSnapshot: () => snapshot,
            updateMachineAccess: async (input: {
              runnerId: string;
              expectedRevision: number;
              policy: object;
            }) =>
              dispatch({ ...input, type: "machine.access.update", idempotencyKey: "test-access" }),
            rpc: {
              "browser.sources.inspect": options.inspect ?? vi.fn(),
              "browser.password-sign-in.get":
                options.passwordRead ?? vi.fn(async () => ({ ok: true, data: { stage: "gone" } })),
              "integration.computer.setup.review": options.review ?? vi.fn(),
            },
          } as never
        }
        machines={options.machines ?? [studio]}
        onClose={() => {
          root.render(null);
        }}
        reason={options.reason ?? false}
        surface={model}
      />,
    );
  });
}

let latest: () => Promise<void> = async () => undefined;

async function closeAndReopen(): Promise<void> {
  await click("Close sheet");
  await latest();
}

async function click(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const buttons = [...document.querySelectorAll("button")];
  // "Allow" is not "Don’t Allow", which now stands first on the line.
  const target =
    buttons.find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label || candidate.textContent === label,
    ) ??
    buttons.find(
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

describe("RequestSheetContent answers", () => {
  const question = (secret: boolean): Request =>
    ({
      ...requestBase(),
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [{ id: "q", multiSelect: false, prompt: "Which token?", secret }],
        kind: "form",
        title: "A question",
      },
    }) as Request;

  async function typeAnswer(value: string): Promise<void> {
    const field = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps an answer through closing the sheet to read the Thread", async () => {
    await render(surface(question(false)), vi.fn());
    await typeAnswer("the staging one");
    await closeAndReopen();
    expect(document.querySelector("input")?.value).toBe("the staging one");
  });

  it("keeps an unsent answer with the person who typed it", async () => {
    await render(surface(question(false)), vi.fn(), { snapshot: { user: { id: "usr_a" } } });
    await typeAnswer("mine");
    await render(surface(question(false)), vi.fn(), { snapshot: { user: { id: "usr_b" } } });
    const inputs = [...document.querySelectorAll("input")];
    expect(inputs.map(({ value }) => value)).toEqual(["mine", ""]);
  });

  it("offers an approval's other answers while it's being reviewed", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    const approval = {
      ...requestBase(),
      kind: "harness.approval",
      payload: { kind: "harness.approval" },
      presentation: {
        detail: "pnpm test",
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "allow-for-run", id: "run", label: "Allow for this Run" },
          { hint: "reject-once", id: "reject", label: "Reject" },
        ],
        title: "Run this command?",
      },
    } as Request;
    await render(surface(approval), dispatch);
    await click("Allow for this Run");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ response: { kind: "choice", optionId: "run" } }),
    );
  });

  it("keeps a reason through closing the sheet to read the Thread", async () => {
    const approval = {
      ...requestBase(),
      kind: "harness.approval",
      payload: { kind: "harness.approval" },
      presentation: {
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Reject" },
        ],
        title: "Run this command?",
      },
    } as Request;
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render(surface(approval), dispatch, { reason: true });
    await typeAnswer("Run it once");
    await closeAndReopen();
    expect(document.querySelector("input")?.value).toBe("Run it once");
    await click("Send");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        response: { kind: "choice", optionId: "reject", text: "Run it once" },
      }),
    );
  });

  it("lets a secret go with the sheet it was typed into", async () => {
    await render(surface(question(true)), vi.fn());
    await typeAnswer("hunter2");
    await closeAndReopen();
    expect(document.querySelector("input")?.value).toBe("");
  });
});

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

function deviceAccessRequest(): Request {
  return {
    ...requestBase(),
    kind: "device.access",
    payload: {
      access: "apps",
      kind: "device.access",
      machineId: "rnr_00000000-0000-4000-8000-000000000001",
      machineName: "MacBook Pro (2)",
      reason: "Open Numbers to update the budget",
    },
    presentation: {
      detail: "Open Numbers to update the budget",
      kind: "external",
      subject: { id: "rnr_00000000-0000-4000-8000-000000000001", kind: "device.access" },
      title: "Let your agent use Apps on MacBook Pro (2)?",
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
    },
    presentation: {
      detail: "Move the plan into Notes",
      kind: "external",
      subject: { id: studioId, kind: "machine" },
      title: "Wants to use Notes on Studio",
    },
  } as unknown as Request;
}

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
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  } as const;
}

it.each(["live", "durable"] as const)(
  "answers an unassigned hidden worker’s %s Request projected onto Chat",
  async (mode) => {
    const { waitingQuestion } = await import("./docked-requests.js");
    const request = {
      ...requestBase(),
      kind: "harness.approval" as const,
      payload: { kind: "harness.approval" as const },
      mode,
      ...(mode === "durable"
        ? {
            kind: "integration.install" as const,
            payload: {
              kind: "integration.install" as const,
              reason: "Keep this source",
              manifest: mockTmdbProposal.manifest,
            },
          }
        : {}),
      presentation: {
        kind: "choice" as const,
        options: [{ id: "allow", hint: "allow-once" as const, label: "Allow once" }],
        risk: "medium" as const,
        title: "Read memory source?",
      },
    };
    const waiting = {
      assignments: [],
      subagent: null,
      presentation: {
        threadId: "chat",
        workerThread: { id: request.originatingThreadId, title: "Light memory worker" },
      },
      request,
    };
    const chatId = createId("thread");
    const question = waitingQuestion(
      [
        WaitingRequestSchema.parse({
          ...waiting,
          presentation: {
            ...waiting.presentation,
            threadId: chatId,
          },
        }),
      ],
      chatId,
      { id: UserIdSchema.parse(request.requestedBy) },
    );
    expect(question?.waiting?.presentation?.workerThread.title).toBe("Light memory worker");
    expect(question?.surface.request.originatingThreadId).toBe(request.originatingThreadId);
    const dispatch = vi.fn(async () => undefined);
    await render(question!.surface, dispatch);
    await click("Allow once");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond", requestId: request.id }),
    );
  },
);

vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
