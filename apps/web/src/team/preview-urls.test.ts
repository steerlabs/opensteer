import { describe, expect, it, vi } from "vitest";
import { TeamPreviewUrls } from "./preview-urls.js";

describe("team preview URL lifetime", () => {
  it("revokes every loaded preview on channel exit and fences late reads", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:one")
      .mockReturnValueOnce("blob:two");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = new TeamPreviewUrls(),
      late = Promise.withResolvers<Blob>();
    await store.load("1", async () => new Blob(["one"]));
    await store.load("2", async () => new Blob(["two"]));
    const pending = store.load("3", () => late.promise);
    store.clear();
    expect(revoke.mock.calls).toEqual([["blob:one"], ["blob:two"]]);
    late.resolve(new Blob(["late"]));
    await pending;
    expect(create).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().size).toBe(0);
    store.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
