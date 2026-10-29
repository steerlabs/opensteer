import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceActivityService } from "./workspace-activity.js";

describe("WorkspaceActivityService", () => {
  it("writes at most once per Workspace every five minutes", async () => {
    const workspaceId = createId("workspace");
    const noteWorkspaceActivity = vi.fn(async () => undefined);
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const activity = new WorkspaceActivityService({
      now: () => now,
      store: { noteWorkspaceActivity },
    });

    activity.note(workspaceId);
    activity.note(workspaceId);
    await vi.waitFor(() => expect(noteWorkspaceActivity).toHaveBeenCalledOnce());
    now += 5 * 60_000;
    activity.note(workspaceId);
    await vi.waitFor(() => expect(noteWorkspaceActivity).toHaveBeenCalledTimes(2));
  });

  it("swallows write and debug logger failures", async () => {
    const onError = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const activity = new WorkspaceActivityService({
      onError,
      store: { noteWorkspaceActivity: vi.fn(async () => Promise.reject(new Error("db down"))) },
    });

    expect(() => activity.note(createId("workspace"))).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it("retries on the next demand after a failed write instead of waiting out the interval", async () => {
    const workspaceId = createId("workspace");
    const noteWorkspaceActivity = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const activity = new WorkspaceActivityService({
      now: () => now,
      onError,
      store: { noteWorkspaceActivity },
    });

    activity.note(workspaceId);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    activity.note(workspaceId);
    await vi.waitFor(() => expect(noteWorkspaceActivity).toHaveBeenCalledTimes(2));
    activity.note(workspaceId);
    expect(noteWorkspaceActivity).toHaveBeenCalledTimes(2);
  });
});
