import type { ScreenSurface } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { PlaceItem } from "../host/places.js";
import type { WorkspaceSurfaceDestination } from "../host/surfaces.js";
import { listedScreenSurface, preparedPresentation } from "./platform.js";

const machineId = "run_12345678-1234-4123-8123-123456789abc";
const place = (key: string, destination: WorkspaceSurfaceDestination) =>
  ({ key, destination }) as unknown as PlaceItem;
const places = [
  place("browser", { kind: "browser", sessionId: "bsn_1", tabId: "tab:1" }),
  place("task-app", {
    kind: "app",
    machineId,
    appKey: "com.apple.Notes",
    computerSessionId: "cs_1",
    source: { kind: "task-session", sessionId: "cs_1" },
  }),
  place("owner-app", {
    kind: "app",
    machineId,
    appKey: "com.apple.Notes",
    windowId: 7,
    source: { kind: "owner-view", viewId: "cv_1", generation: 3 },
  }),
  place("legacy-phone", { kind: "phone", machineId, computerSessionId: "cs_2" }),
  place("owner-phone", {
    kind: "phone",
    machineId,
    display: "main",
    source: { kind: "owner-view", viewId: "cv_2", generation: 1 },
  }),
];
const ownerApp = (viewId: string, generation: number, windowId: number) => ({
  kind: "app",
  machineId,
  appKey: "com.apple.Notes",
  source: { kind: "owner-view", viewId, generation, windowId },
});

describe("listedScreenSurface", () => {
  it("finds exactly the named tab, task session or view", () => {
    // Identifiers here are fixtures, not parsed values.
    const found = (surface: object) =>
      listedScreenSurface(places, surface as ScreenSurface)?.key ?? null;
    expect(found({ kind: "browser", sessionId: "bsn_1", tabId: "tab:1" })).toBe("browser");
    expect(
      found({
        kind: "app",
        machineId,
        appKey: "com.apple.Notes",
        source: { kind: "task-session", sessionId: "cs_1" },
      }),
    ).toBe("task-app");
    expect(found(ownerApp("cv_1", 3, 7))).toBe("owner-app");
    expect(
      found({
        kind: "phone",
        machineId,
        display: "main",
        source: { kind: "task-session", sessionId: "cs_2" },
      }),
    ).toBe("legacy-phone");
    expect(
      found({
        kind: "phone",
        machineId,
        display: "main",
        source: { kind: "owner-view", viewId: "cv_2", generation: 1 },
      }),
    ).toBe("owner-phone");
  });

  it("never substitutes a stale view, another window, another session or a same-named app", () => {
    // Identifiers here are fixtures, not parsed values.
    const found = (surface: object) => listedScreenSurface(places, surface as ScreenSurface);
    expect(found(ownerApp("cv_1", 2, 7))).toBeNull();
    expect(found(ownerApp("cv_1", 3, 8))).toBeNull();
    expect(found({ kind: "browser", sessionId: "bsn_1", tabId: "tab:2" })).toBeNull();
    expect(
      found({
        kind: "app",
        machineId,
        appKey: "com.apple.Notes",
        source: { kind: "task-session", sessionId: "cs_9" },
      }),
    ).toBeNull();
    expect(
      found({
        kind: "app",
        machineId,
        appKey: "com.apple.Notes",
        source: { kind: "task-session", sessionId: "cv_1" },
      }),
    ).toBeNull();
    expect(
      found({
        kind: "phone",
        machineId,
        display: "second",
        source: { kind: "task-session", sessionId: "cs_2" },
      }),
    ).toBeNull();
  });
});

describe("preparedPresentation", () => {
  const guard = (receipt: ReturnType<() => null | { outcome: "superseded" }> = null) => ({
    operationId: "op",
    check: () => receipt,
  });

  it("commits once after the guard and the fresh target both pass", async () => {
    const commit = vi.fn(async () => ({ outcome: "applied" as const }));
    const prepared = preparedPresentation({
      signal: new AbortController().signal,
      refusal: () => null,
      commit,
    });
    expect(prepared.commitIfCurrent(guard())).toBe("committed");
    expect(prepared.commitIfCurrent(guard())).toBe("committed");
    expect(commit).toHaveBeenCalledOnce();
    await expect(prepared.confirmation).resolves.toEqual({ outcome: "applied" });
  });

  it("refuses without changing the route when the guard or the target fails", async () => {
    const commit = vi.fn(async () => ({ outcome: "applied" as const }));
    const stale = preparedPresentation({
      signal: new AbortController().signal,
      refusal: () => null,
      commit,
    });
    expect(stale.commitIfCurrent(guard({ outcome: "superseded" }))).toEqual({
      outcome: "superseded",
    });
    const closed = preparedPresentation({
      signal: new AbortController().signal,
      refusal: () => ({ outcome: "unavailable", reason: "closed" }),
      commit,
    });
    expect(closed.commitIfCurrent(guard())).toEqual({ outcome: "unavailable", reason: "closed" });
    expect(commit).not.toHaveBeenCalled();
    await expect(stale.confirmation).resolves.toEqual({ outcome: "superseded" });
    await expect(closed.confirmation).resolves.toEqual({
      outcome: "unavailable",
      reason: "closed",
    });
  });

  it("settles every confirmation when aborted or disposed, before or after the commit", async () => {
    const abort = new AbortController();
    const commit = vi.fn(() => new Promise<never>(() => {}));
    const aborted = preparedPresentation({ signal: abort.signal, refusal: () => null, commit });
    abort.abort();
    expect(aborted.commitIfCurrent(guard())).toEqual({ outcome: "superseded" });
    await expect(aborted.confirmation).resolves.toEqual({ outcome: "superseded" });

    let platformSignal: AbortSignal | null = null;
    const waiting = preparedPresentation({
      signal: new AbortController().signal,
      refusal: () => null,
      commit: (signal) => {
        platformSignal = signal;
        return new Promise<never>(() => {});
      },
    });
    expect(waiting.commitIfCurrent(guard())).toBe("committed");
    waiting.dispose();
    await expect(waiting.confirmation).resolves.toEqual({ outcome: "unconfirmed" });
    expect(platformSignal!.aborted).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });
});
