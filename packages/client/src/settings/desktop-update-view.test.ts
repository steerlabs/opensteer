import { describe, expect, it } from "vitest";
import type {
  DesktopUpdateOperation,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "@opensteer/protocol/maintenance";
import { desktopUpdateView, type DesktopUpdateViewInput } from "./desktop-update-view.js";

const now = Date.parse("2026-11-04T12:00:00.000Z");
const state = (change: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  status: "idle",
  channel: "stable",
  latestVersion: null,
  currentVersion: "0.1.400",
  availableVersion: null,
  downloadPercent: null,
  failed: null,
  ...change,
});
const operation = (change: Partial<DesktopUpdateOperation> = {}): DesktopUpdateOperation => ({
  id: "6f4c7a5e-3c5f-4a5e-9a0e-2f5f7e3a1b00",
  intent: { action: "update" },
  state: "pending",
  fromVersion: "0.1.400",
  targetVersion: "0.1.401",
  incarnationId: null,
  detail: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  ...change,
});
const status = (change: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true,
  state: state(),
  operation: null,
  revision: "host:1",
  ...change,
});
const view = (change: Partial<DesktopUpdateViewInput> = {}) =>
  desktopUpdateView({
    computerName: "Studio Mac",
    status: status(),
    failure: null,
    requesting: false,
    stalled: false,
    now,
    ...change,
  });

describe("what a remote computer's updates offer", () => {
  it("offers the update and the other channel, and says what restarts before either", () => {
    const shown = view({
      status: status({ state: state({ status: "available", availableVersion: "0.1.401" }) }),
    });
    expect(shown.title).toBe("Opensteer on Studio Mac");
    expect(shown.versionLine).toBe("Version 0.1.400");
    expect(shown.channel).toBe("Stable");
    expect(shown.action).toMatchObject({
      label: "Update to 0.1.401",
      intent: { action: "update" },
    });
    expect(shown.channelAction).toMatchObject({
      label: "Switch to Beta",
      intent: { action: "channel", channel: "beta" },
    });
    for (const action of [shown.action, shown.channelAction]) {
      if (action?.kind !== "request") throw new Error("Expected a confirmed action.");
      expect(action.confirm.body).toContain("Opensteer on Studio Mac restarts");
      expect(action.confirm.body).toContain("Host and Runner");
      expect(action.confirm.body).toContain("interrupted and can resume");
    }
  });

  it("warns that switching to a Stable behind this version only saves the choice", () => {
    const action = view({ status: status({ state: state({ channel: "beta" }) }) }).channelAction;
    if (action?.kind !== "request") throw new Error("Expected a confirmed action.");
    expect(action.label).toBe("Switch to Stable");
    expect(action.confirm.body).toContain("updates resume when Stable catches up");
  });

  it.each([
    ["unavailable", null, null],
    ["checking", null, null],
    ["downloading", null, null],
    ["ahead", null, "Switch to Beta"],
    ["up-to-date", "Check for updates", "Switch to Beta"],
    ["error", "Try again", "Switch to Beta"],
    ["downloaded", "Update", null],
  ] as const)("%s offers %s and %s", (kind, action, channel) => {
    const shown = view({ status: status({ state: state({ status: kind }) }) });
    expect(shown.action?.label ?? null).toBe(action);
    expect(shown.channelAction?.label ?? null).toBe(channel);
  });

  it("offers nothing while the desktop app holds an update of its own", () => {
    const shown = view({
      status: status({ state: state({ status: "available", reservedBy: "local" }) }),
    });
    expect(shown.action).toBeNull();
    expect(shown.channelAction).toBeNull();
    expect(shown.detail).toContain("busy with an update");
  });
});

describe("a running update", () => {
  it.each([
    ["pending", "Starting…"],
    ["running", "Checking for updates…"],
    ["staged", "Downloading update… 42%"],
    ["installing", "Restarting…"],
  ] as const)("shows %s as %s with no actions", (phase, text) => {
    const shown = view({
      status: status({
        state: state({ status: "downloading", downloadPercent: 42 }),
        operation: operation({ state: phase }),
      }),
    });
    expect(shown.progress?.text).toBe(text);
    expect(shown.action).toBeNull();
    expect(shown.channelAction).toBeNull();
  });

  it.each(["offline", "unavailable", "unsupported", "invalid-response"] as const)(
    "treats %s during a nonterminal operation as the restart, not an error",
    (failure) => {
      const shown = view({
        failure,
        status: status({ operation: operation({ state: "staged" }) }),
      });
      expect(shown.progress?.text).toBe("Restarting…");
      expect(shown.headline).toBe("Updating to 0.1.401");
      expect(shown.action).toBeNull();
    },
  );

  it("shows Restarting while the Host is up but its desktop app has gone", () => {
    const shown = view({
      status: status({ state: null, operation: operation({ state: "installing" }) }),
    });
    expect(shown.progress?.text).toBe("Restarting…");
  });

  it("waits, rather than claims a restart, when nothing has started there", () => {
    const shown = view({ status: status({ state: null, operation: operation() }) });
    expect(shown.progress?.text).toBe("Waiting for Opensteer to open on Studio Mac…");
  });

  it("offers sign-in beside progress when an update outlives the session", () => {
    const result = view({
      status: status({ operation: operation({ state: "installing" }) }),
      failure: "unauthorized",
    });
    expect(result.progress?.text).toBe("Restarting…");
    expect(result.action).toEqual({ kind: "retry", label: "Sign in again" });
    expect(result.detail).toContain("Sign in to Studio Mac again");
  });

  it("says so when a restart has been silent far too long", () => {
    const shown = view({
      failure: "offline",
      stalled: true,
      status: status({ operation: operation({ state: "installing" }) }),
    });
    expect(shown.progress?.text).toBe("Restarting…");
    expect(shown.detail).toContain("taking longer than usual");
  });
});

describe("a finished update", () => {
  const finished = (change: Partial<DesktopUpdateOperation>, current = "0.1.400") =>
    view({
      status: status({
        state: state({ currentVersion: current }),
        operation: operation({ state: "succeeded", ...change }),
      }),
    }).result;

  it("names the version that actually started, not the one it aimed for", () => {
    expect(finished({}, "0.1.402")).toEqual({
      tone: "success",
      text: "Updated. Studio Mac is now running 0.1.402.",
    });
  });

  it("leads with the update it just finished, not an unchecked state", () => {
    const shown = view({ status: status({ operation: operation({ state: "succeeded" }) }) });
    expect(shown.headline).toBe("Updated");
  });

  it("says Stable is behind once, in the result", () => {
    const shown = view({
      status: status({
        state: state({ status: "ahead" }),
        operation: operation({
          state: "succeeded",
          detail: "ahead",
          intent: { action: "channel", channel: "stable" },
        }),
      }),
    });
    expect(shown.detail).toBeNull();
    expect(shown.result?.text).toContain("Updates resume");
  });

  it("names the switch alongside the version", () => {
    expect(finished({ intent: { action: "channel", channel: "beta" } }, "0.1.401")?.text).toBe(
      "Switched to Beta. Studio Mac is now running 0.1.401.",
    );
  });

  it("says Stable is saved and updates resume when Stable is behind", () => {
    expect(
      finished({ intent: { action: "channel", channel: "stable" }, detail: "ahead" }, "0.1.410"),
    ).toEqual({
      tone: "neutral",
      text: "Stable is saved. Studio Mac stays on 0.1.410 for now. Updates resume when Stable catches up.",
    });
  });

  it("says nothing restarted when there was nothing to install", () => {
    expect(finished({ detail: "up-to-date" })?.text).toBe("Studio Mac is already up to date.");
  });

  it.each([
    ["not-applied", "Studio Mac restarted but stayed on 0.1.400. The update didn't install."],
    [
      "handoff-failed",
      "Opensteer couldn't restart to install the update. Studio Mac is still on 0.1.400.",
    ],
    ["update-failed", "The update didn't finish. Studio Mac is still on 0.1.400."],
  ] as const)("explains %s", (detail, text) => {
    expect(finished({ state: "failed", detail })).toEqual({ tone: "attention", text });
  });

  it("lets an old result go", () => {
    const updatedAt = new Date(now - 25 * 60 * 60 * 1_000).toISOString();
    expect(finished({ state: "failed", detail: "not-applied", updatedAt })).toBeNull();
  });
});

describe("when the computer can't be updated from here", () => {
  it("hides for someone the Host refuses", () => {
    expect(view({ failure: "forbidden" }).hidden).toBe(true);
  });

  it("sends a server Deployment to that computer", () => {
    const shown = view({ status: status({ supported: false, state: null }) });
    expect(shown.detail).toBe(
      "Opensteer on Studio Mac can't be updated from here. Update it on that computer.",
    );
    expect(shown.action).toBeNull();
  });

  it("asks for one local update on a Host that predates the contract", () => {
    const shown = view({ status: null, failure: "unsupported" });
    expect(shown.detail).toContain("needs one update on that computer");
    expect(shown.action).toBeNull();
  });

  it("says Opensteer isn't running when the computer can't be reached", () => {
    const shown = view({ status: null, failure: "offline" });
    expect(shown.detail).toContain("Opensteer isn't running on Studio Mac");
    expect(shown.action).toMatchObject({ kind: "retry" });
  });

  it("says the same when the Host answers but its desktop app is closed", () => {
    const shown = view({ status: status({ state: null }) });
    expect(shown.detail).toContain("Opensteer isn't running on Studio Mac");
    expect(shown.action).toBeNull();
  });
});
