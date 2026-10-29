import { createId } from "@opensteer/core";
import {
  DesktopPersonalRemoteAccessStatusSchema,
  type DesktopPersonalRemoteAccessStatus,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  canIssuePersonalPairingCode,
  copyPairingValue,
  initialPersonalRemoteAccessEditorState,
  pairingHasExpired,
  reducePersonalRemoteAccessEditor,
  schedulePairingExpiry,
} from "./remote-access-editor.js";

describe("personal remote-access editor", () => {
  it("keeps a dirty draft while accepting newer server status and ignores stale status", () => {
    const initial = remoteStatus({
      generation: 4,
      mode: "private",
      phase: "ready",
      routeOrigin: "https://first.example.test",
    });
    const loaded = reducePersonalRemoteAccessEditor(initialPersonalRemoteAccessEditorState, {
      status: initial,
      type: "status-observed",
    });
    const edited = reducePersonalRemoteAccessEditor(loaded, {
      origin: "https://draft.example.test",
      type: "private-origin-edited",
    });
    const observed = reducePersonalRemoteAccessEditor(edited, {
      status: remoteStatus({
        generation: 5,
        mode: "private",
        phase: "offline",
        routeOrigin: "https://new.example.test",
      }),
      type: "status-observed",
    });
    const stale = reducePersonalRemoteAccessEditor(observed, {
      status: initial,
      type: "status-observed",
    });

    expect(observed.status?.generation).toBe(5);
    expect(observed.draft).toEqual({
      dirty: true,
      privateOrigin: "https://draft.example.test",
      selectedMode: "private",
    });
    expect(stale).toBe(observed);
  });

  it("lets a newer event win a deferred initial load and resets only on acknowledged apply", () => {
    const event = reducePersonalRemoteAccessEditor(initialPersonalRemoteAccessEditorState, {
      status: remoteStatus({ generation: 9, mode: "connect", phase: "ready" }),
      type: "status-observed",
    });
    const deferredLoad = reducePersonalRemoteAccessEditor(event, {
      status: remoteStatus({ generation: 8, mode: "off", phase: "off" }),
      type: "status-observed",
    });
    const edited = reducePersonalRemoteAccessEditor(deferredLoad, {
      mode: "off",
      type: "mode-edited",
    });
    const sameGenerationEvent = reducePersonalRemoteAccessEditor(edited, {
      status: remoteStatus({ generation: 9, mode: "connect", phase: "offline" }),
      type: "status-observed",
    });
    const acknowledged = reducePersonalRemoteAccessEditor(sameGenerationEvent, {
      status: remoteStatus({ generation: 10, mode: "off", phase: "off" }),
      type: "apply-acknowledged",
    });

    expect(deferredLoad).toBe(event);
    expect(sameGenerationEvent.draft.selectedMode).toBe("off");
    expect(sameGenerationEvent.draft.dirty).toBe(true);
    expect(acknowledged.draft).toEqual({
      dirty: false,
      privateOrigin: "",
      selectedMode: "off",
    });
  });

  it("acknowledges an apply without regressing status when its response arrives late", () => {
    const initial = reducePersonalRemoteAccessEditor(initialPersonalRemoteAccessEditorState, {
      status: remoteStatus({ generation: 10, mode: "off", phase: "off" }),
      type: "status-observed",
    });
    const edited = reducePersonalRemoteAccessEditor(initial, {
      mode: "connect",
      type: "mode-edited",
    });
    const completedEvent = reducePersonalRemoteAccessEditor(edited, {
      status: remoteStatus({ generation: 12, mode: "connect", phase: "ready" }),
      type: "status-observed",
    });
    const lateAcknowledgement = reducePersonalRemoteAccessEditor(completedEvent, {
      status: remoteStatus({ generation: 11, mode: "off", phase: "linking-account" }),
      type: "apply-acknowledged",
    });

    expect(lateAcknowledgement.status).toBe(completedEvent.status);
    expect(lateAcknowledgement.draft).toEqual({
      dirty: false,
      privateOrigin: "",
      selectedMode: "connect",
    });
  });

  it("does not acknowledge a stale apply after a newer conflicting mode wins", () => {
    const initial = reducePersonalRemoteAccessEditor(initialPersonalRemoteAccessEditorState, {
      status: remoteStatus({ generation: 10, mode: "off", phase: "off" }),
      type: "status-observed",
    });
    const edited = reducePersonalRemoteAccessEditor(initial, {
      mode: "connect",
      type: "mode-edited",
    });
    const conflictingEvent = reducePersonalRemoteAccessEditor(edited, {
      status: remoteStatus({ generation: 12, mode: "off", phase: "off" }),
      type: "status-observed",
    });
    const staleAcknowledgement = reducePersonalRemoteAccessEditor(conflictingEvent, {
      status: remoteStatus({ generation: 11, mode: "connect", phase: "ready" }),
      type: "apply-acknowledged",
    });

    expect(staleAcknowledgement).toBe(conflictingEvent);
    expect(staleAcknowledgement.draft.dirty).toBe(true);
  });

  it("keeps a matching draft retryable when a newer status reports an error", () => {
    const initial = reducePersonalRemoteAccessEditor(initialPersonalRemoteAccessEditorState, {
      status: remoteStatus({ generation: 20, mode: "off", phase: "off" }),
      type: "status-observed",
    });
    const edited = reducePersonalRemoteAccessEditor(initial, {
      mode: "connect",
      type: "mode-edited",
    });
    const failedEvent = reducePersonalRemoteAccessEditor(edited, {
      status: remoteStatus({ generation: 22, mode: "connect", phase: "error", retryable: true }),
      type: "status-observed",
    });
    const staleAcknowledgement = reducePersonalRemoteAccessEditor(failedEvent, {
      status: remoteStatus({ generation: 21, mode: "connect", phase: "provisioning" }),
      type: "apply-acknowledged",
    });

    expect(staleAcknowledgement).toBe(failedEvent);
    expect(staleAcknowledgement.draft.dirty).toBe(true);
  });
});

describe("pairing codes", () => {
  it("never offers a pairing code for Opensteer Connect", () => {
    // Connect authorizes a device through your Account; a one-use code would
    // be a second, weaker way in.
    expect(canIssuePersonalPairingCode(remoteStatus({ mode: "connect", phase: "ready" }))).toBe(
      false,
    );
    expect(
      canIssuePersonalPairingCode(
        remoteStatus({ mode: "private", phase: "ready", routeOrigin: "https://host.example.test" }),
      ),
    ).toBe(true);
    expect(canIssuePersonalPairingCode(null)).toBe(false);
  });

  it("expires pairing state at its exact expiry and supports explicit clipboard actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T22:29:59.000Z"));
    const expired = vi.fn();
    const cancel = schedulePairingExpiry("2026-08-12T22:30:00.000Z", expired);
    const clipboard = { writeText: vi.fn(async () => undefined) };

    await copyPairingValue("https://host.example.test", clipboard);
    expect(clipboard.writeText).toHaveBeenCalledWith("https://host.example.test");
    expect(pairingHasExpired("2026-08-12T22:30:00.000Z")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expired).toHaveBeenCalledOnce();
    expect(pairingHasExpired("2026-08-12T22:30:00.000Z")).toBe(true);

    cancel();
    vi.useRealTimers();
  });

  it("reports unavailable clipboard access instead of claiming success", async () => {
    await expect(copyPairingValue("secret", null)).rejects.toThrow(
      "Clipboard access is unavailable",
    );
  });
});

function remoteStatus(
  overrides: Partial<DesktopPersonalRemoteAccessStatus> = {},
): DesktopPersonalRemoteAccessStatus {
  return DesktopPersonalRemoteAccessStatusSchema.parse({
    deploymentId: createId("deployment"),
    detail: null,
    generation: 2,
    mode: "off",
    phase: "off",
    retryable: false,
    routeOrigin: null,
    schemaVersion: 1,
    ...overrides,
  });
}
